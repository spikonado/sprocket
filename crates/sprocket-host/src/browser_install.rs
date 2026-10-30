use std::collections::BTreeMap;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::process::{Output, Stdio};
use std::time::Duration;

use anyhow::{Context, bail, ensure};
use serde::Deserialize;
use tokio::process::Command;
use tokio::sync::Mutex;

use crate::tool_install::{
    Checksum, INSTALL_LOCK, acquire_lock, download_atomic, download_client, executable_file,
    lease_version, prune_versions, verified_file,
};

const RELEASES: &str = include_str!("../../../tools/agent-browser/releases.json");
const COMMAND_TIMEOUT: Duration = Duration::from_secs(10 * 60);
pub(crate) const AGENT_BROWSER_USE_SYSTEM_CA: &str = "AGENT_BROWSER_USE_SYSTEM_CA";

pub(crate) struct BrowserInstaller {
    tool_dir: PathBuf,
    releases: Releases,
    client: reqwest::Client,
    ready_cli: Mutex<Option<PathBuf>>,
    lease: Mutex<Option<File>>,
}

impl BrowserInstaller {
    pub fn new(data_dir: &Path) -> anyhow::Result<Self> {
        Ok(Self {
            tool_dir: data_dir.join("tools/agent-browser"),
            releases: serde_json::from_str(RELEASES)?,
            client: download_client()?,
            ready_cli: Mutex::new(None),
            lease: Mutex::new(None),
        })
    }

    pub async fn ensure_ready(&self) -> anyhow::Result<PathBuf> {
        let mut ready_cli = self.ready_cli.lock().await;
        if let Some(cli) = ready_cli.as_ref()
            && executable_file(cli).await
        {
            return Ok(cli.clone());
        }
        let cli = self.install().await?;
        self.ensure_chromium(&cli).await?;
        *ready_cli = Some(cli.clone());
        Ok(cli)
    }

    fn version_dir(&self) -> PathBuf {
        self.tool_dir.join(&self.releases.agent_browser.version)
    }

    pub fn cli_directory(&self) -> anyhow::Result<PathBuf> {
        Ok(self.version_dir().join(platform()?))
    }

    pub fn skills_directory(&self) -> PathBuf {
        self.version_dir().join("skill-data")
    }

    async fn install(&self) -> anyhow::Result<PathBuf> {
        let release = &self.releases.agent_browser;
        let asset = release
            .platforms
            .get(platform()?)
            .context("missing pinned release")?;
        let directory = self.cli_directory()?;
        tokio::fs::create_dir_all(&directory).await?;
        let _lock = acquire_lock(self.version_dir().join(INSTALL_LOCK)).await?;
        let cli = directory.join(if cfg!(windows) {
            "agent-browser.exe"
        } else {
            "agent-browser"
        });
        if !verified_file(&cli, &asset.checksum).await? {
            let url = format!(
                "https://github.com/{}/releases/download/{}/{}",
                release.repository, release.tag, asset.asset
            );
            download_atomic(&self.client, &url, &asset.checksum, &cli).await?;
        }
        self.ensure_skills().await?;
        lease_version(&self.lease, &self.version_dir()).await;
        let tool_dir = self.tool_dir.clone();
        let current = release.version.clone();
        if let Err(error) =
            tokio::task::spawn_blocking(move || prune_versions(&tool_dir, &current)).await
        {
            tracing::warn!("Old agent-browser cleanup failed: {error}");
        }
        Ok(cli)
    }

