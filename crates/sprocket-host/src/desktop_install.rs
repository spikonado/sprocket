use std::fs::File;
use std::path::{Component, Path};
use std::sync::Arc;

use anyhow::{Context, bail, ensure};

use crate::bin_tool::{BinTool, BinToolSpec};

const CLI: &str = if cfg!(windows) {
    "agent-desktop.exe"
} else {
    "agent-desktop"
};

/// Installs the agent-desktop CLI with the platform helper that its release keeps beside it.
pub fn installer(data_dir: &Path) -> anyhow::Result<Arc<BinTool>> {
    BinTool::new(
        data_dir,
        BinToolSpec {
            name: "agent-desktop",
            releases_json: include_str!("../../../tools/agent-desktop/releases.json"),
            releases_key: "agentDesktop",
            // `extract` publishes `bin` by a rename.
            installed: CLI,
            extract,
        },
    )
}

/// Unpacks the archive's top-level files into a staging directory, then renames it to `bin`.
fn extract(archive: &Path, bin: &Path) -> anyhow::Result<()> {
    let staging = tempfile::tempdir_in(bin.parent().context("bin directory has no parent")?)?;
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(File::open(archive)?));
    for entry in archive.entries()? {
        let mut entry = entry?;
        if !entry.header().entry_type().is_file() {
            continue;
        }
        let path = entry.path()?.into_owned();
        let mut components = path
            .components()
            .filter(|component| *component != Component::CurDir);
        let (Some(Component::Normal(name)), None) = (components.next(), components.next()) else {
            bail!("Unexpected agent-desktop archive entry {}", path.display());
        };
        let target = staging.path().join(name);
        entry.unpack(&target)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755))?;
        }
    }
    ensure!(
        staging.path().join(CLI).is_file(),
        "agent-desktop archive has no {CLI}"
    );
    if bin.exists() {
        std::fs::remove_dir_all(bin)?;
    }
    std::fs::rename(staging.path(), bin)?;
    Ok(())
}

#[cfg(test)]
mod tests;
