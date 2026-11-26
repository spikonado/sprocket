use std::io::Write;

use super::*;

#[cfg(unix)]
#[test]
fn tarball_keeps_links_and_modes_without_its_top_directory_or_headers() {
    use std::os::unix::fs::PermissionsExt;

    let directory = tempfile::tempdir().unwrap();
    let archive = directory.path().join("node.tar.gz");
    let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(
        File::create(&archive).unwrap(),
        flate2::Compression::fast(),
    ));
    for (name, contents) in [
        ("node-v1/bin/node", "node"),
        ("node-v1/lib/node_modules/npm/bin/npm-cli.js", "npm"),
        ("node-v1/include/node/node.h", "header"),
        ("node-v1/share/man/node.1", "man"),
    ] {
        let mut header = tar::Header::new_gnu();
        header.set_size(contents.len() as u64);
        header.set_mode(0o755);
        header.set_cksum();
        builder
            .append_data(&mut header, name, contents.as_bytes())
            .unwrap();
    }
    for command in ["npm", "npx"] {
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Symlink);
        header.set_size(0);
        header.set_mode(0o777);
        builder
            .append_link(
                &mut header,
                format!("node-v1/bin/{command}"),
                "../lib/node_modules/npm/bin/npm-cli.js",
            )
            .unwrap();
    }
    builder.into_inner().unwrap().finish().unwrap();
    let root = directory.path().join("root");
    std::fs::create_dir(&root).unwrap();

    unpack_tar_gz(&archive, &root).unwrap();

    assert_eq!(std::fs::read(root.join("bin/node")).unwrap(), b"node");
    let mode = std::fs::metadata(root.join("bin/node"))
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(mode & 0o111, 0o111);
    for command in ["npm", "npx"] {
        assert_eq!(
            std::fs::read(root.join("bin").join(command)).unwrap(),
            b"npm"
        );
    }
    assert!(!root.join("include").exists());
    assert!(!root.join("share").exists());
}

#[test]
fn zip_keeps_the_tree_without_its_top_directory() {
    let directory = tempfile::tempdir().unwrap();
    let archive = directory.path().join("node.zip");
    let mut writer = zip::ZipWriter::new(File::create(&archive).unwrap());
    for (name, contents) in [
        ("node-v1-win-x64/node.exe", "node"),
        ("node-v1-win-x64/npm.cmd", "npm"),
        ("node-v1-win-x64/node_modules/npm/bin/npm-cli.js", "cli"),
    ] {
        writer
            .start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(contents.as_bytes()).unwrap();
    }
    writer.finish().unwrap();
    let root = directory.path().join("root");
    std::fs::create_dir(&root).unwrap();

    unpack_zip(&archive, &root).unwrap();

    assert_eq!(std::fs::read(root.join("node.exe")).unwrap(), b"node");
    assert_eq!(std::fs::read(root.join("npm.cmd")).unwrap(), b"npm");
    assert_eq!(
        std::fs::read(root.join("node_modules/npm/bin/npm-cli.js")).unwrap(),
        b"cli"
    );
}
