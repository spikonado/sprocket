use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};
use std::process::{Output, Stdio};
use std::time::Duration;

use anyhow::{Context, bail, ensure};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::sync::Mutex;

const RELEASES: &str = include_str!("../../../tools/agent-browser/releases.json");
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const INSTALL_LOCK: &str = "install.lock";
const LEASE_LOCK: &str = "in-use.lock";
const TOMBSTONE_SUFFIX: &str = ".removing";
const LIGHTPANDA_UNSUPPORTED: &str =
    "Lightpanda can't run on this host; its Linux builds need glibc";

pub(crate) struct BrowserInstaller {
    tools_dir: PathBuf,
    releases: Releases,
    client: reqwest::Client,
    ready_cli: Mutex<Option<PathBuf>>,
    ready_lightpanda: Mutex<Option<PathBuf>>,
    leases: Mutex<BTreeMap<&'static str, File>>,
}

impl BrowserInstaller {
    pub fn new(data_dir: &Path) -> anyhow::Result<Self> {
        Ok(Self {
            tools_dir: data_dir.join("tools"),
            releases: serde_json::from_str(RELEASES)?,
            client: reqwest::Client::builder()
                .user_agent(concat!("sprocket/", env!("CARGO_PKG_VERSION")))
                .connect_timeout(Duration::from_secs(30))
                .timeout(DOWNLOAD_TIMEOUT)
                .build()?,
            ready_cli: Mutex::new(None),
            ready_lightpanda: Mutex::new(None),
            leases: Mutex::new(BTreeMap::new()),
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

    /// Lightpanda is large, so it's only installed when a dashboard session asks for it.
    pub async fn ensure_lightpanda(&self) -> anyhow::Result<()> {
        let mut ready = self.ready_lightpanda.lock().await;
        if let Some(path) = ready.as_ref()
            && executable_file(path).await
        {
            return Ok(());
        }
        let (path, _lock) = self.install_tool(Tool::Lightpanda).await?;
        let output = run(Command::new(&path).arg("version"))
            .await
            .context(LIGHTPANDA_UNSUPPORTED)?;
        ensure!(
            output.status.success(),
            "{LIGHTPANDA_UNSUPPORTED}\n{}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
        self.finish_install(Tool::Lightpanda).await;
        *ready = Some(path);
        Ok(())
    }

    fn release(&self, tool: Tool) -> &Release {
        match tool {
            Tool::AgentBrowser => &self.releases.agent_browser,
            Tool::Lightpanda => &self.releases.lightpanda,
        }
    }

    fn version_dir(&self, tool: Tool) -> PathBuf {
        self.tools_dir
            .join(tool.name())
            .join(&self.release(tool).version)
    }

    fn executable_directory(&self, tool: Tool) -> anyhow::Result<PathBuf> {
        Ok(self.version_dir(tool).join(tool.platform()?))
    }

    pub fn cli_directory(&self) -> anyhow::Result<PathBuf> {
        self.executable_directory(Tool::AgentBrowser)
    }

    /// agent-browser looks Lightpanda up on `PATH`, so this directory is listed before it exists.
    pub fn lightpanda_directory(&self) -> Option<PathBuf> {
        self.executable_directory(Tool::Lightpanda).ok()
    }

    pub fn skills_directory(&self) -> PathBuf {
        self.version_dir(Tool::AgentBrowser).join("skill-data")
    }

    async fn install(&self) -> anyhow::Result<PathBuf> {
        let (cli, _lock) = self.install_tool(Tool::AgentBrowser).await?;
        self.ensure_skills().await?;
        self.finish_install(Tool::AgentBrowser).await;
        Ok(cli)
    }

    /// Returns the verified executable along with the version's install lock.
    async fn install_tool(&self, tool: Tool) -> anyhow::Result<(PathBuf, File)> {
        let release = self.release(tool);
        let asset = release
            .platforms
            .get(tool.platform()?)
            .context("missing pinned release")?;
        let directory = self.executable_directory(tool)?;
        tokio::fs::create_dir_all(&directory).await?;
        let lock = acquire_lock(self.version_dir(tool).join(INSTALL_LOCK)).await?;
        let executable = directory.join(tool.executable());
        if !verified_file(&executable, asset).await? {
            let url = format!(
                "https://github.com/{}/releases/download/{}/{}",
                release.repository, release.tag, asset.asset
            );
            download_atomic(&self.client, &url, asset, &executable).await?;
        }
        Ok((executable, lock))
    }

    async fn finish_install(&self, tool: Tool) {
        self.lease_version(tool).await;
        let tool_dir = self.tools_dir.join(tool.name());
        let current = self.release(tool).version.clone();
        if let Err(error) =
            tokio::task::spawn_blocking(move || prune_versions(&tool_dir, &current)).await
        {
            tracing::warn!("Old {} cleanup failed: {error}", tool.name());
        }
    }

    /// The native CLI doesn't embed its skills, so `agent-browser skills get <name>` reads them
    /// from the release's source tree.
    async fn ensure_skills(&self) -> anyhow::Result<()> {
        let destination = self.skills_directory();
        if destination.join("core/SKILL.md").is_file() {
            return Ok(());
        }
        let archive = self.version_dir(Tool::AgentBrowser).join("source.tar.gz");
        let release = &self.releases.skill_data;
        download_atomic(&self.client, &release.url, &release.asset, &archive).await?;
        tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
            let temporary =
                tempfile::tempdir_in(destination.parent().context("skills directory")?)?;
            let reader = flate2::read::GzDecoder::new(File::open(archive)?);
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
            Ok(())
        })
        .await??;
        Ok(())
    }

    /// Holds a shared lock on the pinned version for the server's lifetime so that other
    /// Sprocket versions sharing this data directory don't prune it.
    async fn lease_version(&self, tool: Tool) {
        let mut leases = self.leases.lock().await;
        if leases.contains_key(tool.name()) {
            return;
        }
        let path = self.version_dir(tool).join(LEASE_LOCK);
        let result = tokio::task::spawn_blocking(move || -> std::io::Result<File> {
            let file = open_lock_file(&path)?;
            file.lock_shared()?;
            Ok(file)
        })
        .await
        .map_err(std::io::Error::other)
        .and_then(|result| result);
        match result {
            Ok(file) => {
                leases.insert(tool.name(), file);
            }
            Err(error) => tracing::warn!("Couldn't lease {}: {error}", tool.name()),
        }
    }

    /// Chromium discovery is left to agent-browser so Sprocket only installs Chromium when the
    /// CLI itself can't find a browser to launch.
    async fn ensure_chromium(&self, cli: &Path) -> anyhow::Result<()> {
        if std::env::var_os("AGENT_BROWSER_EXECUTABLE_PATH").is_some_and(|path| !path.is_empty())
            || chromium_installed(cli).await?
        {
            return Ok(());
        }
        let _lock = acquire_lock(
            self.tools_dir
                .join(Tool::AgentBrowser.name())
                .join("chromium-install.lock"),
        )
        .await?;
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
    let output = command.stdin(Stdio::null()).kill_on_drop(true).output();
    let output = tokio::time::timeout(COMMAND_TIMEOUT, output)
        .await
        .context("browser tool timed out")??;
    Ok(output)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Releases {
    agent_browser: Release,
    lightpanda: Release,
    skill_data: SkillRelease,
}

#[derive(Deserialize)]
struct SkillRelease {
    url: String,
    #[serde(flatten)]
    asset: ReleaseAsset,
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
    bytes: u64,
    sha256: String,
}

#[derive(Clone, Copy)]
enum Tool {
    AgentBrowser,
    Lightpanda,
}

impl Tool {
    fn name(self) -> &'static str {
        match self {
            Self::AgentBrowser => "agent-browser",
            Self::Lightpanda => "lightpanda",
        }
    }

    fn executable(self) -> &'static str {
        match self {
            Self::AgentBrowser if cfg!(windows) => "agent-browser.exe",
            tool => tool.name(),
        }
    }

    fn platform(self) -> anyhow::Result<&'static str> {
        match (self, std::env::consts::OS, std::env::consts::ARCH) {
            (_, "macos", "aarch64") => Ok("darwin-arm64"),
            (_, "macos", "x86_64") => Ok("darwin-x64"),
            (Self::AgentBrowser, "linux", "aarch64") => Ok("linux-musl-arm64"),
            (Self::AgentBrowser, "linux", "x86_64") => Ok("linux-musl-x64"),
            (Self::AgentBrowser, "windows", "x86_64" | "aarch64") => Ok("win32-x64"),
            (Self::Lightpanda, "linux", "aarch64") => Ok("linux-arm64"),
            (Self::Lightpanda, "linux", "x86_64") => Ok("linux-x64"),
            (tool, os, arch) => bail!("No pinned {} release for {os}/{arch}", tool.name()),
        }
    }
}

fn open_lock_file(path: &Path) -> std::io::Result<File> {
    OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)
}

