use std::fs::File;
use std::path::Path;

use anyhow::bail;

use crate::tool_install::{PinnedTool, set_executable};

const BUN: &str = if cfg!(windows) { "bun.exe" } else { "bun" };
const BUNX: &str = if cfg!(windows) { "bunx.exe" } else { "bunx" };

pub(crate) fn installer(data_dir: &Path) -> anyhow::Result<PinnedTool> {
    PinnedTool::new(
        data_dir,
        "bun",
        include_str!("../../../tools/bun/releases.json"),
        unpack,
    )
}

/// Extracts `bun` from its npm package tarball and links `bunx` to it, as Bun's own installer does.
fn unpack(archive: &Path, bin: &Path) -> anyhow::Result<()> {
    let entry_path = Path::new("package/bin").join(BUN);
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(File::open(archive)?));
    for entry in archive.entries()? {
        let mut entry = entry?;
        if entry.path()? == entry_path {
            let bun = bin.join(BUN);
            entry.unpack(&bun)?;
            set_executable(&bun)?;
            std::fs::hard_link(&bun, bin.join(BUNX))?;
            return Ok(());
        }
    }
    bail!("Bun archive has no {}", entry_path.display())
}

#[cfg(test)]
mod tests;
