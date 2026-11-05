use std::io::Write;

use super::*;
use crate::tool_install::test_support::write_tar_gz;

fn executable(stem: &str) -> String {
    format!("{stem}{}", std::env::consts::EXE_SUFFIX)
}

#[test]
fn unpacks_uv_executables_from_the_release_tarball() {
    let directory = tempfile::tempdir().unwrap();
    let archive = directory.path().join("uv.tgz");
    let (uv, uvx) = (executable("uv"), executable("uvx"));
    let uv_entry = format!("uv-x86_64-unknown-linux-musl/{uv}");
    let uvx_entry = format!("uv-x86_64-unknown-linux-musl/{uvx}");
    write_tar_gz(
        &archive,
        &[
            (uv_entry.as_str(), b"uv".as_slice()),
            (uvx_entry.as_str(), b"uvx".as_slice()),
            (
                "uv-x86_64-unknown-linux-musl/README.md",
                b"readme".as_slice(),
            ),
        ],
    );
    let bin = directory.path().join("bin");
    std::fs::create_dir(&bin).unwrap();

    unpack_tar_gz(&archive, &bin).unwrap();

    assert_eq!(std::fs::read(bin.join(&uv)).unwrap(), b"uv");
    assert_eq!(std::fs::read(bin.join(&uvx)).unwrap(), b"uvx");
    assert_eq!(std::fs::read_dir(&bin).unwrap().count(), 2);
}

#[test]
fn unpacks_uv_executables_from_the_release_zip() {
    let directory = tempfile::tempdir().unwrap();
    let archive = directory.path().join("uv.zip");
    let mut writer = zip::ZipWriter::new(File::create(&archive).unwrap());
    for (name, contents) in [(executable("uv"), "uv"), (executable("uvw"), "uvw")] {
        writer
            .start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(contents.as_bytes()).unwrap();
    }
    writer.finish().unwrap();
    let bin = directory.path().join("bin");
    std::fs::create_dir(&bin).unwrap();

    unpack_zip(&archive, &bin).unwrap();

    assert_eq!(std::fs::read(bin.join(executable("uv"))).unwrap(), b"uv");
    assert_eq!(std::fs::read(bin.join(executable("uvw"))).unwrap(), b"uvw");
}
