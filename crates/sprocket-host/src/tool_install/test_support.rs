use std::fs::File;
use std::path::Path;

pub(crate) fn write_tar_gz(path: &Path, entries: &[(&str, &[u8])]) {
    let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(
        File::create(path).unwrap(),
        flate2::Compression::fast(),
    ));
    for (name, contents) in entries {
        let mut header = tar::Header::new_gnu();
        header.set_size(contents.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        builder.append_data(&mut header, name, *contents).unwrap();
    }
    builder.into_inner().unwrap().finish().unwrap();
}
