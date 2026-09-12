use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

use anyhow::Context;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

use super::types::{TRANSCRIPT_CHUNK_SIZE, TranscriptPart, TranscriptState};

fn safe_segment(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if matches!(ch, '/' | '\\' | ':' | '.') {
                '_'
            } else {
                ch
            }
        })
        .collect()
}

fn display_cache_segment(value: &str) -> anyhow::Result<&str> {
    if value.is_empty()
        || value.contains("..")
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'(' | b')'))
    {
        anyhow::bail!("invalid transcript display cache component");
    }
    Ok(value)
}

fn chunk_start(number: u32) -> u32 {
    number / TRANSCRIPT_CHUNK_SIZE * TRANSCRIPT_CHUNK_SIZE
}

pub struct TranscriptStore {
    root: PathBuf,
    locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

impl TranscriptStore {
    pub fn new(root: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            root,
            locks: Mutex::new(HashMap::new()),
        })
    }

    pub fn root(&self) -> PathBuf {
        self.root.clone()
    }

    pub(super) fn display_cache_path(
        &self,
        user_id: &str,
        thread_id: &str,
        key: &str,
    ) -> anyhow::Result<PathBuf> {
        Ok(self
            .root
            .join(display_cache_segment(user_id)?)
            .join(display_cache_segment(thread_id)?)
            .join("display-v1")
            .join(display_cache_segment(key)?))
    }

    pub fn thread_dir(&self, user_id: &str, thread_id: &str) -> PathBuf {
        self.root
            .join(safe_segment(user_id))
            .join(safe_segment(thread_id))
    }

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
                        Err(error) => {
                            eprintln!(
                                "sprocket-agent: failed to expire {}: {error}",
                                path.display()
                            );
                        }
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
        attachment: &super::types::TranscriptAttachmentMeta,
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
        attachment: &super::types::TranscriptAttachmentMeta,
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
    ) -> anyhow::Result<Option<super::types::TranscriptAttachmentMeta>> {
        let path = self
            .thread_dir(user_id, thread_id)
            .join("attachments")
            .join(safe_segment(storage_id))
            .join("metadata.json");
        match tokio::fs::read(path).await {
            Ok(bytes) => {
                let meta: super::types::TranscriptAttachmentMeta = serde_json::from_slice(&bytes)?;
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
    ) -> anyhow::Result<Option<super::types::TranscriptAttachmentMeta>> {
        let file = match tokio::fs::metadata(self.blob_data_path(user_id, storage_id)).await {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let meta = self.read_blob_meta(user_id, storage_id).await?;
        Ok(Some(super::types::TranscriptAttachmentMeta {
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

    pub(crate) async fn lock_thread(&self, user_id: &str, thread_id: &str) -> Arc<Mutex<()>> {
        self.lock_key(format!("{user_id}/{thread_id}")).await
    }

    async fn lock_key(&self, key: String) -> Arc<Mutex<()>> {
        let mut locks = self.locks.lock().await;
        locks
            .entry(key)
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    pub async fn load_state(
        &self,
        user_id: &str,
        thread_id: &str,
    ) -> anyhow::Result<TranscriptState> {
        let path = self.thread_dir(user_id, thread_id).join("state.json");
        let contents = match tokio::fs::read_to_string(&path).await {
            Ok(contents) => contents,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(TranscriptState::new(
                    user_id.to_string(),
                    thread_id.to_string(),
                ));
            }
            Err(error) => {
                return Err(error).with_context(|| format!("failed to read {}", path.display()));
            }
        };
        serde_json::from_str(&contents)
            .with_context(|| format!("failed to parse transcript state {}", path.display()))
    }

    async fn write_state(
        &self,
        user_id: &str,
        thread_id: &str,
        state: &TranscriptState,
    ) -> anyhow::Result<()> {
        let dir = self.thread_dir(user_id, thread_id);
        let parts_dir = dir.join("parts");
        tokio::fs::create_dir_all(&parts_dir)
            .await
            .with_context(|| {
                format!(
                    "failed to create transcript directory {}",
                    parts_dir.display()
                )
            })?;
        let path = dir.join("state.json");
        let payload = serde_json::to_vec_pretty(state)?;
        let temporary = tempfile::NamedTempFile::new_in(&dir).with_context(|| {
            format!(
                "failed to create temporary transcript state in {}",
                dir.display()
            )
        })?;
        let (file, temporary_path) = temporary.into_parts();
        let mut file = tokio::fs::File::from_std(file);
        file.write_all(&payload)
            .await
            .with_context(|| format!("failed to write transcript state {}", path.display()))?;
        file.flush()
            .await
            .with_context(|| format!("failed to flush transcript state {}", path.display()))?;
        drop(file);
        temporary_path
            .persist(&path)
            .with_context(|| format!("failed to publish transcript state {}", path.display()))?;
        Ok(())
    }

    pub async fn save_state(
        &self,
        user_id: &str,
        thread_id: &str,
        state: &TranscriptState,
    ) -> anyhow::Result<()> {
        let lock = self.lock_thread(user_id, thread_id).await;
        let _guard = lock.lock().await;
        self.write_state(user_id, thread_id, state).await
    }

    pub async fn update_state<F>(
        &self,
        user_id: &str,
        thread_id: &str,
        update: F,
    ) -> anyhow::Result<TranscriptState>
    where
        F: FnOnce(&mut TranscriptState),
    {
        let lock = self.lock_thread(user_id, thread_id).await;
        let _guard = lock.lock().await;
        let mut state = self.load_state(user_id, thread_id).await?;
        update(&mut state);
        self.write_state(user_id, thread_id, &state).await?;
        Ok(state)
    }

    pub async fn append_parts(
        &self,
        user_id: &str,
        thread_id: &str,
        parts: &[TranscriptPart],
    ) -> anyhow::Result<TranscriptState> {
        let lock = self.lock_thread(user_id, thread_id).await;
        let _guard = lock.lock().await;
        let mut state = self.load_state(user_id, thread_id).await?;
        self.write_parts_unlocked(user_id, thread_id, parts).await?;
        if !parts.is_empty() {
            let numbers = parts.iter().map(|part| part.number).collect::<Vec<_>>();
            state.mark_downloaded(&numbers);
        }
        self.write_state(user_id, thread_id, &state).await?;
        Ok(state)
    }

    async fn write_parts_unlocked(
        &self,
        user_id: &str,
        thread_id: &str,
        parts: &[TranscriptPart],
    ) -> anyhow::Result<()> {
        if parts.is_empty() {
            return Ok(());
        }
        let dir = self.thread_dir(user_id, thread_id).join("parts");
        tokio::fs::create_dir_all(&dir).await?;
        let mut grouped: HashMap<u32, Vec<&TranscriptPart>> = HashMap::new();
        let mut starts = Vec::new();
        for part in parts {
            let start = chunk_start(part.number);
            grouped
                .entry(start)
                .or_insert_with(|| {
                    starts.push(start);
                    Vec::new()
                })
                .push(part);
        }
        for start in starts {
            let path = chunk_path(&dir, start);
            let existing = recover_and_read_chunk(&path).await?;
            let mut seen = existing
                .into_iter()
                .map(|part| part.number)
                .collect::<HashSet<_>>();
            let mut file = None;
            for part in grouped
                .remove(&start)
                .expect("chunk start was recorded while grouping")
            {
                if !seen.insert(part.number) {
                    continue;
                }
                if file.is_none() {
                    file = Some(
                        tokio::fs::OpenOptions::new()
                            .create(true)
                            .append(true)
                            .open(&path)
                            .await?,
                    );
                }
                let mut line = serde_json::to_string(&part.without_ephemeral_urls())?;
                line.push('\n');
                let file = file.as_mut().expect("append file opened above");
                file.write_all(line.as_bytes()).await?;
                file.flush().await?;
            }
        }
        Ok(())
    }

    pub async fn read_parts(
        &self,
        user_id: &str,
        thread_id: &str,
        numbers: &[u32],
    ) -> anyhow::Result<Vec<TranscriptPart>> {
        let lock = self.lock_thread(user_id, thread_id).await;
        let _guard = lock.lock().await;
        let dir = self.thread_dir(user_id, thread_id).join("parts");
        let mut by_number = HashMap::new();
        let mut loaded_chunks = HashSet::new();
        for &number in numbers {
            let start = chunk_start(number);
            if loaded_chunks.insert(start) {
                for part in recover_and_read_chunk(&chunk_path(&dir, number)).await? {
                    by_number.entry(part.number).or_insert(part);
                }
            }
        }
        Ok(numbers
            .iter()
            .filter_map(|number| by_number.get(number).cloned())
            .collect())
    }

    pub async fn has_complete_range(
        &self,
        user_id: &str,
        thread_id: &str,
        start: u32,
        end_exclusive: u32,
    ) -> anyhow::Result<bool> {
        Ok(self
            .missing_numbers(user_id, thread_id, start, end_exclusive)
            .await?
            .is_empty())
    }

    pub async fn missing_numbers(
        &self,
        user_id: &str,
        thread_id: &str,
        start: u32,
        end_exclusive: u32,
    ) -> anyhow::Result<Vec<u32>> {
        let numbers: Vec<u32> = (start..end_exclusive).collect();
        if numbers.is_empty() {
            return Ok(Vec::new());
        }
        let mut missing = Vec::new();
        for chunk in numbers.chunks(TRANSCRIPT_CHUNK_SIZE as usize) {
            let parts = self.read_parts(user_id, thread_id, chunk).await?;
            let have: HashSet<u32> = parts.iter().map(|part| part.number).collect();
            missing.extend(
                chunk
                    .iter()
                    .copied()
                    .filter(|number| !have.contains(number)),
            );
        }
        Ok(missing)
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

    pub async fn clear_thread(&self, user_id: &str, thread_id: &str) -> anyhow::Result<()> {
        anyhow::ensure!(
            !thread_id.is_empty()
                && !thread_id.eq_ignore_ascii_case("blobs")
                && !thread_id.eq_ignore_ascii_case("pending-attachments")
                && thread_id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')),
            "invalid transcript thread ID"
        );
        let lock = self.lock_thread(user_id, thread_id).await;
        let _guard = lock.lock().await;
        let referenced =
            storage_ids_from_parts_dir(&self.thread_dir(user_id, thread_id).join("parts")).await?;
        let dir = self.thread_dir(user_id, thread_id);
        if tokio::fs::try_exists(&dir).await? {
            tokio::fs::remove_dir_all(&dir).await?;
        }
        drop(_guard);
        self.purge_unreferenced_blobs(user_id, &referenced).await
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

    async fn purge_unreferenced_blobs(
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

fn chunk_path(dir: &Path, number: u32) -> PathBuf {
    dir.join(format!("{:08}.jsonl", chunk_start(number)))
}

async fn storage_ids_from_parts_dir(parts_dir: &Path) -> anyhow::Result<HashSet<String>> {
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

async fn recover_and_read_chunk(path: &Path) -> anyhow::Result<Vec<TranscriptPart>> {
    if !tokio::fs::try_exists(path).await? {
        return Ok(Vec::new());
    }
    let contents = tokio::fs::read(path).await?;
    if contents.is_empty() {
        return Ok(Vec::new());
    }
    let text = String::from_utf8_lossy(&contents);
    let mut valid = String::new();
    let mut parts = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(part) = serde_json::from_str::<TranscriptPart>(trimmed) {
            valid.push_str(trimmed);
            valid.push('\n');
            parts.push(part);
        }
    }
    if valid.as_bytes() != contents {
        let tmp = path.with_extension("jsonl.tmp");
        tokio::fs::write(&tmp, valid.as_bytes()).await?;
        tokio::fs::rename(&tmp, path).await?;
    }
    Ok(parts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transcript::types::{TranscriptPartKind, TranscriptPromptBody};

    fn prompt(number: u32, text: &str) -> TranscriptPart {
        TranscriptPart {
            number,
            source_key: format!("prompt:{number}"),
            kind: TranscriptPartKind::Prompt,
            run_id: format!("run-{number}"),
            created_at: None,
            prompt: Some(TranscriptPromptBody {
                text: text.to_string(),
                image_uploads: Vec::new(),
            }),
            completion: None,
            tool: None,
        }
    }

    #[tokio::test]
    async fn only_missing_state_is_treated_as_an_empty_cache() {
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::new(dir.path().to_path_buf());
        assert_eq!(
            store.load_state("user", "thread").await.unwrap(),
            TranscriptState::new("user".into(), "thread".into())
        );
        let path = store.thread_dir("user", "thread").join("state.json");
        std::fs::create_dir_all(&path).unwrap();
        let error = store.load_state("user", "thread").await.unwrap_err();
        assert!(error.to_string().contains(path.to_str().unwrap()));
        std::fs::remove_dir(&path).unwrap();
        std::fs::write(&path, "invalid JSON").unwrap();
        let error = store.load_state("user", "thread").await.unwrap_err();
        assert!(error.to_string().contains(path.to_str().unwrap()));
        assert_eq!(std::fs::read_to_string(path).unwrap(), "invalid JSON");
    }

    #[tokio::test]
    async fn independent_state_writers_do_not_share_temporary_files() {
        let dir = tempfile::tempdir().unwrap();
        let writes = (0..32).map(|number| {
            let store = TranscriptStore::new(dir.path().to_path_buf());
            async move {
                let mut state = TranscriptState::new("user".into(), "thread".into());
                state.remote_total_parts = number;
                store.save_state("user", "thread", &state).await
            }
        });
        for result in futures::future::join_all(writes).await {
            result.expect("concurrent state publication should succeed");
        }
        let store = TranscriptStore::new(dir.path().to_path_buf());
        let state = store.load_state("user", "thread").await.unwrap();
        assert!(state.remote_total_parts < 32);
        let files = std::fs::read_dir(store.thread_dir("user", "thread"))
            .unwrap()
            .count();
        assert_eq!(files, 2, "only state.json and parts should remain");
    }

    #[tokio::test]
    async fn shared_store_preserves_concurrent_part_updates() {
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::new(dir.path().to_path_buf());
        let writes = (0..32).map(|number| {
            let store = Arc::clone(&store);
            async move {
                store
                    .append_parts("user", "thread", &[prompt(number, "hello")])
                    .await
            }
        });
        for result in futures::future::join_all(writes).await {
            result.unwrap();
        }
        let numbers = (0..32).collect::<Vec<_>>();
        let parts = store.read_parts("user", "thread", &numbers).await.unwrap();
        assert_eq!(parts.len(), numbers.len());
        let state = store.load_state("user", "thread").await.unwrap();
        assert!(numbers.iter().all(|number| state.covers(*number)));
    }

    #[tokio::test]
    async fn preserves_created_at_on_disk() {
        let dir =
            std::env::temp_dir().join(format!("sprocket-created-at-{}", uuid::Uuid::new_v4()));
        let store = TranscriptStore::new(dir.clone());
        let mut part = prompt(0, "hello");
        part.created_at = Some(1_700_000_000_000);
        store.append_parts("user", "thread", &[part]).await.unwrap();
        let read = store.read_parts("user", "thread", &[0]).await.unwrap();
        assert_eq!(read[0].created_at, Some(1_700_000_000_000));
        let chunk = tokio::fs::read_to_string(
            store
                .thread_dir("user", "thread")
                .join("parts")
                .join("00000000.jsonl"),
        )
        .await
        .unwrap();
        assert!(chunk.contains("\"createdAt\":1700000000000"));
        let _ = tokio::fs::remove_dir_all(dir).await;
    }

    #[tokio::test]
    async fn appends_reads_and_clears_parts() {
        let dir =
            std::env::temp_dir().join(format!("sprocket-transcript-{}", uuid::Uuid::new_v4()));
        let store = TranscriptStore::new(dir.clone());
        store
            .append_parts(
                "user",
                "thread",
                &[prompt(0, "a"), prompt(1, "b"), prompt(2, "c")],
            )
            .await
            .unwrap();
        store
            .save_state("user", "thread", &{
                let mut state = store.load_state("user", "thread").await.unwrap();
                state.remote_total_parts = 3;
                state
            })
            .await
            .unwrap();
        let parts = store.read_parts("user", "thread", &[1, 2]).await.unwrap();
        assert_eq!(
            parts
                .iter()
                .map(|part| part.prompt.as_ref().unwrap().text.as_str())
                .collect::<Vec<_>>(),
            vec!["b", "c"]
        );
        for invalid_id in ["", "blobs", "BLOBS", "blobs ", "../thread"] {
            assert!(store.clear_thread("user", invalid_id).await.is_err());
        }
        assert_eq!(
            store
                .read_parts("user", "thread", &[0, 1, 2])
                .await
                .unwrap()
                .len(),
            3
        );
        store.clear_thread("user", "thread").await.unwrap();
        let _ = tokio::fs::remove_dir_all(dir).await;
    }

    #[tokio::test]
    async fn recovers_a_torn_final_jsonl_line() {
        let dir =
            std::env::temp_dir().join(format!("sprocket-transcript-{}", uuid::Uuid::new_v4()));
        let store = TranscriptStore::new(dir.clone());
        store
            .append_parts("user", "thread", &[prompt(0, "ok")])
            .await
            .unwrap();
        let chunk = store
            .thread_dir("user", "thread")
            .join("parts")
            .join("00000000.jsonl");
        let mut contents = tokio::fs::read(&chunk).await.unwrap();
        contents.extend_from_slice(b"{\"number\":1,");
        tokio::fs::write(&chunk, contents).await.unwrap();
        let parts = store.read_parts("user", "thread", &[0, 1]).await.unwrap();
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].number, 0);
        assert_eq!(
            store.missing_numbers("user", "thread", 0, 2).await.unwrap(),
            vec![1]
        );
        let _ = tokio::fs::remove_dir_all(dir).await;
    }

    #[tokio::test]
    async fn append_parts_keeps_the_first_write_for_a_number() {
        let dir =
            std::env::temp_dir().join(format!("sprocket-transcript-dup-{}", uuid::Uuid::new_v4()));
        let store = TranscriptStore::new(dir.clone());
        store
            .append_parts(
                "user",
                "thread",
                &[prompt(0, "first"), prompt(0, "dup"), prompt(1, "second")],
            )
            .await
            .unwrap();
        store
            .append_parts(
                "user",
                "thread",
                &[prompt(1, "ignored"), prompt(2, "third")],
            )
            .await
            .unwrap();
        let parts = store
            .read_parts("user", "thread", &[0, 1, 2])
            .await
            .unwrap();
        assert_eq!(
            parts
                .iter()
                .map(|part| part.prompt.as_ref().unwrap().text.as_str())
                .collect::<Vec<_>>(),
            vec!["first", "second", "third"]
        );
        let chunk = store
            .thread_dir("user", "thread")
            .join("parts")
            .join("00000000.jsonl");
        let contents = tokio::fs::read_to_string(&chunk).await.unwrap();
        assert_eq!(
            contents
                .lines()
                .filter(|line| !line.trim().is_empty())
                .count(),
            3
        );
        let _ = tokio::fs::remove_dir_all(dir).await;
    }

    #[tokio::test]
    async fn caches_blobs_and_purges_them_when_the_thread_is_cleared() {
        let dir =
            std::env::temp_dir().join(format!("sprocket-transcript-{}", uuid::Uuid::new_v4()));
        let store = TranscriptStore::new(dir.clone());
        let mut part = prompt(0, "pic");
        part.prompt.as_mut().unwrap().image_uploads.push(
            crate::transcript::types::TranscriptAttachmentMeta {
                name: "a.png".into(),
                media_type: "image/png".into(),
                size: 4,
                storage_id: "storage-1".into(),
                url: None,
                local_path: None,
            },
        );
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
