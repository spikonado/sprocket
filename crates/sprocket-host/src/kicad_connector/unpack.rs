//! Unpacks the unmodified upstream KiCad build into a tree that runs in place.

use std::path::{Path, PathBuf};

/// The `kicad-cli` inside an unpacked tree.
pub(super) fn cli(tree: &Path) -> PathBuf {
    if cfg!(target_os = "macos") {
        tree.join("KiCad.app/Contents/MacOS/kicad-cli")
    } else if cfg!(windows) {
        tree.join("bin").join("kicad-cli.exe")
    } else {
        tree.join("bin/kicad-cli")
    }
}

#[cfg(target_os = "linux")]
pub(super) use linux::unpack;
#[cfg(target_os = "macos")]
pub(super) use macos::unpack;
#[cfg(windows)]
pub(super) use windows::unpack;

/// Extracts the DwarFS image appended to the AppImage's ELF runtime.
#[cfg(target_os = "linux")]
mod linux {
    use std::fs::{self, File, Permissions};
    use std::io::{self, Read};
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Component, Path, PathBuf};

    use dwarfs::positioned_io::Slice;
    use dwarfs::{Archive, AsChunks, Dir, InodeKind};

    pub(in crate::kicad_connector) fn unpack(appimage: &Path, tree: &Path) -> anyhow::Result<()> {
        let mut image = File::open(appimage)?;
        let mut header = [0; 64];
        image.read_exact(&mut header)?;
        let (index, mut archive) = Archive::new(Slice::new_to_end(image, elf_end(&header)?)?)?;
        let mut files = Vec::new();
        walk(index.root(), tree, &mut files)?;
        // Reading in on-disk order keeps the block cache hot; otherwise extraction is ~7x slower.
        files.sort_by_key(|(file, ..)| {
            file.as_chunks()
                .next()
                .map(|chunk| (chunk.section_idx(), chunk.offset()))
        });
        for (file, path, mode) in files {
            let mut output = File::options().write(true).create_new(true).open(&path)?;
            io::copy(&mut file.as_reader(&mut archive), &mut output)?;
            output.set_permissions(Permissions::from_mode(mode))?;
        }
        Ok(())
    }

    /// AppImage runtimes find their image right after the ELF section header table.
    fn elf_end(header: &[u8; 64]) -> io::Result<u64> {
        let invalid = || io::Error::new(io::ErrorKind::InvalidData, "Not a 64-bit AppImage");
        if header[..4] != *b"\x7fELF" || header[4] != 2 || header[5] != 1 {
            return Err(invalid());
        }
        let section_headers = u64::from_le_bytes(std::array::from_fn(|index| header[0x28 + index]));
        let entry_size = u16::from_le_bytes([header[0x3a], header[0x3b]]);
        let entries = u16::from_le_bytes([header[0x3c], header[0x3d]]);
        section_headers
            .checked_add(u64::from(entry_size) * u64::from(entries))
            .ok_or_else(invalid)
    }

    fn walk<'a>(
        dir: Dir<'a>,
        out: &Path,
        files: &mut Vec<(dwarfs::File<'a>, PathBuf, u32)>,
    ) -> io::Result<()> {
        for entry in dir.entries() {
            let name = entry.name();
            let mut components = Path::new(name).components();
            if !matches!(
                (components.next(), components.next()),
                (Some(Component::Normal(part)), None) if part == name
            ) {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("Unsafe AppImage entry {name:?}"),
                ));
            }
            let path = out.join(name);
            let inode = entry.inode();
            let mode = inode.metadata().file_type_mode().permission_bits();
            match inode.classify() {
                InodeKind::Directory(dir) => {
                    fs::create_dir(&path)?;
                    walk(dir, &path, files)?;
                }
                InodeKind::File(file) => files.push((file, path, mode)),
                InodeKind::Symlink(link) => std::os::unix::fs::symlink(link.target(), &path)?,
                _ => {}
            }
        }
        Ok(())
    }
}

/// Extracts the files the NSIS installer would put in `$INSTDIR`.
#[cfg(windows)]
mod windows {
    use std::collections::BTreeMap;
    use std::fs::{self, File};
    use std::path::Path;

    use anyhow::{Context, ensure};
    use nsis::NsisInstaller;
    use nsis::decompress::CompressionMode;

    pub(in crate::kicad_connector) fn unpack(installer: &Path, tree: &Path) -> anyhow::Result<()> {
        let file = File::open(installer)?;
        // SAFETY: the verified download is private to this install and nothing writes it while mapped.
        let map = unsafe { memmap2::Mmap::map(&file)? };
        let installer = NsisInstaller::builder(&map)
            .max_decompressed_size(1 << 30)
            .parse()?;
        ensure!(
            installer.compression_mode() != CompressionMode::Solid,
            "Solid KiCad installers aren't supported"
        );
        // Installers can extract one path several times; the last copy is what stays installed.
        let mut files = BTreeMap::new();
        for file in installer.files() {
            let file = file?;
            let destination = file.dest_path()?;
            if destination.to_install_path().starts_with('$') {
                continue;
            }
            let path = destination.to_path();
            if !path.is_empty() {
                files.insert(path, file);
            }
        }
        for (path, file) in files {
            let target = tree.join(path);
            fs::create_dir_all(target.parent().context("KiCad file has no directory")?)?;
            fs::write(target, file.decompress()?)?;
        }
        Ok(())
    }
}

/// Copies `KiCad.app` out of the disk image.
#[cfg(target_os = "macos")]
mod macos {
    use std::path::Path;
    use std::process::{Command, Stdio};

    use anyhow::{Context, ensure};

    pub(in crate::kicad_connector) fn unpack(image: &Path, tree: &Path) -> anyhow::Result<()> {
        let mount = tempfile::tempdir()?;
        run(Command::new("hdiutil")
            .args([
                "attach",
                "-nobrowse",
                "-readonly",
                "-noverify",
                "-noautoopen",
            ])
            .arg("-mountpoint")
            .arg(mount.path())
            .arg(image))?;
        let copied = copy_app(mount.path(), tree);
        let detached = run(Command::new("hdiutil").arg("detach").arg(mount.path())).or_else(|_| {
            run(Command::new("hdiutil")
                .args(["detach", "-force"])
                .arg(mount.path()))
        });
        copied.and(detached)
    }

    fn copy_app(volume: &Path, tree: &Path) -> anyhow::Result<()> {
        let app = std::iter::once(volume.to_path_buf())
            .chain(
                std::fs::read_dir(volume)?
                    .flatten()
                    .map(|entry| entry.path()),
            )
            .map(|dir| dir.join("KiCad.app"))
            .find(|app| app.is_dir())
            .context("KiCad disk image has no KiCad.app")?;
        run(Command::new("ditto").arg(app).arg(tree.join("KiCad.app")))
    }

    fn run(command: &mut Command) -> anyhow::Result<()> {
        let output = command.stdin(Stdio::null()).output()?;
        ensure!(
            output.status.success(),
            "{:?} exited with {}: {}",
            command.get_program(),
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        );
        Ok(())
    }
}
