use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use anyhow::{Context, bail};
use serde::Serialize;
use sha2::{Digest, Sha256};
use sprocket_workspace::WorkspaceCancellation;
use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use crate::browser_install::BrowserInstaller;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserStatus {
    pub state: &'static str,
    pub error: Option<String>,
}

struct Dashboard {
    child: Child,
    port: u16,
}

impl Dashboard {
    async fn stop(mut self) {
        let _ = self.child.kill().await;
        let _ = self.child.wait().await;
    }
}

enum DashboardState {
    Installing,
    Ready(Dashboard),
    Error(String),
}

impl DashboardState {
    fn status(&mut self) -> BrowserStatus {
        if let Self::Ready(dashboard) = self
            && !matches!(dashboard.child.try_wait(), Ok(None))
        {
            *self = Self::Error("The browser dashboard stopped. Retry setup to restart it.".into());
        }
        match self {
            Self::Installing => BrowserStatus {
                state: "installing",
                error: None,
            },
            Self::Ready(_) => BrowserStatus {
                state: "ready",
                error: None,
            },
            Self::Error(error) => BrowserStatus {
                state: "error",
                error: Some(error.clone()),
            },
        }
    }
}

/// Only the signed-in user can reach the dashboard, so one slot suffices.
struct ActiveDashboard {
    user_id: String,
    attempt: u64,
    state: DashboardState,
}

fn owned_by<'a>(
    active: &'a mut Option<ActiveDashboard>,
    user_id: &str,
) -> Option<&'a mut DashboardState> {
    active
        .as_mut()
        .filter(|active| active.user_id == user_id)
        .map(|active| &mut active.state)
}

pub struct BrowserManager {
    installer: BrowserInstaller,
    data_dir: PathBuf,
    active: Mutex<Option<ActiveDashboard>>,
    attempts: AtomicU64,
    shutdown: WorkspaceCancellation,
}

impl BrowserManager {
    pub fn new(data_dir: PathBuf) -> anyhow::Result<Arc<Self>> {
        Ok(Arc::new(Self {
            installer: BrowserInstaller::new(&data_dir)?,
            data_dir,
            active: Mutex::new(None),
            attempts: AtomicU64::new(0),
            shutdown: WorkspaceCancellation::new(),
        }))
    }

    pub fn prepare_tools(self: &Arc<Self>) {
        let manager = Arc::clone(self);
        tokio::spawn(async move {
            tokio::select! {
                result = manager.installer.ensure_ready() => {
                    if let Err(error) = result {
                        tracing::warn!("agent-browser setup failed: {error:#}");
                    }
                }
                _ = manager.shutdown.cancelled() => {}
            }
        });
    }

    pub async fn status(&self, user_id: &str) -> BrowserStatus {
        let mut active = self.active.lock().await;
        match owned_by(&mut active, user_id) {
            Some(state) => state.status(),
            None => DashboardState::Installing.status(),
        }
    }

    pub async fn start(self: &Arc<Self>, user_id: &str) -> BrowserStatus {
        if self.shutdown.is_cancelled() {
            return BrowserStatus {
                state: "error",
                error: Some("Sprocket is shutting down".into()),
            };
        }
        let mut active = self.active.lock().await;
        if let Some(state) = owned_by(&mut active, user_id) {
            let status = state.status();
            if !matches!(state, DashboardState::Error(_)) {
                return status;
            }
        }
        let attempt = self.attempts.fetch_add(1, Ordering::Relaxed);
        let previous = active.replace(ActiveDashboard {
            user_id: user_id.to_owned(),
            attempt,
            state: DashboardState::Installing,
        });
        drop(active);
        if let Some(ActiveDashboard {
            state: DashboardState::Ready(dashboard),
            ..
        }) = previous
        {
            dashboard.stop().await;
        }
        let manager = Arc::clone(self);
        let user_id = user_id.to_owned();
        tokio::spawn(async move {
            let result = tokio::select! {
                result = manager.launch_dashboard(&user_id) => result,
                _ = manager.shutdown.cancelled() => return,
            };
            let mut active = manager.active.lock().await;
            // A replaced attempt's dashboard is killed on drop.
            if let Some(active) = active.as_mut().filter(|active| active.attempt == attempt) {
                active.state = match result {
                    Ok(dashboard) => DashboardState::Ready(dashboard),
                    Err(error) => DashboardState::Error(format!("{error:#}")),
                };
            }
        });
        DashboardState::Installing.status()
    }

