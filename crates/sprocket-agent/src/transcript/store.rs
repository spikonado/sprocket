use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, anyhow};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::Mutex;

use super::types::{
    TRANSCRIPT_CHUNK_SIZE, TRANSCRIPT_PAGE_SIZE, TranscriptPage, TranscriptPart, TranscriptState,
};

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

    pub fn thread_dir(&self, user_id: &str, thread_id: &str) -> PathBuf {
        self.root
            .join(safe_segment(user_id))
            .join(safe_segment(thread_id))
    }

    async fn lock_thread(&self, user_id: &str, thread_id: &str) -> Arc<Mutex<()>> {
        let key = format!("{user_id}/{thread_id}");
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
        if !tokio::fs::try_exists(&path).await? {
            return Ok(TranscriptState::new(
                user_id.to_string(),
                thread_id.to_string(),
            ));
        }
        let contents = tokio::fs::read_to_string(&path)
            .await
            .with_context(|| format!("failed to read {}", path.display()))?;
        serde_json::from_str(&contents).with_context(|| "failed to parse transcript state")
    }

    async fn write_state(
        &self,
        user_id: &str,
        thread_id: &str,
        state: &TranscriptState,
    ) -> anyhow::Result<()> {
        let dir = self.thread_dir(user_id, thread_id);
        tokio::fs::create_dir_all(dir.join("parts")).await?;
        let path = dir.join("state.json");
        let tmp = dir.join("state.json.tmp");
        let payload = serde_json::to_vec_pretty(state)?;
        tokio::fs::write(&tmp, payload).await?;
        tokio::fs::rename(&tmp, &path).await?;
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
        for part in parts {
            self.write_part_unlocked(user_id, thread_id, part).await?;
            state.mark_downloaded(&[part.number]);
        }
        self.write_state(user_id, thread_id, &state).await?;
        Ok(state)
    }

    async fn write_part_unlocked(
        &self,
        user_id: &str,
        thread_id: &str,
        part: &TranscriptPart,
    ) -> anyhow::Result<()> {
        let dir = self.thread_dir(user_id, thread_id).join("parts");
        tokio::fs::create_dir_all(&dir).await?;
        let path = chunk_path(&dir, part.number);
        recover_chunk(&path).await?;
        let existing = read_chunk_parts(&path).await?;
        if existing
            .iter()
            .any(|candidate| candidate.number == part.number)
        {
            return Ok(());
        }
        let mut file = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .await?;
        let mut line = serde_json::to_string(&part.without_ephemeral_urls())?;
        line.push('\n');
        file.write_all(line.as_bytes()).await?;
        file.flush().await?;
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
        let mut loaded_chunks = HashMap::new();
        for &number in numbers {
            let start = chunk_start(number);
            if !loaded_chunks.contains_key(&start) {
                let path = chunk_path(&dir, number);
                recover_chunk(&path).await?;
                loaded_chunks.insert(start, read_chunk_parts(&path).await?);
            }
            if let Some(part) = loaded_chunks
                .get(&start)
                .and_then(|parts| parts.iter().find(|part| part.number == number))
            {
                by_number.insert(number, part.clone());
            }
        }
        Ok(numbers
            .iter()
            .filter_map(|number| by_number.get(number).cloned())
            .collect())
    }

    pub async fn page(
        &self,
        user_id: &str,
        thread_id: &str,
        before: Option<u32>,
        limit: Option<u32>,
    ) -> anyhow::Result<TranscriptPage> {
        let state = self.load_state(user_id, thread_id).await?;
        let limit = limit
            .unwrap_or(TRANSCRIPT_PAGE_SIZE)
            .min(TRANSCRIPT_CHUNK_SIZE);
        let history_from = state.history_from_number;
        let end_exclusive = before.unwrap_or_else(|| state.visible_end_exclusive());
        if end_exclusive <= history_from {
            return Ok(TranscriptPage {
                thread_id: thread_id.to_string(),
                total_parts: state.remote_total_parts,
                history_from_number: history_from,
                stale: state.stale,
                parts: Vec::new(),
                next_before: None,
            });
        }
        let start = end_exclusive.saturating_sub(limit).max(history_from);
        let numbers: Vec<u32> = (start..end_exclusive).collect();
        let parts = self.read_parts(user_id, thread_id, &numbers).await?;
        Ok(TranscriptPage {
            thread_id: thread_id.to_string(),
            total_parts: state.remote_total_parts,
            history_from_number: history_from,
            stale: state.stale,
            parts,
            next_before: if start > history_from {
                Some(start)
            } else {
                None
            },
        })
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

    pub async fn read_blob(
        &self,
        user_id: &str,
        storage_id: &str,
    ) -> anyhow::Result<Option<Vec<u8>>> {
        let path = self.blob_data_path(user_id, storage_id);
        if !tokio::fs::try_exists(&path).await? {
            return Ok(None);
        }
        Ok(Some(tokio::fs::read(&path).await?))
    }

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

    pub async fn blob_for_upload(
        &self,
        user_id: &str,
        image_upload_id: &str,
    ) -> anyhow::Result<Option<StoredBlob>> {
        let index = self.upload_index_path(user_id, image_upload_id);
        if !tokio::fs::try_exists(&index).await? {
            return Ok(None);
        }
        let storage_id = tokio::fs::read_to_string(&index).await?;
        let Some(bytes) = self.read_blob(user_id, storage_id.trim()).await? else {
            return Ok(None);
        };
        let meta = self.read_blob_meta(user_id, storage_id.trim()).await?;
        Ok(Some(StoredBlob {
            storage_id: storage_id.trim().to_string(),
            media_type: meta
                .as_ref()
                .map(|meta| meta.media_type.clone())
                .unwrap_or_else(|| "application/octet-stream".to_string()),
            name: meta.map(|meta| meta.name).unwrap_or_default(),
            bytes,
        }))
    }

    pub async fn clear_thread(&self, user_id: &str, thread_id: &str) -> anyhow::Result<()> {
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

    fn blob_data_path(&self, user_id: &str, storage_id: &str) -> PathBuf {
        self.blobs_dir(user_id).join(safe_segment(storage_id))
    }

    fn blob_meta_path(&self, user_id: &str, storage_id: &str) -> PathBuf {
        self.blob_data_path(user_id, storage_id)
            .with_extension("json")
    }

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

#[derive(Clone, Debug)]
pub struct StoredBlob {
    pub storage_id: String,
    pub media_type: String,
    pub name: String,
    pub bytes: Vec<u8>,
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
        recover_chunk(&entry.path()).await?;
        for part in read_chunk_parts(&entry.path()).await? {
            if let Some(prompt) = &part.prompt {
                for upload in &prompt.image_uploads {
                    ids.insert(upload.storage_id.clone());
                }
            }
        }
    }
    Ok(ids)
}

async fn recover_chunk(path: &Path) -> anyhow::Result<()> {
    if !tokio::fs::try_exists(path).await? {
        return Ok(());
    }
    let contents = tokio::fs::read(path).await?;
    if contents.is_empty() {
        return Ok(());
    }
    let text = String::from_utf8_lossy(&contents);
    let mut valid = String::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if serde_json::from_str::<TranscriptPart>(trimmed).is_ok() {
            valid.push_str(trimmed);
            valid.push('\n');
        }
    }
    if valid.as_bytes() != contents {
        let tmp = path.with_extension("jsonl.tmp");
        tokio::fs::write(&tmp, valid.as_bytes()).await?;
        tokio::fs::rename(&tmp, path).await?;
    }
    Ok(())
}

