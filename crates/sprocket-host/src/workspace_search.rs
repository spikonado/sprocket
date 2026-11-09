use std::collections::HashMap;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use fff_search::file_picker::{FFFMode, FilePicker, FilePickerOptions, FuzzySearchOptions};
use fff_search::types::MixedItemRef;
use fff_search::{MixedSearchConfig, PaginationArgs, QueryParser, SharedFilePicker};
use git2::Status;
use serde::Serialize;
use sprocket_workspace::WorkspaceEntryKind;

pub const SEARCH_RESULT_LIMIT: usize = 30;
pub const MAX_QUERY_CHARS: usize = 128;
pub const MAX_LISTED_PATHS: usize = 50_000;
const MAX_CACHED_WORKSPACES: usize = 8;
const PICKER_TTL: Duration = Duration::from_secs(30 * 60);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WorkspaceSearchEntry {
    pub path: String,
    pub kind: WorkspaceEntryKind,
}

#[derive(Debug, Default, Serialize)]
pub struct SearchOutcome {
    pub entries: Vec<WorkspaceSearchEntry>,
    pub scanning: bool,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathListing {
    pub directories: Vec<String>,
    pub files: Vec<String>,
    pub git_status: Vec<GitStatusEntry>,
    pub scanning: bool,
    pub truncated: bool,
}

impl PathListing {
    /// Stable within a server version, which is all clients compare against.
    pub fn content_hash(&self) -> String {
        let mut hasher = DefaultHasher::new();
        self.directories.hash(&mut hasher);
        self.files.hash(&mut hasher);
        self.git_status.hash(&mut hasher);
        self.truncated.hash(&mut hasher);
        format!("{:016x}", hasher.finish())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
pub struct GitStatusEntry {
    pub path: String,
    pub status: GitFileStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GitFileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Untracked,
    Ignored,
}

impl GitFileStatus {
    fn from_git(status: Status) -> Option<Self> {
        if status.contains(Status::INDEX_NEW) {
            Some(Self::Added)
        } else if status.contains(Status::WT_NEW) {
            Some(Self::Untracked)
        } else if status.intersects(Status::INDEX_DELETED | Status::WT_DELETED) {
            Some(Self::Deleted)
        } else if status.intersects(Status::INDEX_RENAMED | Status::WT_RENAMED) {
            Some(Self::Renamed)
        } else if status.intersects(
            Status::INDEX_MODIFIED
                | Status::WT_MODIFIED
                | Status::INDEX_TYPECHANGE
                | Status::WT_TYPECHANGE
                | Status::CONFLICTED,
        ) {
            Some(Self::Modified)
        } else if status.contains(Status::IGNORED) {
            Some(Self::Ignored)
        } else {
            None
        }
    }
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

pub struct WorkspaceSearchIndex {
    pickers: Mutex<HashMap<PathBuf, CachedPicker>>,
    blocking_slots: Arc<tokio::sync::Semaphore>,
}

impl WorkspaceSearchIndex {
    pub fn new() -> Self {
        Self {
            pickers: Mutex::new(HashMap::new()),
            blocking_slots: Arc::new(tokio::sync::Semaphore::new(4)),
        }
    }

    pub async fn search(
        self: &Arc<Self>,
        workspace_root: PathBuf,
        query: String,
    ) -> anyhow::Result<SearchOutcome> {
        self.run_blocking(move |index| index.search_blocking(&workspace_root, &query))
            .await
    }

    pub async fn list_paths(
        self: &Arc<Self>,
        workspace_root: PathBuf,
    ) -> anyhow::Result<PathListing> {
        self.run_blocking(move |index| index.list_paths_blocking(&workspace_root))
            .await
    }

    async fn run_blocking<T: Send + 'static>(
        self: &Arc<Self>,
        work: impl FnOnce(&Self) -> anyhow::Result<T> + Send + 'static,
    ) -> anyhow::Result<T> {
        let permit = Arc::clone(&self.blocking_slots).acquire_owned().await?;
        let index = Arc::clone(self);
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            work(&index)
        })
        .await?
    }

    fn search_blocking(&self, workspace_root: &Path, query: &str) -> anyhow::Result<SearchOutcome> {
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
                    kind: WorkspaceEntryKind::File,
                },
                MixedItemRef::Dir(dir) => WorkspaceSearchEntry {
                    path: directory_path(dir.relative_path(searcher)),
                    kind: WorkspaceEntryKind::Directory,
                },
            })
            .collect();

        Ok(SearchOutcome { entries, scanning })
    }

    fn list_paths_blocking(&self, workspace_root: &Path) -> anyhow::Result<PathListing> {
        let picker = self.picker_for(workspace_root)?;

        let guard = picker.0.read().map_err(|error| anyhow::anyhow!(error))?;
        let Some(searcher) = guard.as_ref() else {
            return Ok(PathListing {
                scanning: true,
                ..Default::default()
            });
        };

        let mut dirs = searcher
            .get_dirs()
            .iter()
            .filter(|dir| !dir.is_deleted())
            .map(|dir| directory_path(dir.relative_path(searcher)))
            .filter(|path| path != ".")
            .peekable();
        let mut files = searcher
            .get_files()
            .iter()
            .filter(|file| !file.is_deleted())
            .map(|file| {
                (
                    to_forward_slashes(file.relative_path(searcher)),
                    file.git_status.and_then(GitFileStatus::from_git),
                )
            })
            .peekable();
        let directories: Vec<_> = dirs.by_ref().take(MAX_LISTED_PATHS).collect();
        let listed_files: Vec<_> = files
            .by_ref()
            .take(MAX_LISTED_PATHS - directories.len())
            .collect();
        let truncated = dirs.peek().is_some() || files.peek().is_some();
        let git_status = listed_files
            .iter()
            .filter_map(|(path, status)| {
                status.map(|status| GitStatusEntry {
                    path: path.clone(),
                    status,
                })
            })
            .collect();

        Ok(PathListing {
            directories,
            files: listed_files.into_iter().map(|(path, _)| path).collect(),
            git_status,
            scanning: searcher.is_scan_active(),
            truncated,
        })
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

impl Default for WorkspaceSearchIndex {
    fn default() -> Self {
        Self::new()
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