async fn acquire_lock(path: PathBuf) -> anyhow::Result<File> {
    let file = tokio::task::spawn_blocking(move || open_lock_file(&path)).await??;
    let deadline = tokio::time::Instant::now() + COMMAND_TIMEOUT + DOWNLOAD_TIMEOUT;
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(file),
            Err(std::fs::TryLockError::WouldBlock) => {
                ensure!(
                    tokio::time::Instant::now() < deadline,
                    "Browser installation lock timed out; retry setup"
                );
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            Err(std::fs::TryLockError::Error(error)) => return Err(error.into()),
        }
    }
}

/// Removes other versions along with tombstones left by earlier failed removals.
/// A version is skipped while an installer or a lease holds one of its locks.
fn prune_versions(tool_dir: &Path, current: &str) {
    let entries = match std::fs::read_dir(tool_dir) {
        Ok(entries) => entries,
        Err(error) => {
            tracing::warn!("Couldn't list {}: {error}", tool_dir.display());
            return;
        }
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if !entry.file_type().is_ok_and(|file_type| file_type.is_dir()) {
            continue;
        }
        let result = if name.starts_with('.') && name.ends_with(TOMBSTONE_SUFFIX) {
            std::fs::remove_dir_all(&path)
        } else if name != current && is_version(&name) {
            remove_version(tool_dir, &name, &path)
        } else {
            continue;
        };
        if let Err(error) = result {
            tracing::warn!("Couldn't remove {}: {error}", path.display());
        }
    }
}

