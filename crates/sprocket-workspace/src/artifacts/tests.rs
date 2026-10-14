use super::*;
use crate::test_support::temp_workspace;

#[tokio::test]
async fn reads_relative_and_absolute_paths_and_empty_files() {
    let dir = temp_workspace();
    tokio::fs::create_dir(dir.join("nested")).await.unwrap();
    tokio::fs::write(dir.join("preview.HTML"), "<h1>Hello</h1>")
        .await
        .unwrap();
    tokio::fs::write(
        dir.join("nested").join("app.jsx"),
        "function App() { return null; }",
    )
    .await
    .unwrap();
    tokio::fs::write(dir.join("notes.md"), vec![b'a'; MAX_ARTIFACT_BYTES])
        .await
        .unwrap();

    let relative = read_artifact_file(&dir, "./preview.HTML").await.unwrap();
    assert_eq!(relative.local_path, "preview.HTML");
    assert_eq!(relative.content_type, ArtifactContentType::Html);

    let nested = read_artifact_file(&dir, "nested/./app.jsx").await.unwrap();
    assert_eq!(nested.local_path, "nested/app.jsx");
    assert_eq!(nested.content_type, ArtifactContentType::React);

    let exact = read_artifact_file(&dir, "notes.md").await.unwrap();
    assert_eq!(exact.content.len(), MAX_ARTIFACT_BYTES);
    assert_eq!(exact.content_type, ArtifactContentType::Markdown);

    let inside_absolute = dir.join("preview.HTML");
    let inside = read_artifact_file(&dir, inside_absolute.to_str().unwrap())
        .await
        .unwrap();
    assert_eq!(inside.local_path, inside_absolute.to_str().unwrap());
    assert_eq!(inside.content, relative.content);

    let absolute = read_artifact_file(Path::new("/unused"), inside_absolute.to_str().unwrap())
        .await
        .unwrap();
    assert_eq!(absolute.local_path, inside_absolute.to_str().unwrap());
    assert_eq!(absolute.content, relative.content);

    tokio::fs::write(&inside_absolute, "").await.unwrap();
    assert!(
        read_artifact_file(&dir, "preview.HTML")
            .await
            .unwrap()
            .content
            .is_empty()
    );
    tokio::fs::remove_dir_all(dir).await.unwrap();
}

#[tokio::test]
async fn rejects_binary_oversized_and_non_regular_files() {
    let dir = temp_workspace();
    tokio::fs::write(dir.join("binary.md"), [0xff])
        .await
        .unwrap();
    assert!(read_artifact_file(&dir, "binary.md").await.is_err());
    tokio::fs::write(dir.join("large.md"), vec![b'a'; MAX_ARTIFACT_BYTES + 1])
        .await
        .unwrap();
    assert!(read_artifact_file(&dir, "large.md").await.is_err());
    assert!(read_artifact_file(&dir, ".").await.is_err());
    assert!(read_artifact_file(&dir, "").await.is_err());
    assert!(read_artifact_file(&dir, "missing.md").await.is_err());
    assert!(read_artifact_file(&dir, "bad\0.md").await.is_err());
    assert!(
        read_artifact_file(&dir, &format!("{}.md", "a".repeat(201)))
            .await
            .is_err()
    );

    #[cfg(unix)]
    {
        let fifo = dir.join("pipe.md");
        let c_path = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o644) }, 0);
        assert!(read_artifact_file(&dir, "pipe.md").await.is_err());
    }

    tokio::fs::remove_dir_all(dir).await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn follows_replaced_symlinks_and_atomic_saves_without_changing_registered_path() {
    let dir = temp_workspace();
    tokio::fs::create_dir(dir.join("subdir")).await.unwrap();
    tokio::fs::write(dir.join("one.md"), "one").await.unwrap();
    tokio::fs::write(dir.join("two.md"), "two").await.unwrap();
    tokio::fs::write(dir.join("keep.md"), "keep").await.unwrap();

    let link = dir.join("preview.md");
    std::os::unix::fs::symlink("one.md", &link).unwrap();
    let first = read_artifact_file(&dir, "preview.md").await.unwrap();
    assert_eq!(first.local_path, "preview.md");
    tokio::fs::remove_file(&link).await.unwrap();
    std::os::unix::fs::symlink("two.md", &link).unwrap();
    assert_eq!(
        read_artifact_file(&dir, &first.local_path)
            .await
            .unwrap()
            .content,
        "two"
    );

    let parented = read_artifact_file(&dir, "subdir/../keep.md").await.unwrap();
    assert_eq!(parented.local_path, "subdir/../keep.md");
    assert_eq!(parented.content, "keep");
    tokio::fs::write(dir.join("keep.md.tmp"), "next")
        .await
        .unwrap();
    tokio::fs::rename(dir.join("keep.md.tmp"), dir.join("keep.md"))
        .await
        .unwrap();
    assert_eq!(
        read_artifact_file(&dir, &parented.local_path)
            .await
            .unwrap()
            .content,
        "next"
    );

    tokio::fs::remove_dir_all(dir).await.unwrap();
}
