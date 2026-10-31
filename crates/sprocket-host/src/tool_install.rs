//! Pinned tools installed under `<data-dir>/tools/<tool>/<version>/bin`, which agents get on
//! their `PATH`.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, bail, ensure};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const LOCK_TIMEOUT: Duration = Duration::from_secs(20 * 60);
pub(crate) const INSTALL_LOCK: &str = "install.lock";
const LEASE_LOCK: &str = "in-use.lock";
const TOMBSTONE_SUFFIX: &str = ".removing";

/// Unpacks the verified download at the first path into the empty directory at the second.
pub(crate) type Unpack = fn(&Path, &Path) -> anyhow::Result<()>;

pub(crate) struct PinnedTool {
    name: &'static str,
    unpack: Unpack,
    tool_dir: PathBuf,
    release: Release,
    client: reqwest::Client,
    ready: Mutex<bool>,
    lease: Mutex<Option<File>>,
}

impl PinnedTool {
    pub(crate) fn new(
        data_dir: &Path,
        name: &'static str,
        releases_json: &str,
        unpack: Unpack,
    ) -> anyhow::Result<Self> {
        Ok(Self {
            name,
            unpack,
            tool_dir: data_dir.join("tools").join(name),
            release: serde_json::from_str(releases_json)?,
            client: download_client()?,
            ready: Mutex::new(false),
            lease: Mutex::new(None),
        })
    }

    pub fn prepare(self: &Arc<Self>) {
        let tool = Arc::clone(self);
        tokio::spawn(async move {
            if let Err(error) = tool.ensure_installed().await {
                tracing::warn!("{} setup failed: {error:#}", tool.name);
            }
        });
    }

    pub(crate) fn version_dir(&self) -> PathBuf {
        self.tool_dir.join(&self.release.version)
    }

    pub fn bin_dir(&self) -> PathBuf {
        self.version_dir().join("bin")
    }

    pub(crate) fn client(&self) -> &reqwest::Client {
        &self.client
    }

    pub(crate) async fn ensure_installed(&self) -> anyhow::Result<()> {
        let mut ready = self.ready.lock().await;
        let bin = self.bin_dir();
        if *ready && is_dir(&bin).await {
            return Ok(());
        }
        let name = self.name;
        let asset = self
            .release
            .platforms
            .get(platform()?)
            .with_context(|| format!("missing pinned {name} release"))?;
        let version_dir = self.version_dir();
        tokio::fs::create_dir_all(&version_dir).await?;
        let _lock = acquire_lock(version_dir.join(INSTALL_LOCK)).await?;
        if !is_dir(&bin).await {
            let download = version_dir.join("download");
            download_atomic(&self.client, &asset.url, &asset.checksum, &download).await?;
            let (staging_parent, unpack) = (version_dir.clone(), self.unpack);
            tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
                let staging = tempfile::tempdir_in(staging_parent)?;
                unpack(&download, staging.path())?;
                // Publishing `bin` by a rename means it exists only once fully unpacked.
                std::fs::rename(staging.path(), &bin)?;
                std::fs::remove_file(&download)?;
                Ok(())
            })
            .await??;
        }
        lease_version(&self.lease, &version_dir).await;
        let tool_dir = self.tool_dir.clone();
        let current = self.release.version.clone();
        if let Err(error) =
            tokio::task::spawn_blocking(move || prune_versions(&tool_dir, &current)).await
        {
            tracing::warn!("Old {name} cleanup failed: {error}");
        }
        *ready = true;
        Ok(())
    }
}

/// The platform keys of every `releases.json`.
fn platform() -> anyhow::Result<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Ok("darwin-arm64"),
        ("macos", "x86_64") => Ok("darwin-x64"),
        ("linux", "aarch64") => Ok("linux-arm64"),
        ("linux", "x86_64") => Ok("linux-x64"),
        ("windows", "aarch64") => Ok("win32-arm64"),
        ("windows", "x86_64") => Ok("win32-x64"),
        (os, arch) => bail!("No pinned release for {os}/{arch}"),
    }
}

async fn is_dir(path: &Path) -> bool {
    tokio::fs::metadata(path)
        .await
        .is_ok_and(|metadata| metadata.is_dir())
}

#[derive(Deserialize)]
struct Release {
    version: String,
    platforms: BTreeMap<String, Asset>,
}

#[derive(Deserialize)]
pub(crate) struct Asset {
    pub url: String,
    #[serde(flatten)]
    pub checksum: Checksum,
}

#[derive(Deserialize)]
pub(crate) struct Checksum {
    pub bytes: u64,
    pub sha256: String,
}

fn download_client() -> anyhow::Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .user_agent(concat!("sprocket/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(30))
        .timeout(DOWNLOAD_TIMEOUT)
        .build()?)
}

