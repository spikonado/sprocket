use super::*;
use crate::tool_install::test_support::write_tar_gz;

#[test]
fn publishes_the_cli_and_its_helper_as_executables() {
    let directory = tempfile::tempdir().unwrap();
    let archive = directory.path().join("agent-desktop.tar.gz");
    write_tar_gz(
        &archive,
        &[
            (CLI, b"cli".as_slice()),
            ("./agent-desktop-helper", b"helper".as_slice()),
        ],
    );
    let bin = directory.path().join("bin");
    std::fs::create_dir(&bin).unwrap();

    unpack(&archive, &bin).unwrap();

    assert_eq!(std::fs::read(bin.join(CLI)).unwrap(), b"cli");
    assert_eq!(
        std::fs::read(bin.join("agent-desktop-helper")).unwrap(),
        b"helper"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(bin.join(CLI))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o111, 0o111);
    }
}
