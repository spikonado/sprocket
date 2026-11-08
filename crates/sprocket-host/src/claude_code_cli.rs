mod login;

use std::path::PathBuf;
use std::sync::Arc;

use futures::future::BoxFuture;
use serde::Serialize;
use sprocket_agent::CliLocator;

pub use self::login::LoginStart;
use self::login::Logins;
use crate::cli_install::{Cli, CliInstall, InstallState, Version};

#[cfg(not(windows))]
const INSTALL_COMMAND: &str = "curl -fsSL https://claude.ai/install.sh | bash";
#[cfg(windows)]
const INSTALL_COMMAND: &str = "irm https://claude.ai/install.ps1 | iex";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ClaudeCodeState {
    NotInstalled,
    Installing,
    Outdated,
    Installed,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeCodeStatus {
    state: ClaudeCodeState,
    version: Option<String>,
    minimum_version: String,
    install_command: &'static str,
    error: Option<String>,
}

/// The user's own Claude Code CLI, which Claude subscription runs drive.
pub struct ClaudeCodeCli {
    install: Arc<CliInstall>,
    logins: Logins,
}

impl ClaudeCodeCli {
    pub(crate) fn new() -> Self {
        Self {
            install: CliInstall::new(Cli {
                name: "Claude Code",
                command: "claude",
                // The oldest release with every flag and stream-json field Sprocket's runs use.
                minimum_version: Version(2, 1, 257),
                install_command: INSTALL_COMMAND,
            }),
            logins: Logins::default(),
        }
    }

    pub async fn status(&self) -> ClaudeCodeStatus {
        let status = self.install.status().await;
        ClaudeCodeStatus {
            state: match status.state {
                InstallState::NotInstalled => ClaudeCodeState::NotInstalled,
                InstallState::Installing => ClaudeCodeState::Installing,
                InstallState::Outdated => ClaudeCodeState::Outdated,
                InstallState::Installed => ClaudeCodeState::Installed,
            },
            version: status.version,
            minimum_version: self.install.cli().minimum_version.to_string(),
            install_command: INSTALL_COMMAND,
            error: status.error,
        }
    }

    pub fn start_install_or_update(&self) {
        self.install.start_install_or_update();
    }

    /// Starts `claude setup-token` and returns the sign-in URL it prints.
    pub async fn start_login(&self) -> anyhow::Result<LoginStart> {
        let executable = self.install.usable_executable().await?;
        self.logins.start(&executable).await
    }

    /// Hands Claude's sign-in code to the login and returns the long-lived token it creates.
    pub async fn finish_login(&self, login_id: &str, code: &str) -> anyhow::Result<String> {
        self.logins.finish(login_id, code).await
    }

    pub fn cancel_login(&self, login_id: &str) {
        self.logins.cancel(login_id);
    }
}

impl CliLocator for ClaudeCodeCli {
    fn executable(&self) -> BoxFuture<'_, anyhow::Result<PathBuf>> {
        Box::pin(self.install.usable_executable())
    }
}
