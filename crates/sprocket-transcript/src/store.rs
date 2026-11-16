use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak};

use anyhow::Context;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use tokio::sync::{Mutex, broadcast};

use super::attachment_store::write_attachment_metadata;
use super::monitor::{PatchIdentities, PatchIndex};
use super::types::{TRANSCRIPT_CHUNK_SIZE, TranscriptPart};

const FORMAT_FILE: &str = "format";
const STORE_FORMAT: &str = "sorted-jsonl-100-v1\n";

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

fn chunk_start(number: u32) -> u32 {
    number / TRANSCRIPT_CHUNK_SIZE * TRANSCRIPT_CHUNK_SIZE
}

#[derive(Default)]
struct ThreadIndex {
    numbers: BTreeSet<u32>,
    sources: HashMap<String, u32>,
    // Only `poll_subagent` pairs patches, so opening a thread reads just numbers and source keys.
    patches: Option<PatchIdentities>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PartKey {
    number: u32,
    source_key: String,
}

impl ThreadIndex {
    fn contains(&self, part: &TranscriptPart) -> bool {
        self.numbers.contains(&part.number) || self.sources.contains_key(&part.source_key)
    }

    fn insert(&mut self, part: &TranscriptPart) {
        self.insert_key(part.number, part.source_key.clone());
        if let Some(patches) = &mut self.patches {
            patches.insert(part);
        }
    }

    fn insert_key(&mut self, number: u32, source_key: String) {
        self.numbers.insert(number);
        self.sources.insert(source_key, number);
    }

    fn missing_page(&self, start: u32, end: u32) -> Option<(u32, u32)> {
        if start >= end {
            return None;
        }
        let mut top = end;
        for number in self.numbers.range(start..end).rev() {
            if number + 1 != top {
                break;
            }
            top = *number;
        }
        if top <= start {
            return None;
        }
        let floor = chunk_start(top - 1).max(start);
        let bottom = self
            .numbers
            .range(floor..top)
            .next_back()
            .map_or(floor, |number| number + 1);
        Some((bottom, top))
    }
}

type ThreadSlot = Mutex<Option<ThreadIndex>>;

/// Keeps a thread's index in memory while held. Without a lease, each call rebuilds it.
pub struct TranscriptLease {
    _slot: Arc<ThreadSlot>,
}

pub struct TranscriptStore {
    pub(super) root: PathBuf,
    locks: Mutex<HashMap<String, Weak<Mutex<()>>>>,
    threads: Mutex<HashMap<PathBuf, Weak<ThreadSlot>>>,
    changes: broadcast::Sender<(String, String)>,
}

impl TranscriptStore {
    pub fn new(root: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            root,
            locks: Mutex::new(HashMap::new()),
            threads: Mutex::new(HashMap::new()),
            changes: broadcast::channel(64).0,
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

    pub(super) async fn lock_key(&self, key: String) -> Arc<Mutex<()>> {
        let mut locks = self.locks.lock().await;
        locks.retain(|_, lock| lock.strong_count() != 0);
        if let Some(lock) = locks.get(&key).and_then(Weak::upgrade) {
            return lock;
        }
        let lock = Arc::new(Mutex::new(()));
        locks.insert(key, Arc::downgrade(&lock));
        lock
    }

    async fn thread_slot(&self, dir: &Path) -> Arc<ThreadSlot> {
        let mut threads = self.threads.lock().await;
        threads.retain(|_, slot| slot.strong_count() != 0);
        if let Some(slot) = threads.get(dir).and_then(Weak::upgrade) {
            return slot;
        }
        let slot = Arc::new(ThreadSlot::default());
        threads.insert(dir.to_owned(), Arc::downgrade(&slot));
        slot
    }

    async fn with_thread<T: Send + 'static>(
        &self,
        user_id: &str,
        thread_id: &str,
        operation: impl FnOnce(&Path, &mut ThreadIndex) -> anyhow::Result<T> + Send + 'static,
    ) -> anyhow::Result<T> {
        let dir = self.thread_dir(user_id, thread_id);
        let mut index = self.thread_slot(&dir).await.lock_owned().await;
        // The blocking task finishes even if the caller is dropped, so files and index agree.
        tokio::task::spawn_blocking(move || {
            if index.is_none() {
                *index = Some(load_index(&dir)?);
            }
            let result = operation(&dir, index.as_mut().expect("index was loaded"));
            if result.is_err() {
                // Reload committed chunks after a partially failed write.
                *index = None;
            }
            result
        })
        .await?
    }

