use std::future::Future;
use std::path::{Path, PathBuf};

use anyhow::Context;
use tokio::io::AsyncWriteExt;

use crate::{TranscriptAttachmentMeta, TranscriptPart, TranscriptStore};

#[derive(Debug, thiserror::Error)]
#[error("attachment is unavailable locally and its remote copy is missing or expired")]
pub struct AttachmentUnavailable;

pub async fn download_attachment_to_file(
    url: &str,
    path: &Path,
    expected_size: u64,
) -> anyhow::Result<()> {
    let url = reqwest::Url::parse(url).context("invalid attachment URL")?;
    anyhow::ensure!(
        matches!(url.scheme(), "http" | "https"),
        "unsupported attachment URL scheme"
    );
    let client = reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(std::time::Duration::from_secs(30))
        .read_timeout(std::time::Duration::from_secs(60))
        .build()?;
    let response = client.get(url).send().await?;
    if matches!(response.status().as_u16(), 404 | 410) {
        return Err(AttachmentUnavailable.into());
    }
    let mut response = response.error_for_status()?;
    if let Some(size) = response.content_length() {
        anyhow::ensure!(
            size == expected_size,
            "attachment size does not match metadata"
        );
    }
    let mut file = tokio::fs::File::create(path).await?;
    let mut received = 0u64;
    while let Some(chunk) = response.chunk().await? {
        received = received.saturating_add(chunk.len() as u64);
        anyhow::ensure!(
            received <= expected_size,
            "attachment exceeds its declared size"
        );
        file.write_all(&chunk).await?;
    }
    anyhow::ensure!(
        received == expected_size,
        "attachment size does not match metadata"
    );
    file.sync_all().await?;
    Ok(())
}

pub async fn cache_attachment(
    store: &TranscriptStore,
    user_id: &str,
    thread_id: &str,
    attachment: &TranscriptAttachmentMeta,
) -> anyhow::Result<PathBuf> {
    cache_attachment_with_url(store, user_id, thread_id, attachment, || async { Ok(None) }).await
}

async fn cache_attachment_with_url<F, Fut>(
    store: &TranscriptStore,
    user_id: &str,
    thread_id: &str,
    attachment: &TranscriptAttachmentMeta,
    resolve: F,
) -> anyhow::Result<PathBuf>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = anyhow::Result<Option<String>>>,
{
    let lock = store.lock_attachment(user_id, &attachment.storage_id).await;
    let _guard = lock.lock().await;
    let path = store.attachment_path(user_id, thread_id, attachment);
    if !tokio::fs::try_exists(&path).await? {
        let parent = path
            .parent()
            .context("attachment has no parent directory")?;
        tokio::fs::create_dir_all(parent).await?;
        let temp = tempfile::NamedTempFile::new_in(parent)?;
        let staged = store.pending_attachment_path(user_id, &attachment.storage_id);
        if tokio::fs::try_exists(&staged).await? {
            tokio::fs::copy(&staged, temp.path()).await?;
        } else {
            let url = match &attachment.url {
                Some(url) => url.clone(),
                None => resolve().await?.ok_or(AttachmentUnavailable)?,
            };
            download_attachment_to_file(&url, temp.path(), attachment.size)
                .await
                .with_context(|| format!("failed to retrieve attachment {}", attachment.name))?;
        }
        anyhow::ensure!(
            tokio::fs::metadata(temp.path()).await?.len() == attachment.size,
            "attachment size does not match metadata"
        );
        temp.persist(&path)?;
        store
            .save_attachment_metadata(user_id, thread_id, attachment)
            .await?;
        if let Err(error) = tokio::fs::remove_file(staged).await {
            if error.kind() != std::io::ErrorKind::NotFound {
                eprintln!("sprocket-transcript: failed to remove staged attachment: {error}");
            }
        }
    } else {
        store
            .save_attachment_metadata(user_id, thread_id, attachment)
            .await?;
    }
    Ok(tokio::fs::canonicalize(path).await?)
}

pub async fn cache_prompt_attachments<F, Fut>(
    store: &TranscriptStore,
    user_id: &str,
    thread_id: &str,
    parts: &mut [TranscriptPart],
    mut resolve: F,
) -> anyhow::Result<()>
where
    F: FnMut(u32, String) -> Fut,
    Fut: Future<Output = anyhow::Result<Option<String>>>,
{
    for part in parts {
        let number = part.number;
        let Some(prompt) = &mut part.prompt else {
            continue;
        };
        for attachment in &mut prompt.image_uploads {
            attachment.local_path =
                match cache_attachment_with_url(store, user_id, thread_id, attachment, || {
                    resolve(number, attachment.storage_id.clone())
                })
                .await
                {
                    Ok(path) => Some(path.to_string_lossy().into_owned()),
                    Err(error) if error.is::<AttachmentUnavailable>() => None,
                    Err(error) => return Err(error),
                };
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
