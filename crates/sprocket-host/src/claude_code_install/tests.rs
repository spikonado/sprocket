use super::*;
use crate::tool_install::test_support::write_tar_gz;

#[test]
fn extracts_claude() {
    let directory = tempfile::tempdir().unwrap();
    let archive = directory.path().join("claude-code.tgz");
    let claude_entry = format!("package/{CLAUDE}");
    write_tar_gz(
        &archive,
        &[
            ("package/package.json", b"{}".as_slice()),
            (claude_entry.as_str(), b"claude".as_slice()),
        ],
    );
    let bin = directory.path().join("bin");
    std::fs::create_dir(&bin).unwrap();

    unpack(&archive, &bin).unwrap();

    assert_eq!(std::fs::read(bin.join(CLAUDE)).unwrap(), b"claude");
}