    pub async fn open_thread(
        &self,
        user_id: &str,
        thread_id: &str,
    ) -> anyhow::Result<TranscriptLease> {
        let slot = self.thread_slot(&self.thread_dir(user_id, thread_id)).await;
        self.with_thread(user_id, thread_id, |_, _| Ok(())).await?;
        Ok(TranscriptLease { _slot: slot })
    }

    pub fn watch_changes(&self) -> broadcast::Receiver<(String, String)> {
        self.changes.subscribe()
    }

    pub async fn part_numbers(&self, user_id: &str, thread_id: &str) -> anyhow::Result<Vec<u32>> {
        self.with_thread(user_id, thread_id, |_, index| {
            Ok(index.numbers.iter().copied().collect())
        })
        .await
    }

    pub async fn source_number(
        &self,
        user: &str,
        thread: &str,
        source: &str,
    ) -> anyhow::Result<Option<u32>> {
        let source = source.to_owned();
        self.with_thread(user, thread, move |_, index| {
            Ok(index.sources.get(&source).copied())
        })
        .await
    }

    pub(super) async fn patch_index(
        &self,
        user: &str,
        thread: &str,
        total: u32,
    ) -> anyhow::Result<PatchIndex> {
        self.with_thread(user, thread, move |dir, index| {
            if let Some(patches) = &index.patches {
                return Ok(patches.index(total));
            }
            let mut patches = PatchIdentities::default();
            let chunks: BTreeSet<u32> = index.numbers.iter().map(|n| chunk_start(*n)).collect();
            for start in chunks {
                for part in read_chunk(&chunk_path(dir, start), start)? {
                    patches.insert(&part);
                }
            }
            Ok(index.patches.insert(patches).index(total))
        })
        .await
    }

    pub async fn append_parts(
        &self,
        user_id: &str,
        thread_id: &str,
        parts: &[TranscriptPart],
    ) -> anyhow::Result<()> {
        if parts.is_empty() {
            return Ok(());
        }
        let parts: Vec<_> = parts
            .iter()
            .map(TranscriptPart::without_ephemeral_urls)
            .collect();
        let changes = self.changes.clone();
        let scope = (user_id.to_owned(), thread_id.to_owned());
        self.with_thread(user_id, thread_id, move |dir, index| {
            let mut chunks = BTreeMap::<u32, Vec<TranscriptPart>>::new();
            for part in parts {
                if index.contains(&part) {
                    continue;
                }
                index.insert(&part);
                chunks
                    .entry(chunk_start(part.number))
                    .or_default()
                    .push(part);
            }
            let changed = !chunks.is_empty();
            for (start, additions) in chunks {
                for attachment in additions
                    .iter()
                    .filter_map(|part| part.prompt.as_ref())
                    .flat_map(|prompt| &prompt.image_uploads)
                {
                    write_attachment_metadata(dir, attachment)?;
                }
                let path = chunk_path(dir, start);
                let mut chunk = read_chunk(&path, start)?;
                chunk.extend(additions);
                chunk.sort_unstable_by_key(|part| part.number);
                let mut payload = Vec::new();
                for part in &chunk {
                    serde_json::to_writer(&mut payload, part)?;
                    payload.push(b'\n');
                }
                atomic_write(&path, &payload)?;
            }
            if changed {
                let _ = changes.send(scope);
            }
            Ok(())
        })
        .await
    }

    pub async fn read_parts(
        &self,
        user_id: &str,
        thread_id: &str,
        numbers: &[u32],
    ) -> anyhow::Result<Vec<TranscriptPart>> {
        let numbers = numbers.to_vec();
        self.with_thread(user_id, thread_id, move |dir, index| {
            let wanted: BTreeSet<u32> = numbers
                .iter()
                .copied()
                .filter(|number| index.numbers.contains(number))
                .collect();
            let chunks: BTreeSet<u32> = wanted.iter().map(|number| chunk_start(*number)).collect();
            let mut parts = HashMap::new();
            for start in chunks {
                for part in read_chunk(&chunk_path(dir, start), start)? {
                    if wanted.contains(&part.number) {
                        parts.insert(part.number, part);
                    }
                }
            }
            Ok(numbers
                .iter()
                .filter_map(|number| parts.get(number).cloned())
                .collect())
        })
        .await
    }

