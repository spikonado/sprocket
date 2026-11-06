use std::io::Cursor;
use std::path::{Path, PathBuf};

use anyhow::{Context, ensure};

use crate::tool_install::PinnedTool;

const SEVEN_ZIP_SIGNATURE: &[u8] = b"7z\xBC\xAF\x27\x1C";

/// PortableGit gives Windows machines without Git for Windows both git and Git Bash. macOS
/// and Linux have no official portable git, and nearly always have git and bash already.
pub(crate) fn installer(data_dir: &Path) -> anyhow::Result<PinnedTool> {
    PinnedTool::new(
        data_dir,
        "git",
        include_str!("../../../tools/git/releases.json"),
        unpack,
    )
}

/// Holds `git.exe` only. The default shell finds Git Bash in `bin` beside it.
pub(crate) fn path_dir(git: &PinnedTool) -> PathBuf {
    git.bin_dir().join("cmd")
}

/// PortableGit is a 7-Zip self-extractor, so its archive starts after the extractor program.
/// It is unpacked whole because git and bash find their helpers relative to themselves.
fn unpack(download: &Path, root: &Path) -> anyhow::Result<()> {
    let bytes = std::fs::read(download)?;
    let start = bytes
        .windows(SEVEN_ZIP_SIGNATURE.len())
        .position(|window| window == SEVEN_ZIP_SIGNATURE)
        .context("PortableGit download holds no 7z archive")?;
    sevenz_rust2::decompress(Cursor::new(&bytes[start..]), root)?;
    for required in ["cmd/git.exe", "bin/bash.exe"] {
        ensure!(
            root.join(required).is_file(),
            "PortableGit has no {required}"
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests;
