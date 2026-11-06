use super::*;

#[test]
fn unpacks_the_archive_after_the_self_extractor() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("source");
    for (relative, contents) in [("cmd/git.exe", "git"), ("bin/bash.exe", "bash")] {
        let file = source.join(relative);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, contents).unwrap();
    }
    let archive = directory.path().join("archive.7z");
    sevenz_rust2::compress_to_path(&source, &archive).unwrap();
    let download = directory.path().join("PortableGit.7z.exe");
    let mut bytes = b"MZ self-extractor program".to_vec();
    bytes.extend(std::fs::read(&archive).unwrap());
    std::fs::write(&download, bytes).unwrap();
    let root = directory.path().join("root");
    std::fs::create_dir(&root).unwrap();

    unpack(&download, &root).unwrap();

    assert_eq!(std::fs::read(root.join("cmd/git.exe")).unwrap(), b"git");
    assert_eq!(std::fs::read(root.join("bin/bash.exe")).unwrap(), b"bash");
}