    /// The native CLI doesn't embed its skills, so `agent-browser skills get <name>` reads them
    /// from the release's source tree.
    async fn ensure_skills(&self) -> anyhow::Result<()> {
        let destination = self.skills_directory();
        if destination.join("core/SKILL.md").is_file() {
            return Ok(());
        }
        let archive_path = self.version_dir().join("source.tar.gz");
        let release = &self.releases.skill_data;
        download_atomic(&self.client, &release.url, &release.checksum, &archive_path).await?;
        tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
            let temporary =
                tempfile::tempdir_in(destination.parent().context("skills directory")?)?;
            let reader = flate2::read::GzDecoder::new(File::open(&archive_path)?);
            let mut archive = tar::Archive::new(std::io::Read::take(reader, 64 * 1024 * 1024));
            for entry in archive.entries()? {
                let mut entry = entry?;
                if !entry.header().entry_type().is_file() {
                    continue;
                }
                let path = entry.path()?.into_owned();
                let components: Vec<_> = path.components().collect();
                if components
                    .get(1)
                    .is_none_or(|component| component.as_os_str() != "skill-data")
                {
                    continue;
                }
                ensure!(
                    components
                        .iter()
                        .all(|component| matches!(component, std::path::Component::Normal(_))),
                    "Invalid upstream skill path"
                );
                let relative: PathBuf = components[2..].iter().collect();
                let target = temporary.path().join(relative);
                std::fs::create_dir_all(target.parent().context("skill file directory")?)?;
                std::io::copy(&mut entry, &mut File::create(target)?)?;
            }
            ensure!(
                temporary.path().join("core/SKILL.md").is_file(),
                "Upstream core browser skill is missing"
            );
            std::fs::rename(temporary.path(), destination)?;
            std::fs::remove_file(archive_path)?;
            Ok(())
        })
        .await??;
        Ok(())
    }

    /// Chromium discovery is left to agent-browser so Sprocket only installs Chromium when the
    /// CLI itself can't find a browser to launch.
    async fn ensure_chromium(&self, cli: &Path) -> anyhow::Result<()> {
        if std::env::var_os("AGENT_BROWSER_EXECUTABLE_PATH").is_some_and(|path| !path.is_empty())
            || chromium_installed(cli).await?
        {
            return Ok(());
        }
        let _lock = acquire_lock(self.tool_dir.join("chromium-install.lock")).await?;
        if chromium_installed(cli).await? {
            return Ok(());
        }
        let output = run(Command::new(cli).arg("install")).await?;
        ensure!(
            output.status.success(),
            "agent-browser install failed. Set AGENT_BROWSER_EXECUTABLE_PATH to an existing Chromium executable instead; Sprocket never runs sudo.\n{}\n{}",
            String::from_utf8_lossy(&output.stdout).trim(),
            String::from_utf8_lossy(&output.stderr).trim()
        );
        ensure!(
            chromium_installed(cli).await?,
            "agent-browser install finished but no Chromium executable was found"
        );
        Ok(())
    }
}

async fn chromium_installed(cli: &Path) -> anyhow::Result<bool> {
    #[derive(Deserialize)]
    struct Report {
        checks: Vec<Check>,
    }
    #[derive(Deserialize)]
    struct Check {
        id: String,
        status: String,
    }
    let output = run(Command::new(cli).args(["doctor", "--offline", "--quick", "--json"])).await?;
    let report: Report =
        serde_json::from_slice(&output.stdout).context("parse agent-browser doctor report")?;
    Ok(report
        .checks
        .iter()
        .any(|check| check.id == "chrome.installed" && check.status == "pass"))
}

async fn run(command: &mut Command) -> anyhow::Result<Output> {
    let output = command
        .env(AGENT_BROWSER_USE_SYSTEM_CA, "1")
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .output();
    let output = tokio::time::timeout(COMMAND_TIMEOUT, output)
        .await
        .context("agent-browser timed out")??;
    Ok(output)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Releases {
    agent_browser: Release,
    skill_data: SkillRelease,
}

#[derive(Deserialize)]
struct SkillRelease {
    url: String,
    #[serde(flatten)]
    checksum: Checksum,
}

#[derive(Deserialize)]
struct Release {
    version: String,
    repository: String,
    tag: String,
    platforms: BTreeMap<String, ReleaseAsset>,
}

#[derive(Deserialize)]
struct ReleaseAsset {
    asset: String,
    #[serde(flatten)]
    checksum: Checksum,
}

fn platform() -> anyhow::Result<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Ok("darwin-arm64"),
        ("macos", "x86_64") => Ok("darwin-x64"),
        ("linux", "aarch64") => Ok("linux-musl-arm64"),
        ("linux", "x86_64") => Ok("linux-musl-x64"),
        ("windows", "x86_64" | "aarch64") => Ok("win32-x64"),
        (os, arch) => bail!("No pinned agent-browser release for {os}/{arch}"),
    }
}

#[cfg(test)]
mod tests;
