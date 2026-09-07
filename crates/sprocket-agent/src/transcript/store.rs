use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::Context;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

use super::paging::{message_page_start, parts_window};
use super::projection::{project_messages, project_part};
use super::types::{
    TRANSCRIPT_CHUNK_SIZE, TRANSCRIPT_PAGE_SIZE, TranscriptMessage, TranscriptPage, TranscriptPart,
    TranscriptPartRecord, TranscriptPartsPage, TranscriptState,
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
            .clamp(1, TRANSCRIPT_CHUNK_SIZE);
        // Compaction limits model context, not what the user may scroll back to.
        let history_from = 0;
        let end_exclusive = before
            .unwrap_or_else(|| state.visible_end_exclusive())
            .min(state.visible_end_exclusive());
        if end_exclusive <= history_from {
            return Ok(TranscriptPage {
                thread_id: thread_id.to_string(),
                total_parts: state.remote_total_parts,
                history_from_number: state.history_from_number,
                stale: state.stale,
                messages: Vec::new(),
                next_before: None,
            });
        }
        let mut scan_end = end_exclusive;
        let mut parts = Vec::new();
        let start = loop {
            let scan_start = scan_end.saturating_sub(TRANSCRIPT_CHUNK_SIZE);
            let numbers: Vec<u32> = (scan_start..scan_end).collect();
            let mut batch = self.read_parts(user_id, thread_id, &numbers).await?;
            batch.append(&mut parts);
            parts = batch;
            if let Some(start) = message_page_start(&parts, limit, scan_start == history_from) {
                break start;
            }
            if scan_start == history_from {
                break history_from;
            }
            scan_end = scan_start;
        };
        parts.retain(|part| part.number >= start);
        let messages = project_messages(user_id, thread_id, parts, false);
        Ok(TranscriptPage {
            thread_id: thread_id.to_string(),
            total_parts: state.remote_total_parts,
            history_from_number: state.history_from_number,
            stale: state.stale,
            messages,
            next_before: if start > history_from {
                Some(start)
            } else {
                None
            },
        })
    }

    pub async fn parts_page(
        &self,
        user_id: &str,
        thread_id: &str,
        before: Option<u32>,
        limit: Option<u32>,
    ) -> anyhow::Result<TranscriptPartsPage> {
        let state = self.load_state(user_id, thread_id).await?;
        let (start, end_exclusive) = parts_window(state.visible_end_exclusive(), before, limit);
        if start >= end_exclusive {
            return Ok(TranscriptPartsPage {
                thread_id: thread_id.to_string(),
                total_parts: state.remote_total_parts,
                history_from_number: state.history_from_number,
                stale: state.stale,
                parts: Vec::new(),
                next_before: None,
            });
        }
        let numbers: Vec<u32> = (start..end_exclusive).collect();
        let parts = self.read_parts(user_id, thread_id, &numbers).await?;
        anyhow::ensure!(
            parts.len() == numbers.len(),
            "incomplete transcript history"
        );
        Ok(TranscriptPartsPage {
            thread_id: thread_id.to_string(),
            total_parts: state.remote_total_parts,
            history_from_number: state.history_from_number,
            stale: state.stale,
            parts: parts
                .into_iter()
                .map(|part| project_part(user_id, thread_id, part, false))
                .collect(),
            next_before: if start > 0 { Some(start) } else { None },
        })
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

    pub async fn has_complete_message_page(
        &self,
        user_id: &str,
        thread_id: &str,
        before: Option<u32>,
        limit: u32,
    ) -> anyhow::Result<bool> {
        let state = self.load_state(user_id, thread_id).await?;
        let mut scan_end = before
            .unwrap_or_else(|| state.visible_end_exclusive())
            .min(state.visible_end_exclusive());
        let mut parts = Vec::new();
        while scan_end > 0 {
            let scan_start = scan_end.saturating_sub(TRANSCRIPT_CHUNK_SIZE);
            let numbers = (scan_start..scan_end).collect::<Vec<_>>();
            let mut batch = self.read_parts(user_id, thread_id, &numbers).await?;
            if batch.len() != numbers.len() {
                return Ok(false);
            }
            batch.append(&mut parts);
            parts = batch;
            if message_page_start(&parts, limit, scan_start == 0).is_some() {
                return Ok(true);
            }
            scan_end = scan_start;
        }
        Ok(true)
    }

    pub async fn message_details(
        &self,
        user_id: &str,
        thread_id: &str,
        numbers: &[u32],
    ) -> anyhow::Result<Option<TranscriptMessage>> {
        let parts = self.read_parts(user_id, thread_id, numbers).await?;
        if parts.len() != numbers.len() {
            return Ok(None);
        }
        let mut messages = project_messages(user_id, thread_id, parts, true);
        if messages.len() != 1 {
            return Ok(None);
        }
        Ok(messages.pop())
    }

    pub async fn part_details(
        &self,
        user_id: &str,
        thread_id: &str,
        numbers: &[u32],
    ) -> anyhow::Result<Option<Vec<TranscriptPartRecord>>> {
        let parts = self.read_parts(user_id, thread_id, numbers).await?;
        if parts.len() != numbers.len() {
            return Ok(None);
        }
        Ok(Some(
            parts
                .into_iter()
                .map(|part| project_part(user_id, thread_id, part, true))
                .collect(),
        ))
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
        anyhow::ensure!(
            !thread_id.is_empty()
                && !thread_id.eq_ignore_ascii_case("blobs")
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
    use crate::transcript::types::{
        TranscriptAttachmentMeta, TranscriptCompletionBody, TranscriptPartKind,
        TranscriptPromptBody,
    };

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

    fn completion(number: u32) -> TranscriptPart {
        TranscriptPart {
            number,
            source_key: format!("completion:{number}"),
            kind: TranscriptPartKind::Completion,
            run_id: "run-1".to_string(),
            created_at: None,
            prompt: None,
            completion: Some(TranscriptCompletionBody {
                stream_id: Some("stream-1".to_string()),
                items: vec![
                    serde_json::json!({ "type": "reasoning", "id": "r1", "text": "secret" }),
                    serde_json::json!({ "type": "tool-call", "callId": "c1", "name": "exec_command", "input": { "cmd": "pwd" } }),
                    serde_json::json!({ "type": "tool-result", "callId": "c1", "name": "exec_command", "output": "secret output" }),
                    serde_json::json!({ "type": "text", "id": "t1", "text": "answer" }),
                ],
            }),
            tool: None,
        }
    }

    fn completion_for_run(number: u32, run_id: &str, text: &str) -> TranscriptPart {
        TranscriptPart {
            number,
            source_key: format!("completion:{number}"),
            kind: TranscriptPartKind::Completion,
            run_id: run_id.to_string(),
            created_at: None,
            prompt: None,
            completion: Some(TranscriptCompletionBody {
                stream_id: Some(format!("stream-{number}")),
                items: vec![
                    serde_json::json!({ "type": "text", "id": format!("t-{number}"), "text": text }),
                ],
            }),
            tool: None,
        }
    }

    #[tokio::test]
    async fn message_details_omit_ciphertext_and_leave_stored_reasoning_intact() {
        const ENVELOPE: &str = "stored-opaque-envelope";
        let dir = std::env::temp_dir().join(format!(
            "sprocket-reasoning-privacy-{}",
            uuid::Uuid::new_v4()
        ));
        let store = TranscriptStore::new(dir.clone());
        let mut part = completion(0);
        part.completion.as_mut().unwrap().items = vec![
            serde_json::json!({
                "type": "reasoning",
                "id": "r1",
                "text": "",
                "providerMetadata": {
                    "openai": {
                        "itemId": "rs_empty",
                        "reasoningEncryptedContent": ENVELOPE
                    }
                }
            }),
            serde_json::json!({ "type": "text", "id": "t1", "text": "answer" }),
        ];
        store.append_parts("user", "thread", &[part]).await.unwrap();

        let details = store
            .message_details("user", "thread", &[0])
            .await
            .unwrap()
            .unwrap();
        let rendered = serde_json::to_string(&details).unwrap();
        assert_eq!(details.parts.len(), 1);
        assert_eq!(details.parts[0]["type"], "text");
        assert_eq!(details.text, "answer");
        assert!(details.parts[0].get("providerMetadata").is_none());
        assert!(!rendered.contains(ENVELOPE));
        assert!(!rendered.contains("reasoningEncryptedContent"));

        let stored = store.read_parts("user", "thread", &[0]).await.unwrap();
        assert_eq!(
            stored[0].completion.as_ref().unwrap().items[0]["providerMetadata"]["openai"]["reasoningEncryptedContent"],
            ENVELOPE
        );

        let _ = tokio::fs::remove_dir_all(dir).await;
    }

    #[tokio::test]
    async fn pages_by_complete_messages_instead_of_parts() {
        let dir =
            std::env::temp_dir().join(format!("sprocket-page-messages-{}", uuid::Uuid::new_v4()));
        let store = TranscriptStore::new(dir.clone());
        store
            .append_parts(
                "user",
                "thread",
                &[
                    prompt(0, "first"),
                    completion_for_run(1, "run-0", "old answer"),
                    prompt(2, "second"),
                    completion_for_run(3, "run-2", "new "),
                    completion_for_run(4, "run-2", "answer"),
                ],
            )
            .await
            .unwrap();
        store
            .update_state("user", "thread", |state| state.remote_total_parts = 5)
            .await
            .unwrap();

        let newest = store.page("user", "thread", None, Some(1)).await.unwrap();
        assert_eq!(newest.messages.len(), 1);
        assert_eq!(newest.messages[0].text, "new answer");
        assert_eq!(newest.messages[0].source_numbers, vec![3, 4]);
        assert_eq!(newest.next_before, Some(3));

        let older = store
            .page("user", "thread", newest.next_before, Some(1))
            .await
            .unwrap();
        assert_eq!(older.messages.len(), 1);
        assert_eq!(older.messages[0].text, "second");
        assert_eq!(older.next_before, Some(2));

        tokio::fs::remove_dir_all(dir).await.unwrap();
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
            page.messages
                .iter()
                .map(|message| message.text.as_str())
                .collect::<Vec<_>>(),
            vec!["b", "c"]
        );
        assert_eq!(page.next_before, Some(1));
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
            page.messages
                .iter()
                .map(|message| message.text.as_str())
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
        part.prompt
            .as_mut()
            .unwrap()
            .image_uploads
            .push(TranscriptAttachmentMeta {
                image_upload_id: "upload-1".into(),
                name: "a.png".into(),
                media_type: "image/png".into(),
                size: 4,
                storage_id: "storage-1".into(),
                url: None,
            });
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

    #[tokio::test]
    async fn cold_pages_fetch_only_requested_parts_of_a_five_hundred_part_response() {
        let dir =
            std::env::temp_dir().join(format!("sprocket-parts-window-{}", uuid::Uuid::new_v4()));
        let store = TranscriptStore::new(dir.clone());
        store
            .update_state("user", "thread", |state| state.remote_total_parts = 500)
            .await
            .unwrap();

        let mut requests = Vec::new();
        for before in [None, Some(488), None] {
            let limit = if before.is_some() { 40 } else { 12 };
            let (start, end) = parts_window(500, before, Some(limit));
            crate::transcript::fetch_missing_parts(
                &store,
                "user",
                "thread",
                start,
                end,
                |numbers| {
                    requests.push(numbers.clone());
                    async move {
                        Ok(numbers
                            .into_iter()
                            .map(|number| {
                                completion_for_run(number, "span", &format!("part {number}"))
                            })
                            .collect())
                    }
                },
            )
            .await
            .unwrap();
        }
        assert_eq!(
            requests,
            vec![(488..500).collect::<Vec<_>>(), (448..488).collect()]
        );
        assert!(
            store
                .read_parts("user", "thread", &(0..448).collect::<Vec<_>>())
                .await
                .unwrap()
                .is_empty()
        );

        let page = store
            .parts_page("user", "thread", Some(500), Some(12))
            .await
            .unwrap();
        assert_eq!(page.total_parts, 500);
        assert_eq!(page.parts.len(), 12);
        assert_eq!(page.parts[0].number, 488);
        assert_eq!(page.parts[11].number, 499);
        assert_eq!(page.next_before, Some(488));
        assert_eq!(page.parts[0].kind, TranscriptPartKind::Completion);
        let message = page.parts[0].message.as_ref().unwrap();
        assert_eq!(message.source_numbers, vec![488]);
        assert_eq!(message.text, "part 488");
        assert!(!message.details_loaded);

        let older = store
            .parts_page("user", "thread", page.next_before, Some(40))
            .await
            .unwrap();
        assert_eq!(older.parts[0].number, 448);
        assert_eq!(older.parts[39].number, 487);
        assert_eq!(older.next_before, Some(448));

        store
            .update_state("user", "thread", |state| state.remote_total_parts = 501)
            .await
            .unwrap();
        let frozen = store
            .parts_page("user", "thread", Some(500), Some(12))
            .await
            .unwrap();
        assert_eq!(frozen.parts, page.parts);

        tokio::fs::remove_dir_all(dir).await.unwrap();
    }

    #[tokio::test]
    async fn parts_page_errors_on_cache_holes_without_a_cursor() {
        let dir =
            std::env::temp_dir().join(format!("sprocket-parts-hole-{}", uuid::Uuid::new_v4()));
        let store = TranscriptStore::new(dir.clone());
        let parts = (0..20)
            .filter(|number| *number != 10)
            .map(|number| prompt(number, "x"))
            .collect::<Vec<_>>();
        store.append_parts("user", "thread", &parts).await.unwrap();
        store
            .update_state("user", "thread", |state| state.remote_total_parts = 20)
            .await
            .unwrap();

        assert!(
            store
                .parts_page("user", "thread", Some(20), Some(10))
                .await
                .is_err()
        );
        assert!(
            !store
                .has_complete_range("user", "thread", 10, 20)
                .await
                .unwrap()
        );

        let complete = store
            .parts_page("user", "thread", Some(10), Some(10))
            .await
            .unwrap();
        assert_eq!(complete.parts.len(), 10);
        assert_eq!(complete.parts[0].number, 0);
        assert_eq!(complete.next_before, None);

        tokio::fs::remove_dir_all(dir).await.unwrap();
    }

    #[tokio::test]
    async fn part_details_project_each_cached_part_with_hidden_payloads() {
        let dir =
            std::env::temp_dir().join(format!("sprocket-part-details-{}", uuid::Uuid::new_v4()));
        let store = TranscriptStore::new(dir.clone());
        let mut empty_prompt = prompt(1, "hi");
        empty_prompt.prompt = None;
        store
            .append_parts("user", "thread", &[completion(0), empty_prompt])
            .await
            .unwrap();
        store
            .update_state("user", "thread", |state| state.remote_total_parts = 2)
            .await
            .unwrap();

        let page = store
            .parts_page("user", "thread", None, Some(2))
            .await
            .unwrap();
        assert_eq!(page.parts.len(), 2);
        assert_eq!(page.parts[0].kind, TranscriptPartKind::Completion);
        let light = page.parts[0].message.as_ref().unwrap();
        assert!(!light.details_loaded);
        assert_eq!(light.source_numbers, vec![0]);
        assert_eq!(light.parts[0]["text"], "");
        assert!(light.parts[1]["input"].is_null());
        assert_eq!(page.parts[1].kind, TranscriptPartKind::Prompt);
        assert!(page.parts[1].message.is_none());

        let details = store
            .part_details("user", "thread", &[0, 1])
            .await
            .unwrap()
            .unwrap();
        assert_eq!(details.len(), 2);
        let detailed = details[0].message.as_ref().unwrap();
        assert!(detailed.details_loaded);
        assert_eq!(detailed.parts[0]["text"], "secret");
        assert_eq!(detailed.parts[1]["input"]["cmd"], "pwd");
        assert!(details[1].message.is_none());
        assert!(
            store
                .part_details("user", "thread", &[0, 2])
                .await
                .unwrap()
                .is_none()
        );

        tokio::fs::remove_dir_all(dir).await.unwrap();
    }
}
