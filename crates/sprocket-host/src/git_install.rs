use std::fs::File;
use std::path::{Path, PathBuf};

use anyhow::ensure;

use crate::tool_install::PinnedTool;

/// MinGit, for Windows machines without Git for Windows. macOS and Linux have no official
/// portable git, and nearly always have git already.
pub(crate) fn installer(data_dir: &Path) -> anyhow::Result<PinnedTool> {
    PinnedTool::new(
        data_dir,
        "git",
        include_str!("../../../tools/git/releases.json"),
        unpack,
    )
}

/// Holds `git.exe` only; the rest of MinGit stays out of the `PATH`.
pub(crate) fn path_dir(git: &PinnedTool) -> PathBuf {
    git.bin_dir().join("cmd")
}

/// `git.exe` finds its helpers and `sh` relative to itself, so MinGit is unpacked whole.
fn unpack(archive: &Path, root: &Path) -> anyhow::Result<()> {
    zip::ZipArchive::new(File::open(archive)?)?.extract(root)?;
    ensure!(
        root.join("cmd").join("git.exe").is_file(),
        "MinGit archive has no cmd/git.exe"
    );
    Ok(())
}
