use std::io::Write;

use super::*;
use crate::tool_install::test_support::write_tar_gz;

fn assert_only_gh(bin: &Path) {
    assert_eq!(std::fs::read(bin.join(GH)).unwrap(), b"gh");
    assert_eq!(std::fs::read_dir(bin).unwrap().count(), 1);
}

#[test]
fn extracts_gh_from_the_linux_tarball() {
    let directory = tempfile::tempdir().unwrap();
    let archive = directory.path().join("gh.tar.gz");
    let entry = format!("gh_2.0.0_linux_amd64/bin/{GH}");
    write_tar_gz(
        &archive,
        &[
            ("gh_2.0.0_linux_amd64/LICENSE", b"license".as_slice()),
            (entry.as_str(), b"gh".as_slice()),
        ],
    );
    let bin = directory.path().join("bin");
    std::fs::create_dir(&bin).unwrap();

    unpack_tar_gz(&archive, &bin).unwrap();

    assert_only_gh(&bin);
}

#[test]
fn extracts_gh_from_the_zip() {
    let directory = tempfile::tempdir().unwrap();
    let archive = directory.path().join("gh.zip");
    let mut writer = zip::ZipWriter::new(File::create(&archive).unwrap());
    for (name, contents) in [
        ("gh_2.0.0_macOS_arm64/LICENSE".to_string(), "license"),
        (format!("gh_2.0.0_macOS_arm64/bin/{GH}"), "gh"),
    ] {
        writer
            .start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(contents.as_bytes()).unwrap();
    }
    writer.finish().unwrap();
    let bin = directory.path().join("bin");
    std::fs::create_dir(&bin).unwrap();

    unpack_zip(&archive, &bin).unwrap();

    assert_only_gh(&bin);
}
