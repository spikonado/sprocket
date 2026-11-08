//! Finds, checks and installs the coding CLIs that subscription providers run through.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use anyhow::{Context, bail};
use tokio::process::Command;

const VERSION_TIMEOUT: Duration = Duration::from_secs(10);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const INSTALL_ERROR_TAIL: usize = 600;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct Version(pub(crate) u32, pub(crate) u32, pub(crate) u32);

impl Version {
    /// Reads the first `x.y.z` word of `--version` output, such as `2.1.318 (Claude Code)`.
    fn parse(output: &str) -> Option<Self> {
        output.split_whitespace().find_map(|word| {
            let mut parts = word.split('.');
            let mut next = || parts.next()?.parse().ok();
            Some(Self(next()?, next()?, next()?))
        })
    }
}

impl std::fmt::Display for Version {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}.{}.{}", self.0, self.1, self.2)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum InstallState {
    NotInstalled,
    Installing,
    Outdated,
    Installed,
}

pub(crate) struct InstallStatus {
    pub(crate) state: InstallState,
    pub(crate) version: Option<String>,
    pub(crate) error: Option<String>,
}

enum Activity {
    Idle,
    Installing,
    Failed(String),
}

pub(crate) struct Cli {
    /// The product name the user knows, such as `Claude Code`.
    pub(crate) name: &'static str,
    pub(crate) command: &'static str,
    /// The oldest release with everything Sprocket's runs use.
    pub(crate) minimum_version: Version,
    pub(crate) install_command: &'static str,
}

enum Detected {
    Usable(PathBuf, Version),
    Outdated(Version),
    Missing,
}

/// One CLI on this computer and the install Sprocket runs for it.
pub(crate) struct CliInstall {
    cli: Cli,
    activity: Mutex<Activity>,
}

impl CliInstall {
    pub(crate) fn new(cli: Cli) -> Arc<Self> {
        Arc::new(Self {
            cli,
            activity: Mutex::new(Activity::Idle),
        })
    }

    pub(crate) fn cli(&self) -> &Cli {
        &self.cli
    }

    fn activity(&self) -> MutexGuard<'_, Activity> {
        self.activity
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(crate) async fn status(&self) -> InstallStatus {
        let (detected_state, version) = match self.detect().await {
            Detected::Usable(_, version) => (InstallState::Installed, Some(version)),
            Detected::Outdated(version) => (InstallState::Outdated, Some(version)),
            Detected::Missing => (InstallState::NotInstalled, None),
        };
        let (state, error) = match &*self.activity() {
            Activity::Installing => (InstallState::Installing, None),
            Activity::Failed(error) => (detected_state, Some(error.clone())),
            Activity::Idle => (detected_state, None),
        };
        InstallStatus {
            state,
            version: version.map(|version| version.to_string()),
            error,
        }
    }

    /// Runs the CLI's official installer in the background. It also updates an old install.
    pub(crate) fn install(self: &Arc<Self>) {
        {
            let mut activity = self.activity();
            if matches!(*activity, Activity::Installing) {
                return;
            }
            *activity = Activity::Installing;
        }
        let install = Arc::clone(self);
        tokio::spawn(async move {
            let outcome = match install.run_installer().await {
                Ok(()) => Activity::Idle,
                Err(error) => {
                    tracing::warn!("{} install failed: {error:#}", install.cli.name);
                    Activity::Failed(format!("{error:#}"))
                }
            };
            *install.activity() = outcome;
        });
    }

    pub(crate) async fn usable_executable(&self) -> anyhow::Result<PathBuf> {
        let Cli {
            name,
            minimum_version,
            ..
        } = &self.cli;
        match self.detect().await {
            Detected::Usable(path, _) => Ok(path),
            Detected::Outdated(version) => bail!(
                "{name} {version} is older than {minimum_version}, which Sprocket needs. Update it in Settings > BYOK/BYOS."
            ),
            Detected::Missing => {
                bail!(
                    "{name} isn't installed on this computer. Install it in Settings > BYOK/BYOS."
                )
            }
        }
    }

    /// The first install new enough to use, or the newest outdated one.
    async fn detect(&self) -> Detected {
        let mut newest_outdated = None;
        for candidate in candidates(self.cli.command) {
            let Some(version) = version_of(&candidate).await else {
                continue;
            };
            if version >= self.cli.minimum_version {
                return Detected::Usable(candidate, version);
            }
            newest_outdated = newest_outdated.max(Some(version));
        }
        newest_outdated.map_or(Detected::Missing, Detected::Outdated)
    }

    async fn run_installer(&self) -> anyhow::Result<()> {
        let Cli {
            name,
            minimum_version,
            install_command,
            ..
        } = &self.cli;
        let mut command = if cfg!(windows) {
            let mut command = Command::new("powershell");
            command.args([
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                *install_command,
            ]);
            command
        } else {
            let mut command = Command::new("bash");
            command.args(["-c", &format!("set -o pipefail; {install_command}")]);
            command
        };
        let output = tokio::time::timeout(
            INSTALL_TIMEOUT,
            command.stdin(Stdio::null()).kill_on_drop(true).output(),
        )
        .await
        .with_context(|| format!("The {name} installer didn't finish in 10 minutes."))?
        .with_context(|| format!("Couldn't start the {name} installer"))?;
        if !output.status.success() {
            let mut log = String::from_utf8_lossy(&output.stderr).trim().to_string();
            if log.is_empty() {
                log = String::from_utf8_lossy(&output.stdout).trim().to_string();
            }
            bail!(
                "The {name} installer failed: {}",
                tail(&log, INSTALL_ERROR_TAIL)
            );
        }
        if let Detected::Usable(..) = self.detect().await {
            return Ok(());
        }
        bail!("The installer finished, but Sprocket can't find {name} {minimum_version} or newer.")
    }
}

/// `PATH`, then where the official installers put the launcher, since apps opened from a
/// desktop often get a `PATH` without it.
fn candidates(command: &str) -> Vec<PathBuf> {
    let name = format!("{command}{}", std::env::consts::EXE_SUFFIX);
    // Runs start the CLI from the workspace, where a relative entry names another file.
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|path| {
            std::env::split_paths(&path)
                .filter(|dir| dir.is_absolute())
                .collect()
        })
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

pub(crate) fn tail(text: &str, max: usize) -> &str {
    let mut start = text.len().saturating_sub(max);
    while !text.is_char_boundary(start) {
        start += 1;
    }
    &text[start..]
}

#[cfg(test)]
mod tests;