fn remove_version(tool_dir: &Path, name: &str, path: &Path) -> std::io::Result<()> {
    let mut locks = Vec::new();
    for lock in [INSTALL_LOCK, LEASE_LOCK] {
        let file = open_lock_file(&path.join(lock))?;
        match file.try_lock() {
            Ok(()) => locks.push(file),
            Err(std::fs::TryLockError::WouldBlock) => {
                tracing::info!("Keeping {} while it is in use", path.display());
                return Ok(());
            }
            Err(std::fs::TryLockError::Error(error)) => return Err(error),
        }
    }
    // Renaming first keeps a partial removal from looking like an installed version.
    // Windows refuses the rename while files inside are open, including running
    // executables and our own locks; on Unix, running processes keep their unlinked files.
    let tombstone = tool_dir.join(format!(".{name}.{}{TOMBSTONE_SUFFIX}", std::process::id()));
    #[cfg(windows)]
    drop(locks);
    std::fs::rename(path, &tombstone)?;
    #[cfg(not(windows))]
    drop(locks);
    std::fs::remove_dir_all(tombstone)
}

fn is_version(name: &str) -> bool {
    name.starts_with(|character: char| character.is_ascii_digit())
        && name.contains('.')
        && name.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '+')
        })
}

async fn verified_file(path: &Path, asset: &ReleaseAsset) -> anyhow::Result<bool> {
    let mut file = match tokio::fs::File::open(path).await {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    if file.metadata().await?.len() != asset.bytes || !executable_file(path).await {
        return Ok(false);
    }
    let mut hash = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
    }
    Ok(hex::encode(hash.finalize()) == asset.sha256)
}

async fn download_atomic(
    client: &reqwest::Client,
    url: &str,
    asset: &ReleaseAsset,
    destination: &Path,
) -> anyhow::Result<()> {
    let parent = destination.parent().context("install path has no parent")?;
    let temporary = tempfile::NamedTempFile::new_in(parent)?;
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .open(temporary.path())
        .await?;
    let mut response = client.get(url).send().await?.error_for_status()?;
    if let Some(length) = response.content_length() {
        ensure!(
            length == asset.bytes,
            "Pinned release size mismatch for {url}"
        );
    }
    let mut hash = Sha256::new();
    let mut downloaded = 0u64;
    while let Some(chunk) = response.chunk().await? {
        downloaded += chunk.len() as u64;
        ensure!(
            downloaded <= asset.bytes,
            "Pinned release exceeds expected size for {url}"
        );
        hash.update(&chunk);
        file.write_all(&chunk).await?;
    }
    ensure!(
        downloaded == asset.bytes,
        "Incomplete pinned release download for {url}"
    );
    ensure!(
        hex::encode(hash.finalize()) == asset.sha256,
        "Pinned release SHA256 mismatch for {url}"
    );
    file.flush().await?;
    drop(file);
    let destination = destination.to_owned();
    tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            temporary
                .as_file()
                .set_permissions(std::fs::Permissions::from_mode(0o755))?;
        }
        temporary.as_file().sync_all()?;
        temporary
            .persist(&destination)
            .context("publish verified executable")?;
        #[cfg(unix)]
        File::open(destination.parent().context("install path has no parent")?)?.sync_all()?;
        Ok(())
    })
    .await??;
    Ok(())
}

async fn executable_file(path: &Path) -> bool {
    let Ok(metadata) = tokio::fs::metadata(path).await else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests;
