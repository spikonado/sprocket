use std::io::Write;

use super::*;
use crate::tool_install::test_support::write_tar_gz;

#[test]
fn tarball_keeps_the_tree_without_its_top_directory_or_headers() {
    let directory = tempfile::tempdir().unwrap();
    let archive = directory.path().join("node.tar.gz");
    write_tar_gz(
        &archive,
        &[
            ("node-v1/bin/node", b"node".as_slice()),
            ("node-v1/lib/node_modules/npm/bin/npm-cli.js", b"npm"),
            ("node-v1/include/node/node.h", b"header"),
            ("node-v1/share/man/node.1", b"man"),
        ],
    );
    let root = directory.path().join("root");
    std::fs::create_dir(&root).unwrap();

    unpack_tar_gz(&archive, &root).unwrap();

    assert_eq!(std::fs::read(root.join("bin/node")).unwrap(), b"node");
    assert_eq!(
        std::fs::read(root.join("lib/node_modules/npm/bin/npm-cli.js")).unwrap(),
        b"npm"
    );
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
