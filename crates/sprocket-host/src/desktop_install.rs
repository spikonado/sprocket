use std::fs::File;
use std::path::{Component, Path};

use anyhow::{bail, ensure};

use crate::tool_install::{PinnedTool, set_executable};

const CLI: &str = if cfg!(windows) {
    "agent-desktop.exe"
} else {
    "agent-desktop"
};

pub(crate) fn installer(data_dir: &Path) -> anyhow::Result<PinnedTool> {
    PinnedTool::new(
        data_dir,
        "agent-desktop",
        include_str!("../../../tools/agent-desktop/releases.json"),
        unpack,
    )
}

/// Unpacks the CLI and the platform helper that its release keeps beside it.
fn unpack(archive: &Path, bin: &Path) -> anyhow::Result<()> {
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
        let target = bin.join(name);
        entry.unpack(&target)?;
        set_executable(&target)?;
    }
    ensure!(
        bin.join(CLI).is_file(),
        "agent-desktop archive has no {CLI}"
    );
    Ok(())
}

#[cfg(test)]
mod tests;