/// Puts `directories` ahead of the `PATH` in `environment`, or of the server's own `PATH`.
pub(crate) fn prepend_path(
    environment: Vec<(OsString, OsString)>,
    directories: impl IntoIterator<Item = PathBuf>,
) -> Vec<(OsString, OsString)> {
    rewrite_path(environment, |inherited| {
        directories.into_iter().chain(inherited).collect()
    })
}

/// Puts `directories` after the `PATH` so the user's own tools win, but ahead of Windows'
/// Microsoft Store aliases, whose `python` only opens the Store.
pub(crate) fn append_path(
    environment: Vec<(OsString, OsString)>,
    directories: impl IntoIterator<Item = PathBuf>,
) -> Vec<(OsString, OsString)> {
    rewrite_path(environment, |mut paths| {
        let at = paths
            .iter()
            .position(|path| is_store_aliases(path))
            .unwrap_or(paths.len());
        paths.splice(at..at, directories);
        paths
    })
}

fn is_store_aliases(path: &Path) -> bool {
    cfg!(windows)
        && path
            .to_string_lossy()
            .to_ascii_lowercase()
            .trim_end_matches(['\\', '/'])
            .ends_with(r"microsoft\windowsapps")
}

/// Rewrites the `PATH` in `environment`, or the server's own `PATH`.
fn rewrite_path(
    mut environment: Vec<(OsString, OsString)>,
    rewrite: impl FnOnce(Vec<PathBuf>) -> Vec<PathBuf>,
) -> Vec<(OsString, OsString)> {
    let inherited = environment
        .iter()
        .position(|(key, _)| key == "PATH")
        .map(|index| environment.remove(index).1)
        .or_else(|| std::env::var_os("PATH"));
    let paths = inherited
        .as_deref()
        .map(|path| std::env::split_paths(path).collect())
        .unwrap_or_default();
    match std::env::join_paths(rewrite(paths)) {
        Ok(path) => environment.push(("PATH".into(), path)),
        Err(error) => {
            tracing::warn!("Couldn't extend PATH: {error}");
            environment.extend(inherited.map(|path| ("PATH".into(), path)));
        }
    }
    environment
}

pub(crate) fn set_executable(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn open_lock_file(path: &Path) -> std::io::Result<File> {
    OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)
}

pub(crate) async fn acquire_lock(path: PathBuf) -> anyhow::Result<File> {
    let file = tokio::task::spawn_blocking(move || open_lock_file(&path)).await??;
    let deadline = tokio::time::Instant::now() + LOCK_TIMEOUT;
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(file),
            Err(std::fs::TryLockError::WouldBlock) => {
                ensure!(
                    tokio::time::Instant::now() < deadline,
                    "Tool installation lock timed out; retry setup"
                );
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            Err(std::fs::TryLockError::Error(error)) => return Err(error.into()),
        }
    }
}

/// Holds a shared lock on `version_dir` for the server's lifetime so that other
/// Sprocket versions sharing this data directory don't prune it.
async fn lease_version(lease: &Mutex<Option<File>>, version_dir: &Path) {
    let mut lease = lease.lock().await;
    if lease.is_some() {
        return;
    }
    let path = version_dir.join(LEASE_LOCK);
    let result = tokio::task::spawn_blocking(move || -> std::io::Result<File> {
        let file = open_lock_file(&path)?;
        file.lock_shared()?;
        Ok(file)
    })
    .await
    .map_err(std::io::Error::other)
    .and_then(|result| result);
    match result {
        Ok(file) => *lease = Some(file),
        Err(error) => tracing::warn!("Couldn't lease {}: {error}", version_dir.display()),
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

/// Publishes `url` at `destination` only once its size and SHA256 match.
pub(crate) async fn download_atomic(
    client: &reqwest::Client,
    url: &str,
    checksum: &Checksum,
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
            length == checksum.bytes,
            "Pinned release size mismatch for {url}"
        );
    }
    let mut hash = Sha256::new();
    let mut downloaded = 0u64;
    while let Some(chunk) = response.chunk().await? {
        downloaded += chunk.len() as u64;
        ensure!(
            downloaded <= checksum.bytes,
            "Pinned release exceeds expected size for {url}"
        );
        hash.update(&chunk);
        file.write_all(&chunk).await?;
    }
    ensure!(
        downloaded == checksum.bytes,
        "Incomplete pinned release download for {url}"
    );
    ensure!(
        hex::encode(hash.finalize()) == checksum.sha256,
        "Pinned release SHA256 mismatch for {url}"
    );
    file.flush().await?;
    drop(file);
    let destination = destination.to_owned();
    tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        temporary.as_file().sync_all()?;
        temporary
            .persist(&destination)
            .context("publish verified download")?;
        #[cfg(unix)]
        File::open(destination.parent().context("install path has no parent")?)?.sync_all()?;
        Ok(())
    })
    .await??;
    Ok(())
}

#[cfg(test)]
pub(crate) mod test_support;
#[cfg(test)]
mod tests;
