//! Pinned tools whose release unpacks into `<version>/bin`, which agents get on their `PATH`.

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
    lease_version, prepend_path, prune_versions,
};

pub(crate) struct BinToolSpec {
    /// The directory under `<data-dir>/tools`.
    pub name: &'static str,
    pub releases_json: &'static str,
    pub releases_key: &'static str,
    /// A file in `bin` that exists only once `extract` has finished.
    pub installed: &'static str,
    /// Unpacks the archive at the first path into `bin` at the second.
    pub extract: fn(&Path, &Path) -> anyhow::Result<()>,
}

pub struct BinTool {
    spec: BinToolSpec,
    tool_dir: PathBuf,
    release: Release,
    client: reqwest::Client,
    ready: Mutex<bool>,
    lease: Mutex<Option<File>>,
}

impl BinTool {
    pub(crate) fn new(data_dir: &Path, spec: BinToolSpec) -> anyhow::Result<Arc<Self>> {
        let mut releases: BTreeMap<String, Release> = serde_json::from_str(spec.releases_json)?;
        let release = releases
            .remove(spec.releases_key)
            .with_context(|| format!("no pinned {} release", spec.name))?;
        Ok(Arc::new(Self {
            tool_dir: data_dir.join("tools").join(spec.name),
            release,
            client: download_client()?,
            ready: Mutex::new(false),
            lease: Mutex::new(None),
            spec,
        }))
    }

    pub fn prepare(self: &Arc<Self>) {
        let tool = Arc::clone(self);
        tokio::spawn(async move {
            if let Err(error) = tool.ensure_ready().await {
                tracing::warn!("{} setup failed: {error:#}", tool.spec.name);
            }
        });
    }

    pub fn environment(&self, inherited: Vec<(OsString, OsString)>) -> Vec<(OsString, OsString)> {
        prepend_path(inherited, self.bin_directory())
    }

    fn version_dir(&self) -> PathBuf {
        self.tool_dir.join(&self.release.version)
    }

    fn bin_directory(&self) -> PathBuf {
        self.version_dir().join("bin")
    }

    async fn ensure_ready(&self) -> anyhow::Result<()> {
        let mut ready = self.ready.lock().await;
        let name = self.spec.name;
        let bin = self.bin_directory();
        let installed = bin.join(self.spec.installed);
        if *ready && executable_file(&installed).await {
            return Ok(());
        }
        let asset = self
            .release
            .platforms
            .get(platform()?)
            .with_context(|| format!("missing pinned {name} release"))?;
        let version_dir = self.version_dir();
        tokio::fs::create_dir_all(&version_dir).await?;
        let _lock = acquire_lock(version_dir.join(INSTALL_LOCK)).await?;
        if !executable_file(&installed).await {
            let archive = version_dir.join(format!("{name}.tar.gz"));
            download_atomic(&self.client, &asset.url, &asset.checksum, &archive).await?;
            let (archive_path, extract) = (archive.clone(), self.spec.extract);
            tokio::task::spawn_blocking(move || extract(&archive_path, &bin)).await??;
            tokio::fs::remove_file(&archive).await?;
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
