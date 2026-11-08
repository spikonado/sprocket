use std::path::{Component, Path, PathBuf};

use anyhow::{Context, bail};
use tokio::io::AsyncReadExt;

pub const MAX_ARTIFACT_BYTES: usize = 500_000;

#[derive(Clone, Debug)]
pub struct ArtifactFile {
    pub local_path: String,
    pub content: String,
    pub title: String,
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
    })
}

#[cfg(test)]
mod tests;
