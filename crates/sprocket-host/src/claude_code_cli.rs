mod login;

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use anyhow::{Context, bail};
use futures::future::BoxFuture;
use serde::Serialize;
use sprocket_agent::ClaudeCodeLocator;
use tokio::process::Command;

pub use self::login::LoginStart;
use self::login::Logins;

/// The oldest release with every flag and stream-json field Sprocket's runs use.
const MINIMUM_VERSION: Version = Version(2, 1, 257);
const VERSION_TIMEOUT: Duration = Duration::from_secs(10);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const INSTALL_ERROR_TAIL: usize = 600;

#[cfg(not(windows))]
const INSTALL_COMMAND: &str = "curl -fsSL https://claude.ai/install.sh | bash";
#[cfg(windows)]
const INSTALL_COMMAND: &str = "irm https://claude.ai/install.ps1 | iex";

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct Version(u32, u32, u32);

impl Version {
    /// Reads `claude --version` output such as `2.1.318 (Claude Code)`.
    fn parse(output: &str) -> Option<Self> {
        let mut parts = output.split_whitespace().next()?.split('.');
        let mut next = || parts.next()?.parse().ok();
        Some(Self(next()?, next()?, next()?))
    }
}

impl std::fmt::Display for Version {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}.{}.{}", self.0, self.1, self.2)
    }
}

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

enum Activity {
    Idle,
    Installing,
    Failed(String),
}

/// The user's own Claude Code CLI, which Claude subscription runs drive.
pub struct ClaudeCodeCli {
    activity: Mutex<Activity>,
    logins: Logins,
}

enum Detected {
    Usable(PathBuf, Version),
    Outdated(Version),
    Missing,
}

impl ClaudeCodeCli {
    pub(crate) fn new() -> Self {
        Self {
            activity: Mutex::new(Activity::Idle),
            logins: Logins::default(),
        }
    }

    fn activity(&self) -> MutexGuard<'_, Activity> {
        self.activity
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub async fn status(&self) -> ClaudeCodeStatus {
        let (detected_state, version) = match detect().await {
            Detected::Usable(_, version) => (ClaudeCodeState::Installed, Some(version)),
            Detected::Outdated(version) => (ClaudeCodeState::Outdated, Some(version)),
            Detected::Missing => (ClaudeCodeState::NotInstalled, None),
        };
        let (state, error) = match &*self.activity() {
            Activity::Installing => (ClaudeCodeState::Installing, None),
            Activity::Failed(error) => (detected_state, Some(error.clone())),
            Activity::Idle => (detected_state, None),
        };
        ClaudeCodeStatus {
            state,
            version: version.map(|version| version.to_string()),
            minimum_version: MINIMUM_VERSION.to_string(),
            install_command: INSTALL_COMMAND,
            error,
        }
    }

    /// Runs Claude Code's official installer in the background. It also updates an old install.
    pub fn install(self: &Arc<Self>) {
        {
            let mut activity = self.activity();
            if matches!(*activity, Activity::Installing) {
                return;
            }
            *activity = Activity::Installing;
        }
        let cli = Arc::clone(self);
        tokio::spawn(async move {
            let outcome = match run_installer().await {
                Ok(()) => Activity::Idle,
                Err(error) => {
                    tracing::warn!("Claude Code install failed: {error:#}");
                    Activity::Failed(format!("{error:#}"))
                }
            };
            *cli.activity() = outcome;
        });
    }

    /// Starts `claude setup-token` and returns the sign-in URL it prints.
    pub async fn start_login(&self) -> anyhow::Result<LoginStart> {
        let executable = usable_executable().await?;
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

impl ClaudeCodeLocator for ClaudeCodeCli {
    fn executable(&self) -> BoxFuture<'_, anyhow::Result<PathBuf>> {
        Box::pin(usable_executable())
    }
}

async fn usable_executable() -> anyhow::Result<PathBuf> {
    match detect().await {
        Detected::Usable(path, _) => Ok(path),
        Detected::Outdated(version) => bail!(
            "Claude Code {version} is older than {MINIMUM_VERSION}, which Sprocket needs. Update it in Settings > BYOK/BYOS."
        ),
        Detected::Missing => {
            bail!(
                "Claude Code isn't installed on this computer. Install it in Settings > BYOK/BYOS."
            )
        }
    }
}

/// The first install new enough to use, or the newest outdated one.
async fn detect() -> Detected {
    let mut newest_outdated = None;
    for candidate in candidates() {
        let Some(version) = version_of(&candidate).await else {
            continue;
        };
        if version >= MINIMUM_VERSION {
            return Detected::Usable(candidate, version);
        }
        newest_outdated = newest_outdated.max(Some(version));
    }
    newest_outdated.map_or(Detected::Missing, Detected::Outdated)
}

/// `PATH`, then where the official installers put the launcher, since apps opened from a
/// desktop often get a `PATH` without it.
fn candidates() -> Vec<PathBuf> {
    let name = format!("claude{}", std::env::consts::EXE_SUFFIX);
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default();
    if let Some(home) = sprocket_workspace::home_dir() {
        dirs.push(home.join(".local").join("bin"));
    }
    if cfg!(target_os = "macos") {
        dirs.extend(["/opt/homebrew/bin", "/usr/local/bin"].map(PathBuf::from));
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    for candidate in dirs.into_iter().map(|dir| dir.join(&name)) {
        if candidate.is_file() && !candidates.contains(&candidate) {
            candidates.push(candidate);
        }
    }
    candidates
}

async fn version_of(executable: &Path) -> Option<Version> {
    let output = tokio::time::timeout(
        VERSION_TIMEOUT,
        Command::new(executable)
            .arg("--version")
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    output
        .status
        .success()
        .then(|| Version::parse(&String::from_utf8_lossy(&output.stdout)))
        .flatten()
}

async fn run_installer() -> anyhow::Result<()> {
    let mut command = if cfg!(windows) {
        let mut command = Command::new("powershell");
        command.args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            INSTALL_COMMAND,
        ]);
        command
    } else {
        let mut command = Command::new("bash");
        command.args(["-c", &format!("set -o pipefail; {INSTALL_COMMAND}")]);
        command
    };
    let output = tokio::time::timeout(
        INSTALL_TIMEOUT,
        command.stdin(Stdio::null()).kill_on_drop(true).output(),
    )
    .await
    .context("The Claude Code installer didn't finish in 10 minutes.")?
    .context("Couldn't start the Claude Code installer")?;
    if !output.status.success() {
        let mut log = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if log.is_empty() {
            log = String::from_utf8_lossy(&output.stdout).trim().to_string();
        }
        bail!(
            "The Claude Code installer failed: {}",
            tail(&log, INSTALL_ERROR_TAIL)
        );
    }
    if let Detected::Usable(..) = detect().await {
        return Ok(());
    }
    bail!("The installer finished, but Sprocket can't find Claude Code {MINIMUM_VERSION} or newer.")
}

fn tail(text: &str, max: usize) -> &str {
    let mut start = text.len().saturating_sub(max);
    while !text.is_char_boundary(start) {
        start += 1;
    }
    &text[start..]
}

#[cfg(test)]
mod tests;
