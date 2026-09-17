use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

use tokio::sync::Mutex;

use super::store::{TranscriptStore, recover_and_read_chunk, safe_segment};
use super::types::TranscriptAttachmentMeta;

impl TranscriptStore {
    pub fn pending_attachment_path(&self, user_id: &str, storage_id: &str) -> PathBuf {
        self.root
            .join(safe_segment(user_id))
            .join("pending-attachments")
            .join(safe_segment(storage_id))
    }

    pub(crate) async fn lock_attachment(&self, user_id: &str, storage_id: &str) -> Arc<Mutex<()>> {
        self.lock_pending_path(&self.pending_attachment_path(user_id, storage_id))
            .await
    }

    async fn lock_pending_path(&self, path: &Path) -> Arc<Mutex<()>> {
        self.lock_key(format!("attachment:{}", path.display()))
            .await
    }

    pub async fn protect_pending_upload(&self, path: &Path) -> tokio::sync::OwnedMutexGuard<()> {
        self.lock_pending_path(path).await.lock_owned().await
    }

    pub async fn prune_pending_attachments(&self, cutoff: SystemTime) -> anyhow::Result<u64> {
        let mut users = match tokio::fs::read_dir(&self.root).await {
            Ok(users) => users,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
            Err(error) => return Err(error.into()),
        };
        let mut removed = 0;
        while let Some(user) = users.next_entry().await? {
            if !user.file_type().await?.is_dir() {
                continue;
            }
            let directory = user.path().join("pending-attachments");
            let metadata = match tokio::fs::symlink_metadata(&directory).await {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.into()),
            };
            if !metadata.is_dir() {
                continue;
            }
            let mut files = tokio::fs::read_dir(directory).await?;
            while let Some(file) = files.next_entry().await? {
                let path = file.path();
                let lock = self.lock_pending_path(&path).await;
                let Ok(_guard) = lock.try_lock() else {
                    continue;
                };
                let metadata = match tokio::fs::symlink_metadata(&path).await {
                    Ok(metadata) => metadata,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(error) => return Err(error.into()),
                };
                if metadata.is_file() && metadata.modified()? <= cutoff {
                    match tokio::fs::remove_file(&path).await {
                        Ok(()) => removed += 1,
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                        Err(error) => eprintln!(
                            "sprocket-agent: failed to expire {}: {error}",
                            path.display()
                        ),
                    }
                }
            }
        }
        Ok(removed)
    }

    pub fn attachment_path(
        &self,
        user_id: &str,
        thread_id: &str,
        attachment: &TranscriptAttachmentMeta,
    ) -> PathBuf {
        let mut name: String = attachment
            .name
            .chars()
            .map(|ch| {
                if ch.is_control()
                    || matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
                {
                    '_'
                } else {
                    ch
                }
            })
            .collect();
        if name.len() > 200 {
            let extension = Path::new(&name)
                .extension()
                .and_then(|ext| ext.to_str())
                .filter(|ext| ext.len() <= 20)
                .map(|ext| format!(".{ext}"))
                .unwrap_or_default();
            while name.len() > 200 - extension.len() {
                name.pop();
            }
            name.push_str(&extension);
        }
        let name = name.trim_end_matches(['.', ' ']);
        self.thread_dir(user_id, thread_id)
            .join("attachments")
            .join(safe_segment(&attachment.storage_id))
            .join(format!("file-{name}"))
    }

    pub async fn save_attachment_metadata(
        &self,
        user_id: &str,
        thread_id: &str,
        attachment: &TranscriptAttachmentMeta,
    ) -> anyhow::Result<()> {
        let dir = self
            .thread_dir(user_id, thread_id)
            .join("attachments")
            .join(safe_segment(&attachment.storage_id));
        tokio::fs::create_dir_all(&dir).await?;
        let mut meta = attachment.clone();
        meta.url = None;
        meta.local_path = None;
        let temp = tempfile::NamedTempFile::new_in(&dir)?;
        tokio::fs::write(temp.path(), serde_json::to_vec(&meta)?).await?;
        temp.persist(dir.join("metadata.json"))?;
        Ok(())
    }

    pub async fn attachment_metadata(
        &self,
        user_id: &str,
        thread_id: &str,
        storage_id: &str,
    ) -> anyhow::Result<Option<TranscriptAttachmentMeta>> {
        let path = self
            .thread_dir(user_id, thread_id)
            .join("attachments")
            .join(safe_segment(storage_id))
            .join("metadata.json");
        match tokio::fs::read(path).await {
            Ok(bytes) => {
                let meta: TranscriptAttachmentMeta = serde_json::from_slice(&bytes)?;
                anyhow::ensure!(
                    meta.storage_id == storage_id,
                    "cached attachment identity mismatch"
                );
                Ok(Some(meta))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let state = self.load_state(user_id, thread_id).await?;
                let numbers = state
                    .downloaded_ranges
                    .iter()
                    .flat_map(|range| range.start..=range.end)
                    .collect::<Vec<_>>();
                let meta = self
                    .read_parts(user_id, thread_id, &numbers)
                    .await?
                    .into_iter()
                    .filter_map(|part| part.prompt)
                    .flat_map(|prompt| prompt.image_uploads)
                    .find(|attachment| attachment.storage_id == storage_id);
                match meta {
                    Some(meta) => Ok(Some(meta)),
                    None => self.legacy_blob_metadata(user_id, storage_id).await,
                }
            }
            Err(error) => Err(error.into()),
        }
    }

    async fn legacy_blob_metadata(
        &self,
        user_id: &str,
        storage_id: &str,
    ) -> anyhow::Result<Option<TranscriptAttachmentMeta>> {
        let file = match tokio::fs::metadata(self.blob_data_path(user_id, storage_id)).await {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let meta = self.read_blob_meta(user_id, storage_id).await?;
        Ok(Some(TranscriptAttachmentMeta {
            storage_id: storage_id.to_string(),
            name: meta
                .as_ref()
                .map(|meta| meta.name.clone())
                .unwrap_or_default(),
            media_type: meta
                .map(|meta| meta.media_type)
                .unwrap_or_else(|| "application/octet-stream".into()),
            size: file.len(),
            url: None,
            local_path: None,
        }))
    }

    pub async fn discard_attachment(
        &self,
        user_id: &str,
        thread_id: Option<&str>,
        storage_id: &str,
    ) -> anyhow::Result<()> {
        let lock = self.lock_attachment(user_id, storage_id).await;
        let _guard = lock.lock().await;
        if let Err(error) =
            tokio::fs::remove_file(self.pending_attachment_path(user_id, storage_id)).await
        {
            if error.kind() != std::io::ErrorKind::NotFound {
                return Err(error.into());
            }
        }
        if let Some(thread_id) = thread_id {
            let dir = self
                .thread_dir(user_id, thread_id)
                .join("attachments")
                .join(safe_segment(storage_id));
            if let Err(error) = tokio::fs::remove_dir_all(dir).await {
                if error.kind() != std::io::ErrorKind::NotFound {
                    return Err(error.into());
                }
            }
        }
        Ok(())
    }

    #[cfg(test)]
    pub async fn write_blob(
        &self,
        user_id: &str,
        storage_id: &str,
        image_upload_id: &str,
        media_type: &str,
        name: &str,
        bytes: &[u8],
    ) -> anyhow::Result<()> {
        let lock = self.lock_thread(user_id, "__blobs__").await;
        let _guard = lock.lock().await;
        let blobs = self.blobs_dir(user_id);
        tokio::fs::create_dir_all(blobs.join("uploads")).await?;
        let data_path = self.blob_data_path(user_id, storage_id);
        let tmp = data_path.with_extension("tmp");
        tokio::fs::write(&tmp, bytes).await?;
        tokio::fs::rename(&tmp, &data_path).await?;
        let meta = BlobMeta {
            storage_id: storage_id.to_string(),
            media_type: media_type.to_string(),
            name: name.to_string(),
        };
        tokio::fs::write(
            self.blob_meta_path(user_id, storage_id),
            serde_json::to_vec(&meta)?,
        )
        .await?;
        tokio::fs::write(
            self.upload_index_path(user_id, image_upload_id),
            storage_id.as_bytes(),
        )
        .await?;
        Ok(())
    }

    fn blobs_dir(&self, user_id: &str) -> PathBuf {
        self.root.join(safe_segment(user_id)).join("blobs")
    }

    pub fn blob_data_path(&self, user_id: &str, storage_id: &str) -> PathBuf {
        self.blobs_dir(user_id).join(safe_segment(storage_id))
    }

    fn blob_meta_path(&self, user_id: &str, storage_id: &str) -> PathBuf {
        self.blob_data_path(user_id, storage_id)
            .with_extension("json")
    }

    #[cfg(test)]
    fn upload_index_path(&self, user_id: &str, image_upload_id: &str) -> PathBuf {
        self.blobs_dir(user_id)
            .join("uploads")
            .join(safe_segment(image_upload_id))
    }

    async fn read_blob_meta(
        &self,
        user_id: &str,
        storage_id: &str,
    ) -> anyhow::Result<Option<BlobMeta>> {
        let path = self.blob_meta_path(user_id, storage_id);
        if !tokio::fs::try_exists(&path).await? {
            return Ok(None);
        }
        Ok(Some(serde_json::from_str(
            &tokio::fs::read_to_string(&path).await?,
        )?))
    }

    async fn referenced_storage_ids(&self, user_id: &str) -> anyhow::Result<HashSet<String>> {
        let mut ids = HashSet::new();
        let user_dir = self.root.join(safe_segment(user_id));
        if !tokio::fs::try_exists(&user_dir).await? {
            return Ok(ids);
        }
        let mut entries = tokio::fs::read_dir(&user_dir).await?;
        while let Some(entry) = entries.next_entry().await? {
            if entry.file_name() == "blobs" || !entry.file_type().await?.is_dir() {
                continue;
            }
            ids.extend(storage_ids_from_parts_dir(&entry.path().join("parts")).await?);
        }
        Ok(ids)
    }

    pub(super) async fn purge_unreferenced_blobs(
        &self,
        user_id: &str,
        candidates: &HashSet<String>,
    ) -> anyhow::Result<()> {
        if candidates.is_empty() {
            return Ok(());
        }
        let lock = self.lock_thread(user_id, "__blobs__").await;
        let _guard = lock.lock().await;
        let still_referenced = self.referenced_storage_ids(user_id).await?;
        for storage_id in candidates {
            if still_referenced.contains(storage_id) {
                continue;
            }
            let data_path = self.blob_data_path(user_id, storage_id);
            let meta_path = self.blob_meta_path(user_id, storage_id);
            if tokio::fs::try_exists(&data_path).await? {
                tokio::fs::remove_file(&data_path).await?;
            }
            if tokio::fs::try_exists(&meta_path).await? {
                tokio::fs::remove_file(&meta_path).await?;
            }
        }
        let uploads = self.blobs_dir(user_id).join("uploads");
        if tokio::fs::try_exists(&uploads).await? {
            let mut entries = tokio::fs::read_dir(&uploads).await?;
            while let Some(entry) = entries.next_entry().await? {
                let storage_id = tokio::fs::read_to_string(entry.path()).await?;
                if !still_referenced.contains(storage_id.trim()) {
                    tokio::fs::remove_file(entry.path()).await?;
                }
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct BlobMeta {
    storage_id: String,
    media_type: String,
    name: String,
}

pub(super) async fn storage_ids_from_parts_dir(
    parts_dir: &Path,
) -> anyhow::Result<HashSet<String>> {
    let mut ids = HashSet::new();
    if !tokio::fs::try_exists(parts_dir).await? {
        return Ok(ids);
    }
    let mut entries = tokio::fs::read_dir(parts_dir).await?;
    while let Some(entry) = entries.next_entry().await? {
        if entry.path().extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
            continue;
        }
        for part in recover_and_read_chunk(&entry.path()).await? {
            if let Some(prompt) = &part.prompt {
                for upload in &prompt.image_uploads {
                    ids.insert(upload.storage_id.clone());
                }
            }
        }
    }
    Ok(ids)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transcript::types::{TranscriptPart, TranscriptPartKind, TranscriptPromptBody};

    #[tokio::test]
    async fn caches_blobs_and_purges_them_when_the_thread_is_cleared() {
        let dir =
            std::env::temp_dir().join(format!("sprocket-transcript-{}", uuid::Uuid::new_v4()));
        let store = TranscriptStore::new(dir.clone());
        let part = TranscriptPart {
            number: 0,
            source_key: "prompt:0".into(),
            kind: TranscriptPartKind::Prompt,
            run_id: "run-0".into(),
            created_at: None,
            prompt: Some(TranscriptPromptBody {
                text: "pic".into(),
                image_uploads: vec![TranscriptAttachmentMeta {
                    name: "a.png".into(),
                    media_type: "image/png".into(),
                    size: 4,
                    storage_id: "storage-1".into(),
                    url: None,
                    local_path: None,
                }],
            }),
            completion: None,
            tool: None,
            work: Default::default(),
        };
        store.append_parts("user", "thread", &[part]).await.unwrap();
        store
            .write_blob(
                "user",
                "storage-1",
                "upload-1",
                "image/png",
                "a.png",
                b"data",
            )
            .await
            .unwrap();
        let meta = store
            .attachment_metadata("user", "thread", "storage-1")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(meta.storage_id, "storage-1");
        assert_eq!(meta.name, "a.png");
        assert_eq!(meta.media_type, "image/png");
        assert_eq!(meta.size, 4);
        assert_eq!(
            tokio::fs::read(store.blob_data_path("user", &meta.storage_id))
                .await
                .unwrap(),
            b"data"
        );
        store.clear_thread("user", "thread").await.unwrap();
        assert!(
            store
                .attachment_metadata("user", "thread", "storage-1")
                .await
                .unwrap()
                .is_none()
        );
        let _ = tokio::fs::remove_dir_all(dir).await;
    }
}