    pub async fn read_parts_range(
        &self,
        user_id: &str,
        thread_id: &str,
        start: u32,
        end: u32,
    ) -> anyhow::Result<Vec<TranscriptPart>> {
        self.with_thread(user_id, thread_id, move |dir, index| {
            let mut parts = Vec::new();
            if start >= end {
                return Ok(parts);
            }
            let chunks: BTreeSet<u32> = index
                .numbers
                .range(start..end)
                .map(|number| chunk_start(*number))
                .collect();
            for chunk in chunks {
                parts.extend(
                    read_chunk(&chunk_path(dir, chunk), chunk)?
                        .into_iter()
                        .filter(|part| (start..end).contains(&part.number)),
                );
            }
            Ok(parts)
        })
        .await
    }

    pub(super) async fn missing_page(
        &self,
        user_id: &str,
        thread_id: &str,
        start: u32,
        end: u32,
    ) -> anyhow::Result<Option<(u32, u32)>> {
        self.with_thread(user_id, thread_id, move |_, index| {
            Ok(index.missing_page(start, end))
        })
        .await
    }
}

fn chunk_path(dir: &Path, start: u32) -> PathBuf {
    dir.join("parts").join(format!("{start:08}.jsonl"))
}

fn load_index(dir: &Path) -> anyhow::Result<ThreadIndex> {
    let parts_dir = dir.join("parts");
    let marker = match fs::read(dir.join(FORMAT_FILE)) {
        Ok(marker) => Some(marker),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.into()),
    };
    if marker.as_deref() != Some(STORE_FORMAT.as_bytes()) {
        // Caches from older releases are downloaded again; attachments and command logs stay.
        for name in ["state.json", "display", "parts"] {
            remove_path(&dir.join(name))?;
        }
        fs::create_dir_all(&parts_dir)?;
        atomic_write(&dir.join(FORMAT_FILE), STORE_FORMAT.as_bytes())?;
    } else {
        fs::create_dir_all(&parts_dir)?;
    }
    let mut index = ThreadIndex::default();
    for entry in fs::read_dir(&parts_dir)? {
        let path = entry?.path();
        let start = path
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| name.strip_suffix(".jsonl"))
            .and_then(|start| start.parse::<u32>().ok())
            .filter(|start| chunk_path(dir, *start) == path);
        match start.map(|start| read_chunk_as(&path, start, |key: &PartKey| key.number)) {
            Some(Ok(keys)) => keys
                .into_iter()
                .for_each(|key| index.insert_key(key.number, key.source_key)),
            Some(Err(error)) if error.downcast_ref::<std::io::Error>().is_some() => {
                return Err(error);
            }
            // Damaged chunks are downloaded again.
            Some(Err(error)) => {
                eprintln!(
                    "sprocket-transcript: discarding {}: {error:#}",
                    path.display()
                );
                remove_path(&path)?;
            }
            // Temporary files left by an interrupted write.
            None => remove_path(&path)?,
        }
    }
    Ok(index)
}

fn remove_path(path: &Path) -> anyhow::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() => fs::remove_dir_all(path)?,
        Ok(_) => fs::remove_file(path)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

fn read_chunk(path: &Path, start: u32) -> anyhow::Result<Vec<TranscriptPart>> {
    read_chunk_as(path, start, |part: &TranscriptPart| part.number)
}

fn read_chunk_as<T: DeserializeOwned>(
    path: &Path,
    start: u32,
    number: impl Fn(&T) -> u32,
) -> anyhow::Result<Vec<T>> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(error).with_context(|| format!("failed to read {}", path.display()));
        }
    };
    let mut parts: Vec<T> = Vec::new();
    // Bytes, not `lines()`: invalid UTF-8 is chunk damage, not an I/O failure.
    for line in BufReader::new(file).split(b'\n') {
        let part: T = serde_json::from_slice(&line?)
            .with_context(|| format!("failed to parse {}", path.display()))?;
        anyhow::ensure!(
            chunk_start(number(&part)) == start
                && parts
                    .last()
                    .is_none_or(|previous| number(previous) < number(&part)),
            "{} is not sorted into its chunk",
            path.display()
        );
        parts.push(part);
    }
    Ok(parts)
}

// Not synced to disk: after a crash, a damaged chunk is discarded and downloaded again.
pub(super) fn atomic_write(path: &Path, payload: &[u8]) -> anyhow::Result<()> {
    let dir = path
        .parent()
        .context("transcript file has no parent directory")?;
    let mut temporary = tempfile::Builder::new().prefix(".tmp-").tempfile_in(dir)?;
    temporary.write_all(payload)?;
    temporary
        .persist(path)
        .with_context(|| format!("failed to save {}", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests;
