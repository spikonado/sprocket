use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use fff_search::file_picker::{FFFMode, FilePicker, FilePickerOptions, FuzzySearchOptions};
use fff_search::types::MixedItemRef;
use fff_search::{MixedSearchConfig, PaginationArgs, QueryParser, SharedFilePicker};

pub const SEARCH_RESULT_LIMIT: usize = 30;
pub const MAX_QUERY_CHARS: usize = 128;
const MAX_CACHED_WORKSPACES: usize = 8;
const PICKER_TTL: Duration = Duration::from_secs(30 * 60);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceSearchEntry {
    pub path: String,
    pub is_dir: bool,
}

#[derive(Debug, Default)]
pub struct SearchOutcome {
    pub entries: Vec<WorkspaceSearchEntry>,
    pub scanning: bool,
}

struct PickerHandle(SharedFilePicker);

impl Drop for PickerHandle {
    fn drop(&mut self) {
        self.0.cancel();
        if let Ok(mut guard) = self.0.write() {
            guard.take();
        }
    }
}

struct CachedPicker {
    handle: Arc<PickerHandle>,
    last_used: Instant,
}

// Call through spawn_blocking. fff uses blocking locks and background scan threads.
pub struct WorkspaceSearchIndex {
    pickers: Mutex<HashMap<PathBuf, CachedPicker>>,
    pub search_slots: Arc<tokio::sync::Semaphore>,
}

impl WorkspaceSearchIndex {
    pub fn new() -> Self {
        Self {
            pickers: Mutex::new(HashMap::new()),
            search_slots: Arc::new(tokio::sync::Semaphore::new(4)),
        }
    }

    pub fn search(&self, workspace_root: &Path, query: &str) -> anyhow::Result<SearchOutcome> {
        anyhow::ensure!(
            query.chars().count() <= MAX_QUERY_CHARS,
            "workspace search query is too long"
        );
        let picker = self.picker_for(workspace_root)?;

        let guard = picker.0.read().map_err(|error| anyhow::anyhow!(error))?;
        let Some(searcher) = guard.as_ref() else {
            return Ok(SearchOutcome {
                entries: Vec::new(),
                scanning: true,
            });
        };

        let parser = QueryParser::new(MixedSearchConfig);
        let parsed = parser.parse(query);
        let result = searcher.fuzzy_search_mixed(
            &parsed,
            None,
            FuzzySearchOptions {
                max_threads: 2,
                current_file: None,
                project_path: Some(searcher.base_path()),
                combo_boost_score_multiplier: 0,
                min_combo_count: 0,
                pagination: PaginationArgs {
                    offset: 0,
                    limit: SEARCH_RESULT_LIMIT,
                },
            },
        );
        let scanning = searcher.is_scan_active();

        let entries = result
            .items
            .iter()
            .map(|item| match item {
                MixedItemRef::File(file) => WorkspaceSearchEntry {
                    path: to_forward_slashes(file.relative_path(searcher)),
                    is_dir: false,
                },
                MixedItemRef::Dir(dir) => WorkspaceSearchEntry {
                    path: directory_path(dir.relative_path(searcher)),
                    is_dir: true,
                },
            })
            .collect();

        Ok(SearchOutcome { entries, scanning })
    }

    fn picker_for(&self, workspace_root: &Path) -> anyhow::Result<Arc<PickerHandle>> {
        let key = workspace_root.to_path_buf();
        let mut pickers = self
            .pickers
            .lock()
            .map_err(|_| anyhow::anyhow!("workspace search cache lock poisoned"))?;

        evict_idle(&mut pickers);
        if let Some(cached) = pickers.get_mut(&key) {
            cached.last_used = Instant::now();
            return Ok(Arc::clone(&cached.handle));
        }

        if pickers.len() >= MAX_CACHED_WORKSPACES {
            let oldest = pickers
                .iter()
                .max_by_key(|(_, cached)| cached.last_used.elapsed())
                .map(|(path, _)| path.clone())
                .expect("cache is non-empty at the bound");
            pickers.remove(&oldest);
        }

        let picker = SharedFilePicker::default();
        FilePicker::new_with_shared_state(
            picker.clone(),
            Default::default(),
            FilePickerOptions {
                base_path: workspace_root.to_string_lossy().to_string(),
                mode: FFFMode::Ai,
                ..Default::default()
            },
        )
        .map_err(|error| anyhow::anyhow!(error))?;
        let cached = CachedPicker {
            handle: Arc::new(PickerHandle(picker)),
            last_used: Instant::now(),
        };
        let handle = Arc::clone(&cached.handle);
        pickers.insert(key, cached);
        Ok(handle)
    }
}

fn evict_idle(pickers: &mut HashMap<PathBuf, CachedPicker>) {
    pickers.retain(|_, cached| cached.last_used.elapsed() < PICKER_TTL);
}

fn to_forward_slashes(path: String) -> String {
    if std::path::MAIN_SEPARATOR == '/' {
        return path;
    }
    path.replace(std::path::MAIN_SEPARATOR, "/")
}

fn directory_path(path: String) -> String {
    let path = to_forward_slashes(path);
    let path = path.trim_end_matches('/');
    if path.is_empty() {
        ".".to_string()
    } else {
        path.to_string()
    }
}

#[cfg(test)]
mod tests;
