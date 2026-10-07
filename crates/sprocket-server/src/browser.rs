use std::collections::HashMap;
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, bail};
use serde::Serialize;
use sha2::{Digest, Sha256};
use sprocket_workspace::WorkspaceCancellation;
use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use crate::browser_install::BrowserInstaller;

pub(crate) const DASHBOARD_PATH: &str = "/api/browser/dashboard/";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserStatus {
    pub state: &'static str,
    pub error: Option<String>,
}

struct Dashboard {
    child: Child,
    port: u16,
}

enum UserBrowser {
    Installing,
    Ready(Dashboard),
    Error(String),
}

impl UserBrowser {
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

pub(crate) struct BrowserManager {
    installer: BrowserInstaller,
    data_dir: PathBuf,
    users: Mutex<HashMap<String, UserBrowser>>,
    shutdown: WorkspaceCancellation,
}

impl BrowserManager {
    pub fn new(data_dir: PathBuf) -> anyhow::Result<Arc<Self>> {
        Ok(Arc::new(Self {
            installer: BrowserInstaller::new(
                data_dir.clone(),
                std::env::var_os("AGENT_BROWSER_EXECUTABLE_PATH")
                    .filter(|value| !value.is_empty())
                    .map(PathBuf::from),
            )?,
            data_dir,
            users: Mutex::new(HashMap::new()),
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

    pub async fn install_lightpanda(&self) -> anyhow::Result<PathBuf> {
        self.installer.ensure_lightpanda().await
    }

    pub async fn status(&self, user_id: &str) -> BrowserStatus {
        let mut users = self.users.lock().await;
        match users.get_mut(user_id) {
            Some(browser) => browser.status(),
            None => UserBrowser::Installing.status(),
        }
    }

    pub async fn start(self: &Arc<Self>, user_id: &str) -> BrowserStatus {
        if self.shutdown.is_cancelled() {
            return BrowserStatus {
                state: "error",
                error: Some("Sprocket is shutting down".into()),
            };
        }
        let mut users = self.users.lock().await;
        if let Some(browser) = users.get_mut(user_id) {
            let status = browser.status();
            if !matches!(browser, UserBrowser::Error(_)) {
                return status;
            }
        }
        users.insert(user_id.to_owned(), UserBrowser::Installing);
        let manager = Arc::clone(self);
        let user_id = user_id.to_owned();
        tokio::spawn(async move {
            let result = tokio::select! {
                result = manager.launch_dashboard(&user_id) => result,
                _ = manager.shutdown.cancelled() => return,
            };
            let mut users = manager.users.lock().await;
            let Some(browser) = users.get_mut(&user_id) else {
                return;
            };
            *browser = match result {
                Ok(dashboard) => UserBrowser::Ready(dashboard),
                Err(error) => UserBrowser::Error(format!("{error:#}")),
            };
        });
        UserBrowser::Installing.status()
    }

    async fn launch_dashboard(&self, user_id: &str) -> anyhow::Result<Dashboard> {
        let installed = self.installer.ensure_ready().await?;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let port = listener.local_addr()?.port();
        drop(listener);
        let mut command = Command::new(&installed.cli);
        command
            .envs(self.environment(user_id).await?)
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
        let mut users = self.users.lock().await;
        if let Some(browser) = users.get_mut(user_id) {
            browser.status();
            if let UserBrowser::Ready(dashboard) = browser {
                return Ok(dashboard.port);
            }
        }
        bail!("Browser dashboard is not ready. Retry setup.")
    }

    pub async fn environment(&self, user_id: &str) -> anyhow::Result<Vec<(OsString, OsString)>> {
        let chromium = self.installer.existing_chromium().await;
        let mut paths = vec![self.installer.cli_directory()?];
        if let Some(path) = self.installer.installed_lightpanda().await {
            paths.push(
                path.parent()
                    .context("Lightpanda tool directory")?
                    .to_path_buf(),
            );
        }
        if let Some(path) = std::env::var_os("PATH") {
            paths.extend(std::env::split_paths(&path));
        }
        let mut environment = vec![
            ("PATH".into(), std::env::join_paths(paths)?),
            (
                "AGENT_BROWSER_SKILLS_DIR".into(),
                self.installer.skills_directory().into_os_string(),
            ),
            (
                "AGENT_BROWSER_NAMESPACE".into(),
                namespace(&self.data_dir, user_id).into(),
            ),
            (
                "AGENT_BROWSER_SOCKET_DIR".into(),
                socket_directory(&self.data_dir)?.into_os_string(),
            ),
        ];
        if let Some(chromium) = chromium {
            environment.push((
                "AGENT_BROWSER_EXECUTABLE_PATH".into(),
                chromium.into_os_string(),
            ));
        }
        Ok(environment)
    }

    pub async fn shutdown(&self) {
        self.shutdown.cancel();
        let users = std::mem::take(&mut *self.users.lock().await);
        for (_, browser) in users {
            if let UserBrowser::Ready(mut dashboard) = browser {
                let _ = dashboard.child.kill().await;
                let _ = dashboard.child.wait().await;
            }
        }
    }

    #[cfg(all(test, unix))]
    pub async fn use_test_dashboard(&self, user_id: &str, port: u16) {
        let child = Command::new("sh")
            .args(["-c", "sleep 60"])
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        self.users.lock().await.insert(
            user_id.into(),
            UserBrowser::Ready(Dashboard { child, port }),
        );
    }
}

fn namespace(data_dir: &std::path::Path, user_id: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(data_dir.as_os_str().as_encoded_bytes());
    hash.update([0]);
    hash.update(user_id.as_bytes());
    hash.finalize()[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
}

fn socket_directory(data_dir: &std::path::Path) -> anyhow::Result<PathBuf> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, MetadataExt};
        let _ = data_dir;
        let uid = unsafe { libc::geteuid() };
        let path = PathBuf::from("/tmp").join(format!("sprocket-browser-{uid}"));
        match std::fs::DirBuilder::new().mode(0o700).create(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
        let metadata = std::fs::symlink_metadata(&path)?;
        anyhow::ensure!(
            metadata.is_dir() && metadata.uid() == uid && metadata.mode() & 0o077 == 0,
            "Browser socket directory must be a private directory owned by the current user"
        );
        Ok(path)
    }
    #[cfg(not(unix))]
    {
        Ok(data_dir.join("browser-run"))
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[tokio::test]
    async fn reuses_a_running_dashboard_and_rejects_a_stopped_one() {
        let directory = tempfile::tempdir().unwrap();
        let manager = BrowserManager::new(directory.path().into()).unwrap();
        manager.use_test_dashboard("user", 1234).await;
        assert_eq!(manager.start("user").await.state, "ready");
        assert_eq!(manager.port("user").await.unwrap(), 1234);

        {
            let mut users = manager.users.lock().await;
            let Some(UserBrowser::Ready(dashboard)) = users.get_mut("user") else {
                panic!("dashboard is not running");
            };
            dashboard.child.kill().await.unwrap();
        }
        // Port lookup must detect the exit without waiting for a status poll.
        assert!(manager.port("user").await.is_err());
        let status = manager.status("user").await;
        assert_eq!(status.state, "error");
        assert!(status.error.unwrap().contains("dashboard stopped"));
        manager.shutdown().await;
    }
}
