use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, ensure};
use serde::Serialize;
use sprocket_workspace::github::status::GitHubStatus;
use sprocket_workspace::github::{self, GitHubSettings, PUBLIC_HOST, gh_command};

use crate::device_sign_in::{DeviceSignIns, SignInStatus};
use crate::tool_install::{PinnedTool, ToolInstall};

const FILE_NAME: &str = "github-settings.json";
const SIGN_OUT_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubConnectorStatus {
    pub install: ToolInstall,
    #[serde(flatten)]
    pub github: GitHubStatus,
}

pub struct GitHubConnector {
    path: PathBuf,
    write_lock: tokio::sync::Mutex<()>,
    gh: Arc<PinnedTool>,
    sign_ins: Arc<DeviceSignIns>,
}

impl GitHubConnector {
    pub(crate) fn load(data_dir: &Path, gh: Arc<PinnedTool>) -> Arc<Self> {
        let path = data_dir.join(FILE_NAME);
        match read(&path) {
            Ok(settings) => github::apply_settings(settings),
            Err(error) => tracing::warn!(
                "ignoring unreadable GitHub settings at {}: {error:#}",
                path.display()
            ),
        }
        Arc::new(Self {
            path,
            write_lock: tokio::sync::Mutex::new(()),
            gh,
            sign_ins: Arc::default(),
        })
    }

    pub async fn status(&self) -> GitHubConnectorStatus {
        GitHubConnectorStatus {
            install: self.gh.install_state().await,
            github: github::status::status().await,
        }
    }

    pub async fn retry_install(&self) -> ToolInstall {
        self.gh.retry_install().await
    }

    pub(crate) fn installed(&self) -> Option<String> {
        crate::gh_install::executable(&self.gh)
            .is_file()
            .then(|| format!("GitHub connector (GitHub CLI {}, `gh`)", self.gh.version()))
    }

    pub async fn update(&self, change: impl FnOnce(&mut GitHubSettings)) -> anyhow::Result<()> {
        let _guard = self.write_lock.lock().await;
        let mut settings = github::settings();
        change(&mut settings);
        let bytes = serde_json::to_vec_pretty(&settings)?;
        let path = self.path.clone();
        tokio::task::spawn_blocking(move || crate::profile::write_private_file(&path, &bytes))
            .await??;
        github::apply_settings(settings);
        Ok(())
    }

    pub fn sign_in_status(&self, host: &str) -> SignInStatus {
        self.sign_ins.status(host)
    }

    pub async fn start_sign_in(self: &Arc<Self>, host: &str) -> SignInStatus {
        if self.gh.install_state().await != ToolInstall::Installed {
            return SignInStatus::Failed {
                error: "The GitHub CLI isn't installed yet.".to_string(),
            };
        }
        let command = gh_command(&[
            "auth",
            "login",
            "--hostname",
            host,
            "--web",
            "--git-protocol",
            "https",
            "--skip-ssh-key",
            "--clipboard=false",
        ]);
        let connector = Arc::clone(self);
        let signed_in_host = host.to_string();
        self.sign_ins.start(host, command, move || {
            tokio::spawn(async move {
                if let Err(error) = connector.remember_host(&signed_in_host, true).await {
                    tracing::warn!("Couldn't save the GitHub host {signed_in_host}: {error:#}");
                }
            });
        })
    }

    pub fn cancel_sign_in(&self, host: &str) -> SignInStatus {
        self.sign_ins.cancel(host)
    }

    pub async fn sign_out(&self, host: &str) -> anyhow::Result<()> {
        let mut command = gh_command(&["auth", "logout", "--hostname", host]);
        let output =
            tokio::time::timeout(SIGN_OUT_TIMEOUT, command.stderr(Stdio::piped()).output())
                .await
                .context("gh auth logout timed out")??;
        ensure!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
        self.remember_host(host, false).await
    }

    async fn remember_host(&self, host: &str, signed_in: bool) -> anyhow::Result<()> {
        github::forget_cached_credentials();
        if host == PUBLIC_HOST {
            return Ok(());
        }
        self.update(|settings| {
            if signed_in {
                settings.signed_in_hosts.insert(host.to_string());
            } else {
                settings.signed_in_hosts.remove(host);
            }
        })
        .await
    }
}

fn read(path: &Path) -> anyhow::Result<GitHubSettings> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(GitHubSettings::default()),
        Err(error) => Err(error.into()),
    }
}
