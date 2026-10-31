use super::*;

#[test]
fn publishes_the_cli_and_its_helper_as_executables() {
    let directory = tempfile::tempdir().unwrap();
    let archive = directory.path().join("agent-desktop.tar.gz");
    let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(
        File::create(&archive).unwrap(),
        flate2::Compression::fast(),
    ));
    for (path, contents) in [
        (CLI, b"cli".as_slice()),
        ("./agent-desktop-helper", b"helper".as_slice()),
    ] {
        let mut header = tar::Header::new_gnu();
        header.set_size(contents.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        builder.append_data(&mut header, path, contents).unwrap();
    }
    builder.into_inner().unwrap().finish().unwrap();
    let bin = directory.path().join("bin");

    extract(&archive, &bin).unwrap();

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
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 2);
}