    async fn launch_dashboard(&self, user_id: &str) -> anyhow::Result<Dashboard> {
        let cli = self.installer.ensure_ready().await?;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let port = listener.local_addr()?.port();
        drop(listener);
        let mut command = Command::new(cli);
        command
            .envs(self.environment(user_id)?)
            .env("AGENT_BROWSER_DASHBOARD", "1")
            .env("AGENT_BROWSER_DASHBOARD_PORT", port.to_string())
            .env_remove("AGENT_BROWSER_DASHBOARD_ALLOWED_ORIGINS")
            .env_remove("AGENT_BROWSER_DASHBOARD_ACCESS_TOKEN")
            .env_remove("AI_GATEWAY_API_KEY")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        let mut child = command.spawn().context("start agent-browser dashboard")?;
        let mut stderr = child.stderr.take().context("dashboard stderr")?;
        let errors = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&errors);
        let drain = tokio::spawn(async move {
            let mut chunk = [0; 4096];
            while let Ok(read) = stderr.read(&mut chunk).await {
                if read == 0 {
                    break;
                }
                let mut errors = captured.lock().await;
                let retained = read.min(8192usize.saturating_sub(errors.len()));
                errors.extend_from_slice(&chunk[..retained]);
            }
        });
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(1))
            .build()?;
        for _ in 0..50 {
            if let Some(status) = child.try_wait()? {
                let _ = tokio::time::timeout(Duration::from_secs(1), drain).await;
                bail!(
                    "agent-browser dashboard exited: {status}: {}",
                    String::from_utf8_lossy(&errors.lock().await[..])
                );
            }
            if client
                .get(format!("http://127.0.0.1:{port}/"))
                .send()
                .await
                .is_ok_and(|response| response.status().is_success())
            {
                return Ok(Dashboard { child, port });
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        bail!(
            "agent-browser dashboard did not become ready: {}",
            String::from_utf8_lossy(&errors.lock().await[..])
        );
    }

    pub async fn port(&self, user_id: &str) -> anyhow::Result<u16> {
        let mut active = self.active.lock().await;
        if let Some(state) = owned_by(&mut active, user_id) {
            state.status();
            if let DashboardState::Ready(dashboard) = state {
                return Ok(dashboard.port);
            }
        }
        bail!("Browser dashboard is not ready. Retry setup.")
    }

    pub fn environment(&self, user_id: &str) -> anyhow::Result<Vec<(OsString, OsString)>> {
        let mut paths = vec![self.installer.cli_directory()?];
        if let Some(path) = std::env::var_os("PATH") {
            paths.extend(std::env::split_paths(&path));
        }
        Ok(vec![
            ("PATH".into(), std::env::join_paths(paths)?),
            (
                "AGENT_BROWSER_SKILLS_DIR".into(),
                self.installer.skills_directory().into_os_string(),
            ),
            (
                "AGENT_BROWSER_NAMESPACE".into(),
                namespace(&self.data_dir, user_id).into(),
            ),
        ])
    }

    pub async fn shutdown(&self) {
        self.shutdown.cancel();
        let active = self.active.lock().await.take();
        if let Some(ActiveDashboard {
            state: DashboardState::Ready(dashboard),
            ..
        }) = active
        {
            dashboard.stop().await;
        }
    }

    #[cfg(all(any(test, feature = "test-support"), unix))]
    pub async fn use_test_dashboard(&self, user_id: &str, port: u16) {
        let child = Command::new("sh")
            .args(["-c", "sleep 60"])
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        *self.active.lock().await = Some(ActiveDashboard {
            user_id: user_id.into(),
            attempt: self.attempts.fetch_add(1, Ordering::Relaxed),
            state: DashboardState::Ready(Dashboard { child, port }),
        });
    }
}

fn namespace(data_dir: &std::path::Path, user_id: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(data_dir.as_os_str().as_encoded_bytes());
    hash.update([0]);
    hash.update(user_id.as_bytes());
    hex::encode(&hash.finalize()[..8])
}

#[cfg(all(test, unix))]
mod tests;
