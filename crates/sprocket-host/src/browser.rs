use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, bail};
use serde::Serialize;
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

enum DashboardState {
    Stopped,
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
            Self::Stopped | Self::Installing => BrowserStatus {
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

pub struct BrowserManager {
    installer: BrowserInstaller,
    dashboard: Mutex<DashboardState>,
    dashboard_client: reqwest::Client,
    shutdown: WorkspaceCancellation,
}

impl BrowserManager {
    pub fn new(data_dir: PathBuf) -> anyhow::Result<Arc<Self>> {
        Ok(Arc::new(Self {
            installer: BrowserInstaller::new(&data_dir)?,
            dashboard: Mutex::new(DashboardState::Stopped),
            dashboard_client: reqwest::Client::builder()
                .no_proxy()
                .retry(reqwest::retry::never())
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(5))
                .build()?,
            shutdown: WorkspaceCancellation::new(),
        }))
    }

    pub fn dashboard_client(&self) -> &reqwest::Client {
        &self.dashboard_client
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

    pub async fn status(&self) -> BrowserStatus {
        self.dashboard.lock().await.status()
    }

    pub async fn start(self: &Arc<Self>) -> BrowserStatus {
        if self.shutdown.is_cancelled() {
            return BrowserStatus {
                state: "error",
                error: Some("Sprocket is shutting down".into()),
            };
        }
        let mut dashboard = self.dashboard.lock().await;
        let status = dashboard.status();
        if !matches!(
            *dashboard,
            DashboardState::Stopped | DashboardState::Error(_)
        ) {
            return status;
        }
        *dashboard = DashboardState::Installing;
        drop(dashboard);
        let manager = Arc::clone(self);
        tokio::spawn(async move {
            let result = tokio::select! {
                result = manager.launch_dashboard() => result,
                _ = manager.shutdown.cancelled() => return,
            };
            *manager.dashboard.lock().await = match result {
                Ok(dashboard) => DashboardState::Ready(dashboard),
                Err(error) => DashboardState::Error(format!("{error:#}")),
            };
        });
        DashboardState::Installing.status()
    }

    async fn launch_dashboard(&self) -> anyhow::Result<Dashboard> {
        let cli = self.installer.ensure_ready().await?;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let port = listener.local_addr()?.port();
        drop(listener);
        let mut command = Command::new(cli);
        command
            .envs(self.environment()?)
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
        for _ in 0..50 {
            if let Some(status) = child.try_wait()? {
                let _ = tokio::time::timeout(Duration::from_secs(1), drain).await;
                bail!(
                    "agent-browser dashboard exited: {status}: {}",
                    String::from_utf8_lossy(&errors.lock().await[..])
                );
            }
            if self
                .dashboard_client
                .get(format!("http://127.0.0.1:{port}/"))
                .timeout(Duration::from_secs(1))
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

    pub async fn port(&self) -> anyhow::Result<u16> {
        let mut dashboard = self.dashboard.lock().await;
        dashboard.status();
        if let DashboardState::Ready(dashboard) = &*dashboard {
            return Ok(dashboard.port);
        }
        bail!("Browser dashboard is not ready. Retry setup.")
    }

    pub fn environment(&self) -> anyhow::Result<Vec<(OsString, OsString)>> {
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
        ])
    }

    pub async fn shutdown(&self) {
        self.shutdown.cancel();
        let state = std::mem::replace(&mut *self.dashboard.lock().await, DashboardState::Stopped);
        if let DashboardState::Ready(mut dashboard) = state {
            let _ = dashboard.child.kill().await;
        }
    }

    #[cfg(all(any(test, feature = "test-support"), unix))]
    pub async fn use_test_dashboard(&self, port: u16) {
        let child = Command::new("sh")
            .args(["-c", "sleep 60"])
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        *self.dashboard.lock().await = DashboardState::Ready(Dashboard { child, port });
    }
}

#[cfg(all(test, unix))]
mod tests;
