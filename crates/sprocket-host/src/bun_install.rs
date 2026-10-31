use std::fs::File;
use std::path::Path;
use std::sync::Arc;

use anyhow::bail;

use crate::bin_tool::{BinTool, BinToolSpec};

const BUN: &str = if cfg!(windows) { "bun.exe" } else { "bun" };
const BUNX: &str = if cfg!(windows) { "bunx.exe" } else { "bunx" };

pub fn installer(data_dir: &Path) -> anyhow::Result<Arc<BinTool>> {
    BinTool::new(
        data_dir,
        BinToolSpec {
            name: "bun",
            releases_json: include_str!("../../../tools/bun/releases.json"),
            releases_key: "bun",
            // `bunx` is written last.
            installed: BUNX,
            extract,
        },
    )
}

/// Extracts `bun` from its npm package tarball and links `bunx` to it, as Bun's own installer does.
fn extract(archive: &Path, bin: &Path) -> anyhow::Result<()> {
    std::fs::create_dir_all(bin)?;
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

#[cfg(test)]
mod tests;
