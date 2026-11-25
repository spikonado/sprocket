use std::future::Future;
use std::path::{Path, PathBuf};

use anyhow::Context;
use tokio::io::AsyncWriteExt;

use crate::{TranscriptAttachmentMeta, TranscriptPart, TranscriptPromptBody, TranscriptStore};

async fn download_attachment_to_file(
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
    let mut response = client.get(url).send().await?.error_for_status()?;
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

pub async fn cache_attachment<F, Fut>(
    store: &TranscriptStore,
    user_id: &str,
    thread_id: &str,
    attachment: &TranscriptAttachmentMeta,
    resolve_url: F,
) -> anyhow::Result<PathBuf>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = anyhow::Result<String>>,
{
    let _lease = store.open_thread(user_id, thread_id).await?;
    let file_id = attachment
        .file_id
        .as_deref()
        .context("attachment file was deleted")?;
    let lock = store.lock_attachment(user_id, file_id).await;
    let _guard = lock.lock().await;
    let path = store.attachment_path(user_id, thread_id, file_id, &attachment.name);
    if !tokio::fs::try_exists(&path).await? {
        let parent = path
            .parent()
            .context("attachment has no parent directory")?;
        tokio::fs::create_dir_all(parent).await?;
        let temp = tempfile::NamedTempFile::new_in(parent)?;
        let staged = store.pending_attachment_path(user_id, file_id);
        if tokio::fs::try_exists(&staged).await? {
            tokio::fs::copy(&staged, temp.path()).await?;
        } else {
            download_attachment_to_file(&resolve_url().await?, temp.path(), attachment.size)
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
        if let Err(error) = tokio::fs::remove_file(staged).await
            && error.kind() != std::io::ErrorKind::NotFound
        {
            tracing::warn!("failed to remove staged attachment: {error}");
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
    mut resolve_url: F,
) -> anyhow::Result<()>
where
    F: FnMut(String) -> Fut,
    Fut: Future<Output = anyhow::Result<String>>,
{
    for prompt in parts.iter_mut().filter_map(|part| part.prompt.as_mut()) {
        cache_attachments(store, user_id, thread_id, prompt, &mut resolve_url).await?;
    }
    Ok(())
}

/// Leaves `local_path` unset for deleted files.
pub async fn cache_attachments<F, Fut>(
    store: &TranscriptStore,
    user_id: &str,
    thread_id: &str,
    prompt: &mut TranscriptPromptBody,
    mut resolve_url: F,
) -> anyhow::Result<()>
where
    F: FnMut(String) -> Fut,
    Fut: Future<Output = anyhow::Result<String>>,
{
    for attachment in &mut prompt.image_uploads {
        let Some(file_id) = attachment.file_id.clone() else {
            continue;
        };
        let path = cache_attachment(store, user_id, thread_id, attachment, || {
            resolve_url(file_id)
        })
        .await?;
        attachment.local_path = Some(path.to_string_lossy().into_owned());
    }
    Ok(())
}

#[cfg(test)]
mod tests;
