//! The KiCad connector: a pinned KiCad build plus kipy, installed on request under
//! `<data-dir>/connectors/kicad/<version>/`, whose `bin` launchers agents get on their `PATH`.

mod unpack;

use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Output, Stdio};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use anyhow::{Context, ensure};
use serde::{Deserialize, Serialize};
use sprocket_agent::InstalledConnector;
use tokio::process::Command;

use crate::python_install::PythonTools;
use crate::tool_install::{
    Asset, INSTALL_LOCK, acquire_lock, download_atomic, is_dir, is_version, large_download_client,
    open_lock_file, platform, prune_versions, remove_version, set_executable,
};

const RELEASES: &str = include_str!("../../../tools/kicad/releases.json");
const REQUIREMENTS: &str = include_str!("../../../tools/kicad/requirements.txt");
const NAME: &str = "KiCad";
const STAGING_PREFIX: &str = ".staging-";
const REQUIRED_FREE_BYTES: u64 = 10 << 30;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const PROBE_TIMEOUT: Duration = Duration::from_secs(30);
const LIB_TABLES: [&str; 2] = ["fp-lib-table", "sym-lib-table"];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ConnectorState {
    NotInstalled,
    Installing,
    Failed,
    Installed,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorStatus {
    pub id: &'static str,
    pub name: &'static str,
    pub state: ConnectorState,
    pub error: Option<String>,
    pub update_available: bool,
}

#[derive(Deserialize)]
struct Release {
    version: String,
    platforms: BTreeMap<String, Asset>,
    kipy: Asset,
}

/// Only the outcome of this process's last install lives in memory; what's installed is
/// whichever version directories exist.
enum Activity {
    Idle,
    Installing,
    Failed(String),
}

pub struct KiCadConnector {
    root: PathBuf,
    release: Release,
    python: Arc<PythonTools>,
    client: reqwest::Client,
    activity: Mutex<Activity>,
}

impl KiCadConnector {
    pub(crate) fn new(data_dir: &Path, python: Arc<PythonTools>) -> anyhow::Result<Self> {
        Ok(Self {
            root: data_dir.join("connectors").join("kicad"),
            release: serde_json::from_str(RELEASES)?,
            python,
            client: large_download_client()?,
            activity: Mutex::new(Activity::Idle),
        })
    }

    /// Deletes what an install interrupted by a restart left behind.
    pub(crate) fn prepare(&self) {
        let root = self.root.clone();
        tokio::task::spawn_blocking(move || {
            if let Err(error) = remove_leftovers_unless_installing(&root) {
                tracing::warn!("KiCad cleanup failed: {error}");
            }
        });
    }

    pub async fn status(&self) -> ConnectorStatus {
        let installed = self.installed();
        let (state, error) = match &*self.activity() {
            Activity::Installing => (ConnectorState::Installing, None),
            Activity::Failed(error) => (ConnectorState::Failed, Some(error.clone())),
            Activity::Idle if installed.is_some() => (ConnectorState::Installed, None),
            Activity::Idle => (ConnectorState::NotInstalled, None),
        };
        ConnectorStatus {
            id: "kicad",
            name: NAME,
            update_available: state == ConnectorState::Installed
                && installed.is_some_and(|installed| installed.version != self.release.version),
            state,
            error,
        }
    }

    /// Installs or updates to the pinned version in the background, unless already installing.
    pub fn install(self: &Arc<Self>) {
        {
            let mut activity = self.activity();
            if matches!(*activity, Activity::Installing) {
                return;
            }
            *activity = Activity::Installing;
        }
        let connector = Arc::clone(self);
        tokio::spawn(async move {
            let install = tokio::spawn({
                let connector = Arc::clone(&connector);
                async move { connector.install_pinned().await }
            });
            let outcome = match install.await {
                Ok(Ok(())) => Activity::Idle,
                Ok(Err(error)) => Activity::Failed(format!("{error:#}")),
                Err(error) => Activity::Failed(error.to_string()),
            };
            if let Activity::Failed(error) = &outcome {
                tracing::warn!("KiCad install failed: {error}");
            }
            *connector.activity() = outcome;
        });
    }

    pub async fn uninstall(&self) -> anyhow::Result<()> {
        let installing = matches!(*self.activity(), Activity::Installing);
        ensure!(!installing, "KiCad is still installing");
        tokio::fs::create_dir_all(&self.root).await?;
        let _lock = acquire_lock(self.root.join(INSTALL_LOCK)).await?;
        let root = self.root.clone();
        tokio::task::spawn_blocking(move || remove_installs(&root)).await??;
        *self.activity() = Activity::Idle;
        Ok(())
    }

    pub fn installed(&self) -> Option<InstalledConnector> {
        self.installed_version().map(|version| InstalledConnector {
            name: NAME,
            version,
        })
    }

    pub(crate) fn bin_dir(&self) -> Option<PathBuf> {
        self.installed_version()
            .map(|version| self.root.join(version).join("bin"))
    }

    fn activity(&self) -> MutexGuard<'_, Activity> {
        self.activity.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The pinned version, or an older one an update hasn't replaced yet.
    fn installed_version(&self) -> Option<String> {
        if self.version_dir().is_dir() {
            return Some(self.release.version.clone());
        }
        installed_versions(&self.root).into_iter().next()
    }

    fn version_dir(&self) -> PathBuf {
        self.root.join(&self.release.version)
    }

    async fn install_pinned(&self) -> anyhow::Result<()> {
        tokio::fs::create_dir_all(&self.root).await?;
        let _lock = acquire_lock(self.root.join(INSTALL_LOCK)).await?;
        let version_dir = self.version_dir();
        if !is_dir(&version_dir).await {
            let root = self.root.clone();
            tokio::task::spawn_blocking(move || remove_leftovers(&root)).await??;
            let staging = tempfile::Builder::new()
                .prefix(STAGING_PREFIX)
                .tempdir_in(&self.root)?;
            let published = match self.stage(staging.path(), &version_dir).await {
                // Publishing by a rename means the version directory exists only once complete.
                Ok(()) => tokio::fs::rename(staging.path(), &version_dir)
                    .await
                    .map_err(anyhow::Error::from),
                Err(error) => Err(error),
            };
            tokio::task::spawn_blocking(move || drop(staging)).await?;
            published?;
        }
        let (root, current) = (self.root.clone(), self.release.version.clone());
        tokio::task::spawn_blocking(move || prune_versions(&root, &current)).await?;
        Ok(())
    }

    /// Builds the version directory in `staging`, with paths that point at `version_dir`.
    async fn stage(&self, staging: &Path, version_dir: &Path) -> anyhow::Result<()> {
        self.python
            .ensure_installed()
            .await
            .context("Python setup failed")?;
        let (cli, published_cli) = match find_user_kicad(&self.root).await {
            Some(cli) => (cli.clone(), cli),
            None => {
                self.download_kicad(staging).await?;
                (
                    unpack::cli(&staging.join("kicad")),
                    unpack::cli(&version_dir.join("kicad")),
                )
            }
        };
        let version = cli_version(&cli).await?;
        self.create_venv(staging).await?;
        write_launchers(
            &staging.join("bin"),
            launchers(&published_cli, &venv_python(version_dir)),
        )
        .await?;
        let config_dir = kicad_config_dir(
            major_minor(&version)
                .with_context(|| format!("Unrecognized KiCad version {version}"))?,
        )?;
        tokio::task::spawn_blocking(move || match template_dir(&cli) {
            Some(template) => copy_lib_tables(&template, &config_dir),
            None => {
                tracing::warn!("KiCad at {} has no library table templates", cli.display());
                Ok(())
            }
        })
        .await??;
        Ok(())
    }

    async fn download_kicad(&self, staging: &Path) -> anyhow::Result<()> {
        let asset = self
            .release
            .platforms
            .get(platform()?)
            .context("KiCad has no build for this platform")?;
        ensure!(
            fs4::available_space(staging)? >= REQUIRED_FREE_BYTES,
            "KiCad needs about 10 GB of free disk space"
        );
        let download = staging.join(download_name(&asset.url));
        download_atomic(&self.client, &asset.url, &asset.checksum, &download).await?;
        let tree = staging.join("kicad");
        tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
            fs::create_dir(&tree)?;
            unpack::unpack(&download, &tree).context("Couldn't unpack KiCad")?;
            fs::remove_file(&download)?;
            Ok(())
        })
        .await?
    }

    async fn create_venv(&self, staging: &Path) -> anyhow::Result<()> {
        let uv = self.python.uv();
        let venv = staging.join("venv");
        run_checked(
            "uv venv",
            Command::new(&uv)
                .args(["venv", "--no-config", "--relocatable", "--python"])
                .arg(self.python.python())
                .arg(&venv),
        )
        .await?;
        let python = venv_python(staging);
        let requirements = staging.join("requirements.txt");
        tokio::fs::write(&requirements, REQUIREMENTS).await?;
        run_checked(
            "Installing kipy's dependencies",
            Command::new(&uv)
                .args([
                    "pip",
                    "install",
                    "--no-config",
                    "--require-hashes",
                    "--python",
                ])
                .arg(&python)
                .arg("-r")
                .arg(&requirements),
        )
        .await?;
        let kipy = &self.release.kipy;
        let wheel = staging.join(download_name(&kipy.url));
        download_atomic(&self.client, &kipy.url, &kipy.checksum, &wheel).await?;
        run_checked(
            "Installing kipy",
            Command::new(&uv)
                .args(["pip", "install", "--no-config", "--no-deps", "--python"])
                .arg(&python)
                .arg(&wheel),
        )
        .await?;
        tokio::fs::remove_file(requirements).await?;
        tokio::fs::remove_file(wheel).await?;
        Ok(())
    }
}

