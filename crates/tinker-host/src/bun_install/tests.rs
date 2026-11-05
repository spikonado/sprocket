use super::*;
use crate::tool_install::test_support::write_tar_gz;

#[test]
fn extracts_bun_and_links_bunx() {
    let directory = tempfile::tempdir().unwrap();
    let archive = directory.path().join("bun.tgz");
    let bun_entry = format!("package/bin/{BUN}");
    write_tar_gz(
        &archive,
        &[
            ("package/package.json", b"{}".as_slice()),
            (bun_entry.as_str(), b"bun".as_slice()),
        ],
    );
    let bin = directory.path().join("bin");
    std::fs::create_dir(&bin).unwrap();

    unpack(&archive, &bin).unwrap();

    assert_eq!(std::fs::read(bin.join(BUN)).unwrap(), b"bun");
    assert_eq!(std::fs::read(bin.join(BUNX)).unwrap(), b"bun");
}
