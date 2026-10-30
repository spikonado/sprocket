use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, bail};
use serde::Deserialize;
use tokio::sync::Mutex;

use crate::tool_install::{
    Checksum, INSTALL_LOCK, acquire_lock, download_atomic, download_client, executable_file,
    lease_version, prune_versions,
};

const RELEASES: &str = include_str!("../../../tools/bun/releases.json");
const BUN: &str = if cfg!(windows) { "bun.exe" } else { "bun" };
const BUNX: &str = if cfg!(windows) { "bunx.exe" } else { "bunx" };

pub struct BunInstaller {
    tool_dir: PathBuf,
    release: Release,
    client: reqwest::Client,
    ready: Mutex<bool>,
    lease: Mutex<Option<File>>,
}

impl BunInstaller {
    pub fn new(data_dir: &Path) -> anyhow::Result<Arc<Self>> {
        let releases: Releases = serde_json::from_str(RELEASES)?;
        Ok(Arc::new(Self {
            tool_dir: data_dir.join("tools/bun"),
            release: releases.bun,
            client: download_client()?,
            ready: Mutex::new(false),
            lease: Mutex::new(None),
        }))
    }

    pub fn prepare(self: &Arc<Self>) {
        let installer = Arc::clone(self);
        tokio::spawn(async move {
            if let Err(error) = installer.ensure_ready().await {
                tracing::warn!("Bun setup failed: {error:#}");
            }
        });
    }

    /// Puts `bun` and `bunx` ahead of the inherited `PATH`.
    pub fn environment(&self, inherited: Vec<(OsString, OsString)>) -> Vec<(OsString, OsString)> {
        let mut environment = inherited;
        let inherited_path = environment
            .iter()
            .position(|(key, _)| key == "PATH")
            .map(|index| environment.remove(index).1)
            .or_else(|| std::env::var_os("PATH"));
        let mut paths = vec![self.bin_directory()];
        if let Some(path) = inherited_path {
            paths.extend(std::env::split_paths(&path));
        }
        match std::env::join_paths(paths) {
            Ok(path) => environment.push(("PATH".into(), path)),
            Err(error) => tracing::warn!("Couldn't add Bun to PATH: {error}"),
        }
        environment
    }

    fn version_dir(&self) -> PathBuf {
        self.tool_dir.join(&self.release.version)
    }

    fn bin_directory(&self) -> PathBuf {
        self.version_dir().join("bin")
    }

    async fn ensure_ready(&self) -> anyhow::Result<()> {
        let mut ready = self.ready.lock().await;
        let bin = self.bin_directory();
        // `bunx` is written last, so its presence means the install finished.
        let bunx = bin.join(BUNX);
        if *ready && executable_file(&bunx).await {
            return Ok(());
        }
        let asset = self
            .release
            .platforms
            .get(platform()?)
            .context("missing pinned Bun release")?;
        tokio::fs::create_dir_all(&bin).await?;
        let _lock = acquire_lock(self.version_dir().join(INSTALL_LOCK)).await?;
        if !executable_file(&bunx).await {
            let archive = self.version_dir().join("bun.tgz");
            download_atomic(&self.client, &asset.url, &asset.checksum, &archive).await?;
            let (archive_path, bin_path) = (archive.clone(), bin.clone());
            tokio::task::spawn_blocking(move || extract(&archive_path, &bin_path)).await??;
            tokio::fs::remove_file(&archive).await?;
        }
        lease_version(&self.lease, &self.version_dir()).await;
        let tool_dir = self.tool_dir.clone();
        let current = self.release.version.clone();
        if let Err(error) =
            tokio::task::spawn_blocking(move || prune_versions(&tool_dir, &current)).await
        {
            tracing::warn!("Old Bun cleanup failed: {error}");
        }
        *ready = true;
        Ok(())
    }
}

/// Extracts `bun` from its npm package tarball and links `bunx` to it, as Bun's own installer does.
fn extract(archive: &Path, bin: &Path) -> anyhow::Result<()> {
    let entry_path = Path::new("package/bin").join(BUN);
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(File::open(archive)?));
    for entry in archive.entries()? {
        let mut entry = entry?;
        if entry.path()? != entry_path {
            continue;
        }
        let mut temporary = tempfile::NamedTempFile::new_in(bin)?;
        std::io::copy(&mut entry, &mut temporary)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            temporary
                .as_file()
                .set_permissions(std::fs::Permissions::from_mode(0o755))?;
        }
        let bun = bin.join(BUN);
        temporary.persist(&bun)?;
        let bunx = bin.join(BUNX);
        if let Err(error) = std::fs::remove_file(&bunx)
            && error.kind() != std::io::ErrorKind::NotFound
        {
            return Err(error.into());
        }
        std::fs::hard_link(&bun, &bunx)?;
        return Ok(());
    }
    bail!("Bun archive has no {}", entry_path.display())
}

fn platform() -> anyhow::Result<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Ok("darwin-arm64"),
        ("macos", "x86_64") => Ok("darwin-x64"),
        ("linux", "aarch64") => Ok("linux-arm64"),
        ("linux", "x86_64") => Ok("linux-x64"),
        ("windows", "aarch64") => Ok("win32-arm64"),
        ("windows", "x86_64") => Ok("win32-x64"),
        (os, arch) => bail!("No pinned Bun release for {os}/{arch}"),
    }
}

#[derive(Deserialize)]
struct Releases {
    bun: Release,
}

#[derive(Deserialize)]
struct Release {
    version: String,
    platforms: BTreeMap<String, Asset>,
}

#[derive(Deserialize)]
struct Asset {
    url: String,
    #[serde(flatten)]
    checksum: Checksum,
}

#[cfg(test)]
mod tests;
