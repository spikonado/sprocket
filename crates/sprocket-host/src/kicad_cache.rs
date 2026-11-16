use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

const CAPACITY: usize = 4;

#[derive(Default)]
pub(crate) struct KiCadCache(Mutex<VecDeque<Entry>>);

struct Entry {
    path: PathBuf,
    key: String,
    bytes: Arc<[u8]>,
}

impl KiCadCache {
    pub fn get(&self, path: &Path, key: &str) -> Option<Arc<[u8]>> {
        let mut recent = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        let index = recent
            .iter()
            .position(|entry| entry.path == path && entry.key == key)?;
        let entry = recent.remove(index)?;
        let bytes = Arc::clone(&entry.bytes);
        recent.push_front(entry);
        Some(bytes)
    }

    pub fn insert(&self, path: PathBuf, key: String, bytes: Arc<[u8]>) {
        let mut recent = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        recent.retain(|entry| entry.path != path);
        recent.push_front(Entry { path, key, bytes });
        recent.truncate(CAPACITY);
    }
}
