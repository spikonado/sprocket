use std::fs::File;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, ensure};
use tokio::sync::Mutex;

use crate::tool_install::{PinnedTool, set_executable};

const PYTHON_VERSION: &str = "3.12";
const PYTHON_INSTALL_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const UV_EXECUTABLES: [&str; 3] = ["uv", "uvx", "uvw"];

/// Pinned uv plus a uv-managed Python, which agents get after the user's own on their `PATH`.
pub(crate) struct PythonTools {
    uv: PinnedTool,
    python_dir: PathBuf,
    ready: Mutex<bool>,
}

impl PythonTools {
    pub(crate) fn new(data_dir: &Path) -> anyhow::Result<Self> {
        Ok(Self {
            uv: PinnedTool::new(
                data_dir,
                "uv",
                include_str!("../../../tools/uv/releases.json"),
                unpack,
            )?,
            python_dir: data_dir.join("tools").join("python"),
            ready: Mutex::new(false),
        })
    }

    pub fn prepare(self: &Arc<Self>) {
        let tools = Arc::clone(self);
        tokio::spawn(async move {
            if let Err(error) = tools.ensure_installed().await {
                tracing::warn!("Python setup failed: {error:#}");
            }
        });
    }

    pub fn bin_dirs(&self) -> [PathBuf; 2] {
        [self.uv.bin_dir(), self.python_bin_dir()]
    }

    fn python_bin_dir(&self) -> PathBuf {
        self.python_dir.join("bin")
    }

    async fn ensure_installed(&self) -> anyhow::Result<()> {
        let mut ready = self.ready.lock().await;
        let python = self
            .python_bin_dir()
            .join(format!("python{}", std::env::consts::EXE_SUFFIX));
        if *ready && tokio::fs::metadata(&python).await.is_ok() {
            return Ok(());
        }
        self.uv.ensure_installed().await?;
        let uv = self
            .uv
            .bin_dir()
            .join(format!("uv{}", std::env::consts::EXE_SUFFIX));
        // uv locks its install dir, so concurrent servers sharing the data dir are safe.
        let install = tokio::process::Command::new(uv)
            .args(["python", "install", PYTHON_VERSION, "--default"])
            .args(["--no-registry", "--no-config", "--install-dir"])
            .arg(self.python_dir.join("installs"))
            .env("UV_PYTHON_BIN_DIR", self.python_bin_dir())
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .output();
        let output = tokio::time::timeout(PYTHON_INSTALL_TIMEOUT, install)
            .await
            .context("uv python install timed out")??;
        ensure!(
            output.status.success(),
            "uv python install exited with {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        );
        *ready = true;
        Ok(())
    }
}

/// Puts uv's executables from its release archive, a `.zip` on Windows, directly in `bin`.
fn unpack(archive: &Path, bin: &Path) -> anyhow::Result<()> {
    if cfg!(windows) {
        unpack_zip(archive, bin)?;
    } else {
        unpack_tar_gz(archive, bin)?;
    }
    let uv = format!("uv{}", std::env::consts::EXE_SUFFIX);
    ensure!(bin.join(&uv).is_file(), "uv archive has no {uv}");
    Ok(())
}

fn uv_executable(path: &Path) -> Option<&std::ffi::OsStr> {
    let name = path.file_name()?;
    let stem = name.to_str()?.strip_suffix(std::env::consts::EXE_SUFFIX)?;
    UV_EXECUTABLES.contains(&stem).then_some(name)
}

fn unpack_tar_gz(archive: &Path, bin: &Path) -> anyhow::Result<()> {
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(File::open(archive)?));
    for entry in archive.entries()? {
        let mut entry = entry?;
        if !entry.header().entry_type().is_file() {
            continue;
        }
        let path = entry.path()?.into_owned();
        if let Some(name) = uv_executable(&path) {
            let target = bin.join(name);
            entry.unpack(&target)?;
            set_executable(&target)?;
        }
    }
    Ok(())
}

fn unpack_zip(archive: &Path, bin: &Path) -> anyhow::Result<()> {
    let mut archive = zip::ZipArchive::new(File::open(archive)?)?;
    for index in 0..archive.len() {
        let mut file = archive.by_index(index)?;
        if !file.is_file() {
            continue;
        }
        let name = uv_executable(Path::new(&*file.name()?)).map(ToOwned::to_owned);
        if let Some(name) = name {
            std::io::copy(&mut file, &mut File::create(bin.join(name))?)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
