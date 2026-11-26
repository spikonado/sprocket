use std::fs::File;
use std::path::{Component, Path, PathBuf};

use anyhow::ensure;

use crate::tool_install::PinnedTool;

const NODE: &str = if cfg!(windows) { "node.exe" } else { "node" };
/// Unused at runtime and a large share of the unpacked size.
const SKIPPED: [&str; 2] = ["include", "share"];

pub(crate) fn installer(data_dir: &Path) -> anyhow::Result<PinnedTool> {
    PinnedTool::new(
        data_dir,
        "node",
        include_str!("../../../tools/node/releases.json"),
        unpack,
    )
}

/// Holds `node`, `npm`, and `npx`.
pub(crate) fn path_dir(node: &PinnedTool) -> PathBuf {
    path_dir_in(&node.bin_dir())
}

/// `npm` is a symlink into `lib/node_modules`, so the whole tree is unpacked, minus its
/// top-level directory.
fn unpack(archive: &Path, root: &Path) -> anyhow::Result<()> {
    if cfg!(windows) {
        unpack_zip(archive, root)?;
    } else {
        unpack_tar_gz(archive, root)?;
    }
    ensure!(
        path_dir_in(root).join(NODE).is_file(),
        "Node.js archive has no {NODE}"
    );
    Ok(())
}

fn path_dir_in(root: &Path) -> PathBuf {
    if cfg!(windows) {
        root.to_owned()
    } else {
        root.join("bin")
    }
}

fn relative_path(path: &Path) -> Option<PathBuf> {
    let relative: PathBuf = path.components().skip(1).collect();
    let wanted = !relative.as_os_str().is_empty()
        && relative
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
        && !SKIPPED.iter().any(|skipped| relative.starts_with(skipped));
    wanted.then_some(relative)
}

fn unpack_tar_gz(archive: &Path, root: &Path) -> anyhow::Result<()> {
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(File::open(archive)?));
    for entry in archive.entries()? {
        let mut entry = entry?;
        let Some(relative) = relative_path(&entry.path()?) else {
            continue;
        };
        let target = root.join(relative);
        std::fs::create_dir_all(target.parent().unwrap_or(root))?;
        entry.unpack(&target)?;
    }
    Ok(())
}

fn unpack_zip(archive: &Path, root: &Path) -> anyhow::Result<()> {
    let mut archive = zip::ZipArchive::new(File::open(archive)?)?;
    for index in 0..archive.len() {
        let mut file = archive.by_index(index)?;
        let Some(relative) = relative_path(Path::new(&*file.name()?)) else {
            continue;
        };
        let target = root.join(relative);
        if file.is_dir() {
            std::fs::create_dir_all(&target)?;
        } else {
            std::fs::create_dir_all(target.parent().unwrap_or(root))?;
            std::io::copy(&mut file, &mut File::create(&target)?)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
