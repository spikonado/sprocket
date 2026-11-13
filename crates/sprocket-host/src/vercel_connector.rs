use std::fs::File;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, bail, ensure};
use serde::{Deserialize, Serialize};
use sprocket_workspace::github::hide_console_window;
use tokio::process::Command;

use crate::device_sign_in::{DeviceSignIns, SignInStatus};
use crate::tool_install::{PinnedTool, ToolInstall, set_executable};

const VERCEL: &str = if cfg!(windows) {
    "vercel.exe"
} else {
    "vercel"
};
const SIGN_IN_KEY: &str = "vercel";
const TOKEN_VARIABLE: &str = "VERCEL_TOKEN";
const COMMAND_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VercelStatus {
    pub install: ToolInstall,
    pub version: String,
    pub account: Account,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Account {
    SignedOut,
    SignedIn {
        login: String,
        source: AccountSource,
    },
    Problem {
        error: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AccountSource {
    Cli,
    Environment,
}

pub struct VercelConnector {
    tool: Arc<PinnedTool>,
    sign_ins: Arc<DeviceSignIns>,
}

impl VercelConnector {
    pub(crate) fn new(data_dir: &Path) -> anyhow::Result<Self> {
        Ok(Self {
            tool: Arc::new(PinnedTool::new(
                data_dir,
                "vercel",
                include_str!("../../../tools/vercel/releases.json"),
                unpack,
            )?),
            sign_ins: Arc::default(),
        })
    }

    pub(crate) fn prepare(&self) {
        self.tool.prepare();
    }

    pub async fn retry_install(&self) -> ToolInstall {
        self.tool.retry_install().await
    }

    pub(crate) fn bin_dir(&self) -> PathBuf {
        self.tool.bin_dir()
    }

    pub(crate) fn installed(&self) -> Option<String> {
        self.executable().is_file().then(|| {
            format!(
                "Vercel connector (Vercel CLI {}, `vercel`)",
                self.tool.version()
            )
        })
    }

    pub async fn status(&self) -> VercelStatus {
        let install = self.tool.install_state().await;
        let account = if install == ToolInstall::Installed {
            self.account().await
        } else {
            Account::SignedOut
        };
        VercelStatus {
            install,
            version: self.tool.version().to_string(),
            account,
        }
    }

    pub fn sign_in_status(&self) -> SignInStatus {
        self.sign_ins.status(SIGN_IN_KEY)
    }

    pub async fn start_sign_in(&self) -> SignInStatus {
        if self.tool.install_state().await != ToolInstall::Installed {
            return SignInStatus::Failed {
                error: "The Vercel CLI isn't installed yet.".to_string(),
            };
        }
        let mut command = self.command(&["login"]);
        command.env_remove(TOKEN_VARIABLE);
        self.sign_ins.start(SIGN_IN_KEY, command, || {})
    }

    pub fn cancel_sign_in(&self) -> SignInStatus {
        self.sign_ins.cancel(SIGN_IN_KEY)
    }

    pub async fn sign_out(&self) -> anyhow::Result<()> {
        let mut command = self.command(&["logout"]);
        command.env_remove(TOKEN_VARIABLE);
        let output = run(&mut command).await?;
        ensure!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
        Ok(())
    }

    async fn account(&self) -> Account {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct WhoAmI {
            username: Option<String>,
            logged_in: Option<bool>,
        }

        let output = match run(&mut self.command(&["whoami", "--json"])).await {
            Ok(output) => output,
            Err(error) => {
                return Account::Problem {
                    error: format!("{error:#}"),
                };
            }
        };
        match serde_json::from_slice::<WhoAmI>(&output.stdout) {
            Ok(WhoAmI {
                username: Some(login),
                ..
            }) => Account::SignedIn {
                login,
                source: if std::env::var(TOKEN_VARIABLE).is_ok_and(|token| !token.trim().is_empty())
                {
                    AccountSource::Environment
                } else {
                    AccountSource::Cli
                },
            },
            Ok(WhoAmI {
                logged_in: Some(false),
                ..
            }) => Account::SignedOut,
            _ => Account::Problem {
                error: last_line(&output.stderr)
                    .unwrap_or_else(|| "Vercel didn't say who is signed in.".to_string()),
            },
        }
    }

    fn executable(&self) -> PathBuf {
        self.tool.bin_dir().join(VERCEL)
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(self.executable());
        command
            .args(args)
            .env("NO_COLOR", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        hide_console_window(&mut command);
        command
    }
}

async fn run(command: &mut Command) -> anyhow::Result<std::process::Output> {
    tokio::time::timeout(COMMAND_TIMEOUT, command.output())
        .await
        .context("the Vercel CLI didn't answer in time")?
        .context("couldn't run the Vercel CLI")
}

fn last_line(output: &[u8]) -> Option<String> {
    String::from_utf8_lossy(output)
        .lines()
        .map(str::trim)
        .rfind(|line| !line.is_empty())
        .map(str::to_string)
}

/// Extracts the binary from Vercel's per-platform npm package tarball.
fn unpack(archive: &Path, bin: &Path) -> anyhow::Result<()> {
    let entry_path = Path::new("package/bin").join(VERCEL);
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(File::open(archive)?));
    for entry in archive.entries()? {
        let mut entry = entry?;
        if entry.path()? == entry_path {
            let vercel = bin.join(VERCEL);
            entry.unpack(&vercel)?;
            set_executable(&vercel)?;
            return Ok(());
        }
    }
    bail!("Vercel CLI archive has no {}", entry_path.display())
}