fn installed_versions(root: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|file_type| file_type.is_dir()))
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| is_version(name))
        .collect()
}

fn remove_installs(root: &Path) -> anyhow::Result<()> {
    for version in installed_versions(root) {
        remove_version(root, &version, &root.join(&version)).map_err(|error| {
            let error = anyhow::Error::new(error);
            // Windows refuses to move or delete files a running KiCad holds open.
            if cfg!(windows) {
                error.context("Close KiCad and retry.")
            } else {
                error
            }
        })?;
    }
    Ok(())
}

fn remove_leftovers_unless_installing(root: &Path) -> io::Result<()> {
    if !root.is_dir() {
        return Ok(());
    }
    let lock = open_lock_file(&root.join(INSTALL_LOCK))?;
    match lock.try_lock() {
        Ok(()) => remove_leftovers(root),
        Err(fs::TryLockError::WouldBlock) => Ok(()),
        Err(fs::TryLockError::Error(error)) => Err(error),
    }
}

/// Removes staging directories and tombstones, which are the only hidden directories.
fn remove_leftovers(root: &Path) -> io::Result<()> {
    for entry in fs::read_dir(root)?.flatten() {
        if entry.file_name().to_string_lossy().starts_with('.')
            && entry.file_type().is_ok_and(|file_type| file_type.is_dir())
            && let Err(error) = fs::remove_dir_all(entry.path())
        {
            tracing::warn!("Couldn't remove {}: {error}", entry.path().display());
        }
    }
    Ok(())
}

