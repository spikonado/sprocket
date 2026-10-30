use super::*;

#[test]
fn extracts_bun_and_links_bunx() {
    let directory = tempfile::tempdir().unwrap();
    let archive = directory.path().join("bun.tgz");
    let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(
        File::create(&archive).unwrap(),
        flate2::Compression::fast(),
    ));
    let bun_entry = format!("package/bin/{BUN}");
    for (path, contents) in [
        ("package/package.json", b"{}".as_slice()),
        (bun_entry.as_str(), b"bun".as_slice()),
    ] {
        let mut header = tar::Header::new_gnu();
        header.set_size(contents.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        builder.append_data(&mut header, path, contents).unwrap();
    }
    builder.into_inner().unwrap().finish().unwrap();
    let bin = directory.path().join("bin");
    std::fs::create_dir(&bin).unwrap();

    extract(&archive, &bin).unwrap();

    assert_eq!(std::fs::read(bin.join(BUN)).unwrap(), b"bun");
    assert_eq!(std::fs::read(bin.join(BUNX)).unwrap(), b"bun");
}
