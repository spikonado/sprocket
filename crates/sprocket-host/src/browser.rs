use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, bail};
use futures::StreamExt;
use futures::stream::BoxStream;
use serde::Serialize;
use sprocket_workspace::WorkspaceCancellation;
use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, watch};
use tokio::task::JoinHandle;

use crate::browser_install::{AGENT_BROWSER_USE_SYSTEM_CA, BrowserInstaller};
use crate::tool_install::prepend_path;

const DASHBOARD_STOPPED: &str = "The browser dashboard stopped. Retry setup to restart it.";

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
    Ready { port: u16 },
    Error(String),
}

impl From<&DashboardState> for BrowserStatus {
    fn from(state: &DashboardState) -> Self {
        match state {
            DashboardState::Stopped | DashboardState::Installing => Self {
                state: "installing",
                error: None,
            },
            DashboardState::Ready { .. } => Self {
                state: "ready",
                error: None,
            },
            DashboardState::Error(error) => Self {
                state: "error",
                error: Some(error.clone()),
            },
        }
    }
}

pub struct BrowserManager {
    installer: BrowserInstaller,
    state: watch::Sender<DashboardState>,
    /// The task that owns the running dashboard child.
    supervisor: std::sync::Mutex<Option<JoinHandle<()>>>,
    dashboard_client: reqwest::Client,
    shutdown: WorkspaceCancellation,
}

impl BrowserManager {
    pub fn new(data_dir: PathBuf) -> anyhow::Result<Arc<Self>> {
        Ok(Arc::new(Self {
            installer: BrowserInstaller::new(&data_dir)?,
            state: watch::Sender::new(DashboardState::Stopped),
            supervisor: std::sync::Mutex::new(None),
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

    /// The current status, then each change.
    pub fn status_events(&self) -> BoxStream<'static, BrowserStatus> {
        let mut receiver = self.state.subscribe();
        receiver.mark_changed();
        futures::stream::unfold(receiver, |mut receiver| async move {
            receiver.changed().await.ok()?;
            let status = BrowserStatus::from(&*receiver.borrow_and_update());
            Some((status, receiver))
        })
        .boxed()
    }

    pub fn start(self: &Arc<Self>) -> BrowserStatus {
        if self.shutdown.is_cancelled() {
            return BrowserStatus {
                state: "error",
                error: Some("Sprocket is shutting down".into()),
            };
        }
        let launch = self.state.send_if_modified(|state| {
            let idle = matches!(state, DashboardState::Stopped | DashboardState::Error(_));
            if idle {
                *state = DashboardState::Installing;
            }
            idle
        });
        if launch {
            let manager = Arc::clone(self);
            tokio::spawn(async move {
                let result = tokio::select! {
                    result = manager.launch_dashboard() => result,
                    _ = manager.shutdown.cancelled() => return,
                };
                match result {
                    Ok(dashboard) => manager.supervise(dashboard),
                    Err(error) => manager.replace_state(
                        |state| matches!(state, DashboardState::Installing),
                        DashboardState::Error(format!("{error:#}")),
                    ),
                }
            });
        }
        BrowserStatus::from(&*self.state.borrow())
    }

    /// `shutdown` resets the state to `Stopped`, so a late update from a task it outlived is dropped.
    fn replace_state(&self, expected: impl FnOnce(&DashboardState) -> bool, next: DashboardState) {
        self.state.send_if_modified(|state| {
            let replace = expected(state);
            if replace {
                *state = next;
            }
            replace
        });
    }

    /// Marks the dashboard ready and flips it to an error as soon as its process exits.
    fn supervise(self: &Arc<Self>, dashboard: Dashboard) {
        let Dashboard { mut child, port } = dashboard;
        let mut supervisor = self.supervisor.lock().expect("browser supervisor lock");
        // Holding the lock orders this against `shutdown`, which cancels before taking it.
        if self.shutdown.is_cancelled() {
            return;
        }
        self.state.send_replace(DashboardState::Ready { port });
        let manager = Arc::clone(self);
        let task = tokio::spawn(async move {
            let exited = tokio::select! {
                _ = child.wait() => true,
                _ = manager.shutdown.cancelled() => false,
            };
            if exited {
                manager.replace_state(
                    |state| matches!(state, DashboardState::Ready { port: current } if *current == port),
                    DashboardState::Error(DASHBOARD_STOPPED.into()),
                );
            } else {
                let _ = child.kill().await;
            }
        });
        if let Some(previous) = supervisor.replace(task) {
            previous.abort();
        }
    }

    async fn launch_dashboard(&self) -> anyhow::Result<Dashboard> {
        let cli = self.installer.ensure_ready().await?;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let port = listener.local_addr()?.port();
        drop(listener);
        let mut command = Command::new(cli);
        command
            .envs(self.environment())
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

    pub fn port(&self) -> anyhow::Result<u16> {
        if let DashboardState::Ready { port } = *self.state.borrow() {
            return Ok(port);
        }
        bail!("Browser dashboard is not ready. Retry setup.")
    }

    pub fn environment(&self) -> Vec<(OsString, OsString)> {
        prepend_path(
            vec![
                (
                    "AGENT_BROWSER_SKILLS_DIR".into(),
                    self.installer.skills_directory().into_os_string(),
                ),
                (AGENT_BROWSER_USE_SYSTEM_CA.into(), "1".into()),
            ],
            [self.installer.bin_dir()],
        )
    }

    pub async fn shutdown(&self) {
        self.shutdown.cancel();
        let supervisor = self
            .supervisor
            .lock()
            .expect("browser supervisor lock")
            .take();
        self.state.send_replace(DashboardState::Stopped);
        if let Some(supervisor) = supervisor {
            let _ = supervisor.await;
        }
    }

    #[cfg(all(any(test, feature = "test-support"), unix))]
    pub fn use_test_dashboard(self: &Arc<Self>, port: u16) {
        let child = Command::new("sh")
            .args(["-c", "sleep 60"])
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        self.supervise(Dashboard { child, port });
    }
}

#[cfg(all(test, unix))]
mod tests;
