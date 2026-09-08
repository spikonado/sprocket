use std::path::{Component, Path, PathBuf};

use anyhow::{Context, bail};
use serde::{Deserialize, Serialize};
use tokio::io::AsyncReadExt;

pub const MAX_ARTIFACT_BYTES: usize = 500_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ArtifactContentType {
    Markdown,
    Html,
    React,
}

#[derive(Clone, Debug)]
pub struct ArtifactFile {
    pub local_path: String,
    pub content: String,
    pub title: String,
    pub content_type: ArtifactContentType,
}

pub async fn read_artifact_file(workspace_root: &Path, path: &str) -> anyhow::Result<ArtifactFile> {
    if path.is_empty() || path.len() > 4096 || path.contains('\0') {
        bail!("Artifact path must contain 1 to 4096 bytes and no NUL characters.");
    }
    let path = Path::new(path);
    let title = path
        .file_name()
        .and_then(|name| name.to_str())
        .context("Artifact path must name a UTF-8 file.")?
        .to_string();
    if title.chars().count() > 200 {
        bail!("Artifact filename must not exceed 200 characters.");
    }
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let content_type = match extension.as_str() {
        "html" | "htm" => ArtifactContentType::Html,
        "jsx" => ArtifactContentType::React,
        _ => ArtifactContentType::Markdown,
    };
    // Keep symlinks and parent components intact so later reads follow the same
    // path after atomic saves or a symlink replacement.
    let requested: PathBuf = path
        .components()
        .filter(|component| !matches!(component, Component::CurDir))
        .collect();
    let full_path = workspace_root.join(&requested);
    let mut options = tokio::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NONBLOCK);
    let file = options
        .open(&full_path)
        .await
        .with_context(|| format!("Cannot open artifact {}", full_path.display()))?;
    let metadata = file.metadata().await?;
    if !metadata.is_file() {
        bail!("Artifact path must point to a regular file.");
    }
    if metadata.len() > MAX_ARTIFACT_BYTES as u64 {
        bail!("Artifact file must not exceed {MAX_ARTIFACT_BYTES} bytes.");
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_ARTIFACT_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .await?;
    if bytes.len() > MAX_ARTIFACT_BYTES {
        bail!("Artifact file must not exceed {MAX_ARTIFACT_BYTES} bytes.");
    }
    let content = String::from_utf8(bytes).context("Artifact file must contain UTF-8 text.")?;
    let local_path = requested.to_str().context("Artifact path must be UTF-8.")?;
    if local_path.is_empty() {
        bail!("Artifact path must name a UTF-8 file.");
    }
    Ok(ArtifactFile {
        local_path: local_path.to_string(),
        content,
        title,
        content_type,
    })
}

#[cfg(test)]
mod tests {
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
}
