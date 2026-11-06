use std::fs::File;
use std::path::{Path, PathBuf};

use anyhow::ensure;

use crate::tool_install::{PinnedTool, set_executable};

const GH: &str = if cfg!(windows) { "gh.exe" } else { "gh" };

pub(crate) fn installer(data_dir: &Path) -> anyhow::Result<PinnedTool> {
    PinnedTool::new(
        data_dir,
        "gh",
        include_str!("../../../tools/gh/releases.json"),
        unpack,
    )
}

pub(crate) fn executable(gh: &PinnedTool) -> PathBuf {
    gh.bin_dir().join(GH)
}

/// GitHub ships a tarball on Linux and a zip elsewhere; each holds `bin/gh` beside docs.
fn unpack(archive: &Path, bin: &Path) -> anyhow::Result<()> {
    if cfg!(target_os = "linux") {
        unpack_tar_gz(archive, bin)?;
    } else {
        unpack_zip(archive, bin)?;
    }
    let gh = bin.join(GH);
    ensure!(gh.is_file(), "GitHub CLI archive has no bin/{GH}");
    set_executable(&gh)?;
    Ok(())
}

fn is_gh(path: &Path) -> bool {
    path.ends_with(Path::new("bin").join(GH))
}

fn unpack_tar_gz(archive: &Path, bin: &Path) -> anyhow::Result<()> {
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(File::open(archive)?));
    for entry in archive.entries()? {
        let mut entry = entry?;
        if entry.header().entry_type().is_file() && is_gh(&entry.path()?) {
            entry.unpack(bin.join(GH))?;
            break;
        }
    }
    Ok(())
}

fn unpack_zip(archive: &Path, bin: &Path) -> anyhow::Result<()> {
    let mut archive = zip::ZipArchive::new(File::open(archive)?)?;
    for index in 0..archive.len() {
        let mut file = archive.by_index(index)?;
        if file.is_file() && is_gh(Path::new(&*file.name()?)) {
            std::io::copy(&mut file, &mut File::create(bin.join(GH))?)?;
            break;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
