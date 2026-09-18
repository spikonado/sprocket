use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

use tokio::sync::Mutex;

use super::store::{TranscriptStore, safe_segment};
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
                    None => Ok(None),
                }
            }
            Err(error) => Err(error.into()),
        }
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
}
