use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::Context;
use tokio::io::AsyncWriteExt;
use tokio::sync::{Mutex, broadcast};

use super::types::{TRANSCRIPT_CHUNK_SIZE, TranscriptPart, TranscriptState};

pub(super) fn safe_segment(value: &str) -> String {
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
    pub(super) root: PathBuf,
    locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    pub(super) replica_resets: broadcast::Sender<(String, String)>,
}

impl TranscriptStore {
    pub fn new(root: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            root,
            locks: Mutex::new(HashMap::new()),
            replica_resets: broadcast::channel(16).0,
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
            .join("display")
            .join(display_cache_segment(key)?))
    }

    pub fn thread_dir(&self, user_id: &str, thread_id: &str) -> PathBuf {
        self.root
            .join(safe_segment(user_id))
            .join(safe_segment(thread_id))
    }

    pub(crate) async fn lock_thread(&self, user_id: &str, thread_id: &str) -> Arc<Mutex<()>> {
        self.lock_key(format!("{user_id}/{thread_id}")).await
    }

    pub(super) async fn lock_key(&self, key: String) -> Arc<Mutex<()>> {
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
        let download_lock = self
            .lock_key(format!("download/{user_id}/{thread_id}"))
            .await;
        let _download_guard = download_lock.lock().await;
        let lock = self.lock_thread(user_id, thread_id).await;
        let _guard = lock.lock().await;
        let dir = self.thread_dir(user_id, thread_id);
        if tokio::fs::try_exists(&dir).await? {
            let mut entries = tokio::fs::read_dir(&dir).await?;
            while let Some(entry) = entries.next_entry().await? {
                if entry.file_name() == "command-logs" {
                    continue;
                }
                if entry.file_type().await?.is_dir() {
                    tokio::fs::remove_dir_all(entry.path()).await?;
                } else {
                    tokio::fs::remove_file(entry.path()).await?;
                }
            }
            match tokio::fs::remove_dir(&dir).await {
                Ok(()) => {}
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::NotFound | std::io::ErrorKind::DirectoryNotEmpty
                    ) => {}
                Err(error) => return Err(error.into()),
            }
        }
        Ok(())
    }
}

fn chunk_path(dir: &Path, number: u32) -> PathBuf {
    dir.join(format!("{:08}.jsonl", chunk_start(number)))
}

pub(super) async fn recover_and_read_chunk(path: &Path) -> anyhow::Result<Vec<TranscriptPart>> {
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
mod tests;
