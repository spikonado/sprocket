//! Pinned, versioned tool installs under `<data-dir>/tools/<tool>/<version>/`.

use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, ensure};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;

const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const LOCK_TIMEOUT: Duration = Duration::from_secs(20 * 60);
pub(crate) const INSTALL_LOCK: &str = "install.lock";
pub(crate) const LEASE_LOCK: &str = "in-use.lock";
const TOMBSTONE_SUFFIX: &str = ".removing";

#[derive(Deserialize)]
pub(crate) struct Checksum {
    pub bytes: u64,
    pub sha256: String,
}

pub(crate) fn download_client() -> anyhow::Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .user_agent(concat!("sprocket/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(30))
        .timeout(DOWNLOAD_TIMEOUT)
        .build()?)
}

pub(crate) fn open_lock_file(path: &Path) -> std::io::Result<File> {
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
pub(crate) async fn lease_version(lease: &Mutex<Option<File>>, version_dir: &Path) {
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
pub(crate) fn prune_versions(tool_dir: &Path, current: &str) {
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

pub(crate) async fn verified_file(path: &Path, checksum: &Checksum) -> anyhow::Result<bool> {
    let mut file = match tokio::fs::File::open(path).await {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    if file.metadata().await?.len() != checksum.bytes || !executable_file(path).await {
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
    Ok(hex::encode(hash.finalize()) == checksum.sha256)
}

/// Publishes `url` at `destination` as an executable only once its size and SHA256 match.
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
            .context("publish verified download")?;
        #[cfg(unix)]
        File::open(destination.parent().context("install path has no parent")?)?.sync_all()?;
        Ok(())
    })
    .await??;
    Ok(())
}

pub(crate) async fn executable_file(path: &Path) -> bool {
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