async fn read_chunk_parts(path: &Path) -> anyhow::Result<Vec<TranscriptPart>> {
    if !tokio::fs::try_exists(path).await? {
        return Ok(Vec::new());
    }
    let file = tokio::fs::File::open(path).await?;
    let mut lines = BufReader::new(file).lines();
    let mut parts = Vec::new();
    while let Some(line) = lines.next_line().await? {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        match serde_json::from_str::<TranscriptPart>(trimmed) {
            Ok(part) => parts.push(part),
            Err(error) => return Err(anyhow!("invalid transcript chunk line: {error}")),
        }
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
            prompt: Some(TranscriptPromptBody {
                text: text.to_string(),
                image_uploads: Vec::new(),
            }),
            completion: None,
            tool: None,
        }
    }

    #[tokio::test]
    async fn appends_and_pages_newest_first() {
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
        let page = store.page("user", "thread", None, Some(2)).await.unwrap();
        assert_eq!(
            page.parts
                .iter()
                .map(|part| part.prompt.as_ref().unwrap().text.as_str())
                .collect::<Vec<_>>(),
            vec!["b", "c"]
        );
        assert_eq!(page.next_before, Some(1));
        store.clear_thread("user", "thread").await.unwrap();
        let _ = tokio::fs::remove_dir_all(dir).await;
    }

    #[tokio::test]
    async fn pages_local_parts_when_remote_total_lags() {
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
                state.remote_total_parts = 1;
                state
            })
            .await
            .unwrap();
        let page = store.page("user", "thread", None, None).await.unwrap();
        assert_eq!(
            page.parts
                .iter()
                .map(|part| part.prompt.as_ref().unwrap().text.as_str())
                .collect::<Vec<_>>(),
            vec!["a", "b", "c"]
        );
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
    async fn caches_blobs_and_purges_them_when_the_thread_is_cleared() {
        let dir =
            std::env::temp_dir().join(format!("sprocket-transcript-{}", uuid::Uuid::new_v4()));
        let store = TranscriptStore::new(dir.clone());
        let mut part = prompt(0, "pic");
        part.prompt.as_mut().unwrap().image_uploads.push(
            crate::transcript::types::TranscriptAttachmentMeta {
                image_upload_id: "upload-1".into(),
                name: "a.png".into(),
                media_type: "image/png".into(),
                size: 4,
                storage_id: "storage-1".into(),
                url: None,
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
        let blob = store
            .blob_for_upload("user", "upload-1")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(blob.bytes, b"data");
        store.clear_thread("user", "thread").await.unwrap();
        assert!(
            store
                .blob_for_upload("user", "upload-1")
                .await
                .unwrap()
                .is_none()
        );
        let _ = tokio::fs::remove_dir_all(dir).await;
    }
}
