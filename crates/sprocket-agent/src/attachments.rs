use std::path::{Path, PathBuf};

use anyhow::Context;
use tokio::io::AsyncWriteExt;

use crate::transcript::{TranscriptAttachmentMeta, TranscriptPart, TranscriptStore};

#[derive(Debug, thiserror::Error)]
#[error("attachment is unavailable locally and its remote copy is missing or expired")]
struct AttachmentUnavailable;

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
        let legacy = store.blob_data_path(user_id, &attachment.storage_id);
        if tokio::fs::try_exists(&staged).await? {
            tokio::fs::copy(&staged, temp.path()).await?;
        } else if tokio::fs::try_exists(&legacy).await? {
            tokio::fs::copy(&legacy, temp.path()).await?;
        } else {
            let url = attachment.url.as_deref().ok_or(AttachmentUnavailable)?;
            download_attachment_to_file(url, temp.path(), attachment.size)
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
                eprintln!("sprocket-agent: failed to remove staged attachment: {error}");
            }
        }
    } else {
        store
            .save_attachment_metadata(user_id, thread_id, attachment)
            .await?;
    }
    Ok(tokio::fs::canonicalize(path).await?)
}

pub(crate) async fn cache_prompt_attachments(
    store: &TranscriptStore,
    user_id: &str,
    thread_id: &str,
    parts: &mut [TranscriptPart],
) -> anyhow::Result<()> {
    for part in parts {
        let Some(prompt) = &mut part.prompt else {
            continue;
        };
        for attachment in &mut prompt.image_uploads {
            attachment.local_path =
                match cache_attachment(store, user_id, thread_id, attachment).await {
                    Ok(path) => Some(path.to_string_lossy().into_owned()),
                    Err(error) if error.is::<AttachmentUnavailable>() => None,
                    Err(error) => return Err(error),
                };
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transcript::types::{TranscriptPartKind, TranscriptPromptBody};

    fn attachment(id: &str, size: u64) -> TranscriptAttachmentMeta {
        TranscriptAttachmentMeta {
            image_upload_id: format!("upload-{id}"),
            storage_id: format!("storage-{id}"),
            name: "../notes.txt".into(),
            media_type: "application/octet-stream".into(),
            size,
            url: None,
            local_path: None,
        }
    }

    #[tokio::test]
    async fn expires_abandoned_staging_without_removing_fresh_or_submitted_files() {
        use std::time::{Duration, SystemTime};
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::new(dir.path().into());
        let now = SystemTime::now();
        let old = now - Duration::from_secs(2 * 24 * 60 * 60);
        let cutoff = now - Duration::from_secs(24 * 60 * 60);
        assert_eq!(store.prune_pending_attachments(cutoff).await.unwrap(), 0);

        let stale = store.pending_attachment_path("user", "stale");
        let fresh = store.pending_attachment_path("user", "fresh");
        let crashed = store.pending_attachment_path("other", "upload");
        let submitted = store.attachment_path("user", "thread", &attachment("submitted", 0));
        for path in [&stale, &fresh, &crashed, &submitted] {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            let file = std::fs::File::create(path).unwrap();
            file.set_modified(if path == &fresh { now } else { old })
                .unwrap();
        }
        let guard = store.protect_pending_upload(&stale).await;
        assert_eq!(store.prune_pending_attachments(cutoff).await.unwrap(), 1);
        assert!(stale.exists());
        drop(guard);
        assert_eq!(store.prune_pending_attachments(cutoff).await.unwrap(), 1);
        assert!(!stale.exists());
        assert!(!crashed.exists());
        assert!(fresh.exists());
        assert!(submitted.exists());
        assert_eq!(store.prune_pending_attachments(cutoff).await.unwrap(), 0);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn pending_expiry_does_not_follow_directory_symlinks() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let store = TranscriptStore::new(dir.path().into());
        let target = outside.path().join("keep");
        std::fs::write(&target, b"keep").unwrap();
        let pending = store.pending_attachment_path("user", "ignored");
        std::fs::create_dir_all(pending.parent().unwrap().parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(outside.path(), pending.parent().unwrap()).unwrap();
        assert_eq!(
            store
                .prune_pending_attachments(std::time::SystemTime::now())
                .await
                .unwrap(),
            0
        );
        assert!(target.exists());
    }

    #[test]
    fn cache_filenames_keep_extensions_when_long_unicode_names_are_shortened() {
        let store = TranscriptStore::new(PathBuf::from("/cache"));
        let mut meta = attachment("long", 0);
        meta.name = format!("{}.csv", "表".repeat(250));
        let path = store.attachment_path("user", "thread", &meta);
        assert_eq!(path.extension().unwrap(), "csv");
        assert!(path.file_name().unwrap().to_string_lossy().len() <= 205);
    }

    #[test]
    fn attachment_paths_keep_untrusted_ids_and_names_inside_the_cache() {
        let root = std::env::temp_dir().join("attachment-path-test");
        let store = TranscriptStore::new(root.clone());
        for input in [
            "../../outside",
            r"..\..\outside",
            "/etc/passwd",
            r"C:\outside",
        ] {
            let mut meta = attachment("unsafe", 0);
            meta.image_upload_id = input.into();
            meta.storage_id = input.into();
            meta.name = input.into();
            for path in [
                store.attachment_path(input, input, &meta),
                store.pending_attachment_path(input, input),
                store.blob_data_path(input, input),
            ] {
                let relative = path.strip_prefix(&root).unwrap();
                assert!(
                    relative
                        .components()
                        .all(|part| matches!(part, std::path::Component::Normal(_))),
                    "{}",
                    path.display()
                );
            }
        }
    }

    #[tokio::test]
    async fn discarding_a_draft_removes_only_its_staging_and_thread_copy() {
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::new(dir.path().into());
        let meta = attachment("draft", 4);
        let staged = store.pending_attachment_path("user", &meta.storage_id);
        tokio::fs::create_dir_all(staged.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(&staged, b"data").await.unwrap();
        let path = cache_attachment(&store, "user", "thread", &meta)
            .await
            .unwrap();
        let unrelated = store.pending_attachment_path("user", "other");
        tokio::fs::write(&unrelated, b"keep").await.unwrap();
        store
            .discard_attachment(
                "user",
                Some("thread"),
                &meta.image_upload_id,
                &meta.storage_id,
            )
            .await
            .unwrap();
        assert!(!path.exists());
        assert!(!staged.exists());
        assert!(unrelated.exists());
        assert!(
            store
                .clear_thread("user", "pending-attachments")
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn moves_staged_files_into_their_thread_without_size_or_count_caps() {
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::new(dir.path().into());
        let mut attachments = Vec::new();
        for id in 0..6 {
            let meta = attachment(&id.to_string(), 11 * 1024 * 1024);
            let staged = store.pending_attachment_path("user", &meta.storage_id);
            tokio::fs::create_dir_all(staged.parent().unwrap())
                .await
                .unwrap();
            tokio::fs::File::create(&staged)
                .await
                .unwrap()
                .set_len(meta.size)
                .await
                .unwrap();
            attachments.push(meta);
        }
        let mut parts = vec![TranscriptPart {
            number: 0,
            source_key: "prompt:0".into(),
            kind: TranscriptPartKind::Prompt,
            run_id: "run".into(),
            created_at: None,
            prompt: Some(TranscriptPromptBody {
                text: String::new(),
                image_uploads: attachments,
            }),
            completion: None,
            tool: None,
        }];
        cache_prompt_attachments(&store, "user", "thread", &mut parts)
            .await
            .unwrap();
        let prompt = parts[0].prompt.as_ref().unwrap();
        for meta in &prompt.image_uploads {
            let path = Path::new(meta.local_path.as_ref().unwrap());
            assert!(path.starts_with(store.thread_dir("user", "thread").join("attachments")));
            assert_eq!(tokio::fs::metadata(path).await.unwrap().len(), meta.size);
            assert!(
                !store
                    .pending_attachment_path("user", &meta.storage_id)
                    .exists()
            );
            assert!(!store.blob_data_path("user", &meta.storage_id).exists());
        }
        let text = crate::transcript::prompt_text_with_attachments(prompt);
        assert_eq!(text.matches("local transcript cache").count(), 1);
        assert_eq!(text.matches("file-.._notes.txt").count(), 6);
        store.clear_thread("user", "thread").await.unwrap();
        assert!(!store.thread_dir("user", "thread").exists());
    }

    #[tokio::test]
    async fn migrates_legacy_blobs_to_each_thread_and_reuses_cached_files_offline() {
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::new(dir.path().into());
        let meta = attachment("legacy", 4);
        store
            .write_blob(
                "user",
                &meta.storage_id,
                &meta.image_upload_id,
                &meta.media_type,
                &meta.name,
                b"data",
            )
            .await
            .unwrap();
        let first = cache_attachment(&store, "user", "first", &meta)
            .await
            .unwrap();
        let second = cache_attachment(&store, "user", "second", &meta)
            .await
            .unwrap();
        assert_ne!(first, second);
        assert_eq!(tokio::fs::read(&first).await.unwrap(), b"data");
        let offline = cache_attachment(&store, "user", "first", &meta)
            .await
            .unwrap();
        assert_eq!(offline, first);
        store.clear_thread("user", "first").await.unwrap();
        assert_eq!(tokio::fs::read(&second).await.unwrap(), b"data");
    }

    #[tokio::test]
    async fn rejects_corrupt_staging_without_publishing_partial_files() {
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::new(dir.path().into());
        let meta = attachment("bad", 5);
        let staged = store.pending_attachment_path("user", &meta.storage_id);
        tokio::fs::create_dir_all(staged.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(&staged, b"data").await.unwrap();
        assert!(
            cache_attachment(&store, "user", "thread", &meta)
                .await
                .is_err()
        );
        assert!(!store.attachment_path("user", "thread", &meta).exists());
        assert!(staged.exists());
    }

    #[tokio::test]
    async fn expired_remote_files_do_not_block_history_and_cached_files_remain_usable() {
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::new(dir.path().into());
        let cached = attachment("cached", 4);
        let missing = attachment("expired", 4);
        let staged = store.pending_attachment_path("user", &cached.storage_id);
        tokio::fs::create_dir_all(staged.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(staged, b"data").await.unwrap();
        let mut parts = vec![TranscriptPart {
            number: 0,
            source_key: "prompt:0".into(),
            kind: TranscriptPartKind::Prompt,
            run_id: "run".into(),
            created_at: None,
            prompt: Some(TranscriptPromptBody {
                text: "Continue".into(),
                image_uploads: vec![cached, missing],
            }),
            completion: None,
            tool: None,
        }];
        cache_prompt_attachments(&store, "user", "thread", &mut parts)
            .await
            .unwrap();
        let prompt = parts[0].prompt.as_ref().unwrap();
        assert!(prompt.image_uploads[0].local_path.is_some());
        assert!(prompt.image_uploads[1].local_path.is_none());
        let text = crate::transcript::prompt_text_with_attachments(prompt);
        assert!(text.contains("reattach"));
        assert!(text.contains("Continue"));
    }
}
