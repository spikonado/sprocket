use std::fs::File;
use std::path::{Path, PathBuf};
use std::process::{Output, Stdio};
use std::time::Duration;

use anyhow::{Context, ensure};
use serde::Deserialize;
use tokio::process::Command;
use tokio::sync::Mutex;

use crate::tool_install::{
    Asset, INSTALL_LOCK, PinnedTool, acquire_lock, download_atomic, set_executable,
};

const RELEASES: &str = include_str!("../../../tools/agent-browser/releases.json");
const CLI: &str = if cfg!(windows) {
    "agent-browser.exe"
} else {
    "agent-browser"
};
const COMMAND_TIMEOUT: Duration = Duration::from_secs(10 * 60);
pub(crate) const AGENT_BROWSER_USE_SYSTEM_CA: &str = "AGENT_BROWSER_USE_SYSTEM_CA";

pub(crate) struct BrowserInstaller {
    tool: PinnedTool,
    skill_data: Asset,
    chromium_lock: PathBuf,
    ready: Mutex<bool>,
}

impl BrowserInstaller {
    pub fn new(data_dir: &Path) -> anyhow::Result<Self> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Releases {
            skill_data: Asset,
        }
        let tool = PinnedTool::new(data_dir, "agent-browser", RELEASES, unpack)?;
        Ok(Self {
            skill_data: serde_json::from_str::<Releases>(RELEASES)?.skill_data,
            chromium_lock: data_dir.join("tools/agent-browser/chromium-install.lock"),
            tool,
            ready: Mutex::new(false),
        })
    }

    /// Returns the CLI once it, its skills, and a Chromium it can launch are installed.
    pub async fn ensure_ready(&self) -> anyhow::Result<PathBuf> {
        let mut ready = self.ready.lock().await;
        self.tool.ensure_installed().await?;
        let cli = self.tool.bin_dir().join(CLI);
        if !*ready {
            self.ensure_skills().await?;
            self.ensure_chromium(&cli).await?;
            *ready = true;
        }
        Ok(cli)
    }

    pub fn bin_dir(&self) -> PathBuf {
        self.tool.bin_dir()
    }

    pub fn skills_directory(&self) -> PathBuf {
        self.tool.version_dir().join("skill-data")
    }

    /// The native CLI doesn't embed its skills, so `agent-browser skills get <name>` reads them
    /// from the release's source tree.
    async fn ensure_skills(&self) -> anyhow::Result<()> {
        let destination = self.skills_directory();
        let version_dir = self.tool.version_dir();
        let _lock = acquire_lock(version_dir.join(INSTALL_LOCK)).await?;
        if destination.join("core/SKILL.md").is_file() {
            return Ok(());
        }
        let archive_path = version_dir.join("source.tar.gz");
        let asset = &self.skill_data;
        download_atomic(
            self.tool.client(),
            &asset.url,
            &asset.checksum,
            &archive_path,
        )
        .await?;
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
        let _lock = acquire_lock(self.chromium_lock.clone()).await?;
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

/// Each release asset is the bare CLI.
fn unpack(download: &Path, bin: &Path) -> anyhow::Result<()> {
    let cli = bin.join(CLI);
    std::fs::copy(download, &cli)?;
    set_executable(&cli)?;
    Ok(())
}

#[cfg(test)]
mod tests;
