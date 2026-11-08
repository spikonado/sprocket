use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use anyhow::Context;
use futures::future::BoxFuture;
use serde::Serialize;
use serde_json::{Value, json};
use sprocket_agent::CliLocator;
use sprocket_agent::muse::{Incoming, Msp, served_model_id};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::cli_install::{Cli, CliInstall, InstallState, Version};

#[cfg(not(windows))]
const INSTALL_COMMAND: &str = "curl -fsSL https://dev.meta.ai/install.sh | bash";
#[cfg(windows)]
const INSTALL_COMMAND: &str = "irm https://dev.meta.ai/install.ps1 | iex";

/// The catalog model Muse subscription runs serve.
const MODEL: &str = "muse-wonder-full-1.0";
const STATUS_TIMEOUT: Duration = Duration::from_secs(20);
/// Muse's device codes expire well before this.
const LOGIN_TIMEOUT: Duration = Duration::from_secs(30 * 60);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MuseState {
    NotInstalled,
    Installing,
    Outdated,
    /// Not signed in with a Muse Code account. API keys bill pay-as-you-go, so they don't count.
    SignedOut,
    /// The account's plan doesn't include Muse Wonder Full.
    PlanRequired,
    Ready,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MuseStatus {
    state: MuseState,
    version: Option<String>,
    minimum_version: String,
    install_command: &'static str,
    account: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginStart {
    pub login_id: String,
    pub verification_url: String,
    pub user_code: String,
}

/// A device-code sign-in, whose Muse process must stay up until the user finishes it.
struct Login {
    id: String,
    waiter: JoinHandle<()>,
}

impl Drop for Login {
    fn drop(&mut self) {
        self.waiter.abort();
    }
}

/// The user's own Muse Code CLI, which Muse subscription runs drive.
pub struct MuseCli {
    install: Arc<CliInstall>,
    login: Mutex<Option<Login>>,
    login_error: Arc<Mutex<Option<String>>>,
}

impl MuseCli {
    pub(crate) fn new() -> Self {
        Self {
            install: CliInstall::new(Cli {
                name: "Muse Code",
                command: "muse",
                // The oldest release with session MCP servers and the settings Sprocket's runs set.
                minimum_version: Version(1, 4, 14),
                install_command: INSTALL_COMMAND,
            }),
            login: Mutex::new(None),
            login_error: Arc::default(),
        }
    }

    fn login(&self) -> MutexGuard<'_, Option<Login>> {
        self.login
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub async fn status(&self) -> MuseStatus {
        let install = self.install.status().await;
        let mut status = MuseStatus {
            state: match install.state {
                InstallState::NotInstalled => MuseState::NotInstalled,
                InstallState::Installing => MuseState::Installing,
                InstallState::Outdated => MuseState::Outdated,
                InstallState::Installed => MuseState::SignedOut,
            },
            version: install.version,
            minimum_version: self.install.cli().minimum_version.to_string(),
            install_command: INSTALL_COMMAND,
            account: None,
            error: install.error,
        };
        if status.state != MuseState::SignedOut {
            return status;
        }
        match tokio::time::timeout(STATUS_TIMEOUT, self.account()).await {
            Ok(Ok((state, account))) => {
                status.state = state;
                status.account = account;
                if let Some(error) = self.login_error.lock().ok().and_then(|mut e| e.take()) {
                    status.error = Some(error);
                }
            }
            Ok(Err(error)) => status.error = Some(format!("{error:#}")),
            Err(_) => status.error = Some("Muse Code didn't report its account.".to_string()),
        }
        status
    }

    async fn account(&self) -> anyhow::Result<(MuseState, Option<String>)> {
        let (msp, _) = self.start().await?;
        let account = msp.call("account/read", json!({})).await?;
        let label = account["label"].as_str().map(str::to_string);
        if account["state"] != "accountLogin" {
            return Ok((MuseState::SignedOut, None));
        }
        let models = msp.call("model/list", json!({})).await?;
        let state = match served_model_id(&models, MODEL) {
            Some(_) => MuseState::Ready,
            None => MuseState::PlanRequired,
        };
        Ok((state, label))
    }

    async fn start(&self) -> anyhow::Result<(Msp, mpsc::UnboundedReceiver<Incoming>)> {
        let executable = self.install.usable_executable().await?;
        Msp::start(&executable, ["--no-session-log"], &home()).await
    }

    pub fn install(&self) {
        self.install.install();
    }

    /// Starts Muse's device-code sign-in. Status turns `ready` or `planRequired` once the user
    /// finishes it.
    pub async fn start_login(&self) -> anyhow::Result<LoginStart> {
        self.login().take();
        if let Ok(mut error) = self.login_error.lock() {
            error.take();
        }
        let (msp, mut incoming) = self.start().await?;
        let started = msp
            .call("account/loginStart", json!({ "type": "deviceCode" }))
            .await
            .context("Muse Code couldn't start signing in")?;
        let (Some(verification_url), Some(user_code)) = (
            started["verificationUrl"].as_str(),
            started["userCode"].as_str(),
        ) else {
            anyhow::bail!("Muse Code started signing in without a device code.");
        };
        let login_error = Arc::clone(&self.login_error);
        let waiter = tokio::spawn(async move {
            let completed = tokio::time::timeout(LOGIN_TIMEOUT, async {
                while let Some(message) = incoming.recv().await {
                    match message {
                        Incoming::Notification { method, params }
                            if method == "account/loginCompleted" =>
                        {
                            return params;
                        }
                        Incoming::Notification { .. } => {}
                        Incoming::Exited(reason) => {
                            return json!({ "outcome": "failed", "message": reason });
                        }
                    }
                }
                Value::Null
            })
            .await
            .unwrap_or_else(|_| {
                json!({ "outcome": "expired", "message": "The Muse Code sign-in expired. Sign in again." })
            });
            if completed["outcome"] != "granted"
                && completed["outcome"] != "cancelled"
                && let Ok(mut error) = login_error.lock()
            {
                *error = Some(
                    completed["message"]
                        .as_str()
                        .unwrap_or("Muse Code sign-in didn't finish.")
                        .to_string(),
                );
            }
            drop(msp);
        });
        let login_id = uuid::Uuid::new_v4().to_string();
        *self.login() = Some(Login {
            id: login_id.clone(),
            waiter,
        });
        Ok(LoginStart {
            login_id,
            verification_url: verification_url.to_string(),
            user_code: user_code.to_string(),
        })
    }

    /// Stopping the Muse process that holds the sign-in cancels it.
    pub fn cancel_login(&self, login_id: &str) {
        let mut login = self.login();
        if login.as_ref().is_some_and(|login| login.id == login_id) {
            login.take();
        }
    }
}

impl CliLocator for MuseCli {
    fn executable(&self) -> BoxFuture<'_, anyhow::Result<PathBuf>> {
        Box::pin(self.install.usable_executable())
    }
}

/// Muse checks accounts outside any workspace.
fn home() -> PathBuf {
    sprocket_workspace::home_dir().unwrap_or_else(std::env::temp_dir)
}