fn download_name(url: &str) -> &str {
    url.rsplit('/').next().unwrap_or(url)
}

/// A KiCad 11 or nightly the user installed, as long as it can serve kipy's API.
async fn find_user_kicad(root: &Path) -> Option<PathBuf> {
    let name = format!("kicad-cli{}", std::env::consts::EXE_SUFFIX);
    let on_path = std::env::var_os("PATH")
        .map(|path| {
            std::env::split_paths(&path)
                .map(|dir| dir.join(&name))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for cli in on_path.into_iter().chain(installed_kicad_clis()) {
        if cli.is_file() && !cli.starts_with(root) && supports_kipy(&cli).await {
            return Some(cli);
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn installed_kicad_clis() -> Vec<PathBuf> {
    newest_first(Path::new("/Applications"), "KiCad")
        .into_iter()
        .map(|dir| dir.join("KiCad.app/Contents/MacOS/kicad-cli"))
        .collect()
}

#[cfg(windows)]
fn installed_kicad_clis() -> Vec<PathBuf> {
    let program_files = std::env::var_os("ProgramFiles")
        .map_or_else(|| PathBuf::from(r"C:\Program Files"), PathBuf::from);
    newest_first(&program_files.join("KiCad"), "")
        .into_iter()
        .map(|dir| dir.join("bin").join("kicad-cli.exe"))
        .collect()
}

#[cfg(not(any(target_os = "macos", windows)))]
fn installed_kicad_clis() -> Vec<PathBuf> {
    Vec::new()
}

#[cfg(any(target_os = "macos", windows))]
fn newest_first(parent: &Path, prefix: &str) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = fs::read_dir(parent)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| entry.file_name().to_string_lossy().starts_with(prefix))
        .map(|entry| entry.path())
        .collect();
    dirs.sort_by(|a, b| b.cmp(a));
    dirs
}

async fn supports_kipy(cli: &Path) -> bool {
    let Ok(version) = cli_version(cli).await else {
        return false;
    };
    major_minor(&version).is_some_and(|version| version >= (10, 99))
        && run(
            Command::new(cli).args(["api-server", "--help"]),
            PROBE_TIMEOUT,
        )
        .await
        .is_ok_and(|output| output.status.success())
}

async fn cli_version(cli: &Path) -> anyhow::Result<String> {
    let output = run(Command::new(cli).arg("version"), PROBE_TIMEOUT).await?;
    ensure!(
        output.status.success(),
        "{} version exited with {}",
        cli.display(),
        output.status
    );
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

/// Reads `10.99` out of versions like `10.99.0-6189-g113c71d59d` or `(9.0.2)`.
fn major_minor(version: &str) -> Option<(u32, u32)> {
    let start = version.find(|character: char| character.is_ascii_digit())?;
    let mut parts = version[start..].split(|character: char| !character.is_ascii_digit());
    Some((parts.next()?.parse().ok()?, parts.next()?.parse().ok()?))
}

async fn run(command: &mut Command, timeout: Duration) -> anyhow::Result<Output> {
    let program = command.as_std().get_program().to_owned();
    let output = command.stdin(Stdio::null()).kill_on_drop(true).output();
    Ok(tokio::time::timeout(timeout, output)
        .await
        .with_context(|| format!("{} timed out", program.display()))??)
}

async fn run_checked(what: &str, command: &mut Command) -> anyhow::Result<()> {
    let output = run(command, COMMAND_TIMEOUT).await?;
    ensure!(
        output.status.success(),
        "{what} exited with {}: {}",
        output.status,
        String::from_utf8_lossy(&output.stderr).trim()
    );
    Ok(())
}

fn venv_python(dir: &Path) -> PathBuf {
    if cfg!(windows) {
        dir.join("venv").join("Scripts").join("python.exe")
    } else {
        dir.join("venv/bin/python")
    }
}

/// `kicad-python` points kipy at this KiCad, since kipy would otherwise prefer a system
/// install over `PATH`. Windows also gets `.cmd` launchers, while Git Bash, agents' usual
/// shell there, only runs the `sh` ones.
fn launchers(cli: &Path, python: &Path) -> Vec<(&'static str, String)> {
    let quote = |path: &Path| format!("'{}'", path.display().to_string().replace('\'', r"'\''"));
    let script = |body: String| format!("#!/bin/sh\n{body}\n");
    let gui = if cfg!(target_os = "macos") {
        let app = cli.ancestors().nth(3).unwrap_or(cli);
        format!("exec open -a {} \"$@\"", quote(app))
    } else {
        let executable = cli.with_file_name(format!("kicad{}", std::env::consts::EXE_SUFFIX));
        format!("exec {} \"$@\"", quote(executable.as_path()))
    };
    let launchers = vec![
        ("kicad", script(gui)),
        ("kicad-cli", script(format!("exec {} \"$@\"", quote(cli)))),
        (
            "kicad-python",
            script(format!(
                "export KICAD_CLI_PATH={}\nexec {} \"$@\"",
                quote(cli),
                quote(python)
            )),
        ),
    ];
    #[cfg(windows)]
    let launchers = launchers
        .into_iter()
        .chain(cmd_launchers(cli, python))
        .collect();
    launchers
}

#[cfg(windows)]
fn cmd_launchers(cli: &Path, python: &Path) -> [(&'static str, String); 3] {
    let escape = |path: &Path| path.display().to_string().replace('%', "%%");
    let script = |setup: String, program: &Path| -> String {
        format!(
            "@echo off\r\nsetlocal\r\n{setup}\"{}\" %*\r\nexit /b %ERRORLEVEL%\r\n",
            escape(program)
        )
    };
    [
        (
            "kicad.cmd",
            script(String::new(), cli.with_file_name("kicad.exe").as_path()),
        ),
        ("kicad-cli.cmd", script(String::new(), cli)),
        (
            "kicad-python.cmd",
            script(
                format!("set \"KICAD_CLI_PATH={}\"\r\n", escape(cli)),
                python,
            ),
        ),
    ]
}

async fn write_launchers(bin: &Path, launchers: Vec<(&'static str, String)>) -> io::Result<()> {
    tokio::fs::create_dir_all(bin).await?;
    for (name, contents) in launchers {
        let path = bin.join(name);
        tokio::fs::write(&path, contents).await?;
        set_executable(&path)?;
    }
    Ok(())
}

fn kicad_config_dir((major, minor): (u32, u32)) -> anyhow::Result<PathBuf> {
    let base = if cfg!(windows) {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .context("APPDATA isn't set")?
    } else {
        let home = sprocket_workspace::home_dir().context("HOME isn't set")?;
        if cfg!(target_os = "macos") {
            home.join("Library/Preferences")
        } else {
            std::env::var_os("XDG_CONFIG_HOME")
                .map(PathBuf::from)
                .filter(|path| path.is_absolute())
                .unwrap_or_else(|| home.join(".config"))
        }
    };
    Ok(base.join("kicad").join(format!("{major}.{minor}")))
}

/// Library table templates of the KiCad that `cli` belongs to, also following a symlinked `cli`.
fn template_dir(cli: &Path) -> Option<PathBuf> {
    [Some(cli.to_owned()), fs::canonicalize(cli).ok()]
        .into_iter()
        .flatten()
        .filter_map(|cli| {
            let prefix = cli.parent()?.parent()?.to_owned();
            Some(if cfg!(target_os = "macos") {
                prefix.join("SharedSupport/template")
            } else {
                prefix.join("share/kicad/template")
            })
        })
        .find(|dir| dir.is_dir())
}

/// Gives a fresh KiCad config the default library tables, so it doesn't stop at a setup
/// dialog; tables the user already has stay untouched.
fn copy_lib_tables(template: &Path, config: &Path) -> io::Result<()> {
    for name in LIB_TABLES {
        let (source, target) = (template.join(name), config.join(name));
        if !source.is_file() || target.exists() {
            continue;
        }
        fs::create_dir_all(config)?;
        let mut temporary = tempfile::NamedTempFile::new_in(config)?;
        io::copy(&mut File::open(&source)?, temporary.as_file_mut())?;
        if let Err(error) = temporary.persist_noclobber(&target)
            && error.error.kind() != io::ErrorKind::AlreadyExists
        {
            return Err(error.error);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
