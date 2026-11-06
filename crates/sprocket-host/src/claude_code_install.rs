use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, bail};
use futures::future::BoxFuture;
use sprocket_agent::ClaudeCodeInstall;

use crate::tool_install::{PinnedTool, set_executable};

const CLAUDE: &str = if cfg!(windows) {
    "claude.exe"
} else {
    "claude"
};

/// Installed on a run's first use instead of at startup, since the package is about 150 MB.
pub(crate) struct ClaudeCodeInstaller(Arc<PinnedTool>);

impl ClaudeCodeInstaller {
    pub(crate) fn new(data_dir: &Path) -> anyhow::Result<Self> {
        Ok(Self(Arc::new(PinnedTool::new(
            data_dir,
            "claude-code",
            include_str!("../../../tools/claude-code/releases.json"),
            unpack,
        )?)))
    }
}

impl ClaudeCodeInstall for ClaudeCodeInstaller {
    fn executable(&self) -> BoxFuture<'_, anyhow::Result<PathBuf>> {
        let tool = Arc::clone(&self.0);
        Box::pin(async move {
            // A cancelled run shouldn't throw away a partly finished download.
            crate::run_to_completion(async move {
                let installed = tool.ensure_installed().await;
                installed.map(|()| tool.bin_dir().join(CLAUDE))
            })
            .await
            .context("Claude Code install task stopped.")?
        })
    }
}

fn unpack(archive: &Path, bin: &Path) -> anyhow::Result<()> {
    let entry_path = Path::new("package").join(CLAUDE);
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(File::open(archive)?));
    for entry in archive.entries()? {
        let mut entry = entry?;
        if entry.path()? == entry_path {
            let claude = bin.join(CLAUDE);
            entry.unpack(&claude)?;
            set_executable(&claude)?;
            return Ok(());
        }
    }
    bail!("Claude Code archive has no {}", entry_path.display())
}

#[cfg(test)]
mod tests;
