use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use fff_search::file_picker::{FFFMode, FilePicker, FilePickerOptions, FuzzySearchOptions};
use fff_search::types::MixedItemRef;
use fff_search::{MixedSearchConfig, PaginationArgs, QueryParser, SharedFilePicker};

pub(crate) const SEARCH_RESULT_LIMIT: usize = 30;
pub(crate) const MAX_QUERY_CHARS: usize = 128;
const MAX_CACHED_WORKSPACES: usize = 8;
const PICKER_TTL: Duration = Duration::from_secs(30 * 60);

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WorkspaceSearchEntry {
    pub path: String,
    pub is_dir: bool,
}

#[derive(Debug, Default)]
pub(crate) struct SearchOutcome {
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
pub(crate) struct WorkspaceSearchIndex {
    pickers: Mutex<HashMap<PathBuf, CachedPicker>>,
    pub(crate) search_slots: Arc<tokio::sync::Semaphore>,
}

impl WorkspaceSearchIndex {
    pub fn new() -> Self {
        Self {
            pickers: Mutex::new(HashMap::new()),
            search_slots: Arc::new(tokio::sync::Semaphore::new(4)),
        }
    }

    pub(crate) fn search(
        &self,
        workspace_root: &Path,
        query: &str,
    ) -> anyhow::Result<SearchOutcome> {
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

    #[cfg(test)]
    fn cached_count(&self) -> usize {
        self.pickers.lock().expect("picker cache").len()
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
mod tests {
    use super::*;
    use std::collections::BTreeSet;
    use std::fs;
    use std::time::Duration;

    fn test_workspace() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("temp workspace");
        let root = dir.path();
        fs::create_dir_all(root.join("src/components")).unwrap();
        fs::create_dir(root.join("empty directory")).unwrap();
        fs::write(root.join("src/main.rs"), "fn main() {}").unwrap();
        fs::write(root.join("src/components/button.tsx"), "export {}").unwrap();
        fs::write(root.join("Cargo.toml"), "[package]").unwrap();
        dir
    }

    fn wait_for_scan(index: &WorkspaceSearchIndex, root: &Path) {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let picker = index.picker_for(root).expect("picker");
            if picker.0.wait_for_scan(Duration::from_millis(50)) {
                return;
            }
            assert!(Instant::now() < deadline, "scan did not finish in time");
        }
    }

    #[test]
    fn returns_files_and_directories_as_workspace_relative_paths() {
        let workspace = test_workspace();
        let root = workspace.path().canonicalize().unwrap();
        let index = WorkspaceSearchIndex::new();
        wait_for_scan(&index, &root);

        let outcome = index.search(&root, "button").expect("search");

        assert!(!outcome.scanning);
        assert!(
            outcome
                .entries
                .iter()
                .any(|entry| { entry.path == "src/components/button.tsx" && !entry.is_dir }),
            "expected the tsx file, got {:?}",
            outcome.entries
        );
    }

    #[test]
    fn matches_directories_with_mixed_search() {
        let workspace = test_workspace();
        let root = workspace.path().canonicalize().unwrap();
        let index = WorkspaceSearchIndex::new();
        wait_for_scan(&index, &root);

        let outcome = index.search(&root, "components").expect("search");

        assert!(
            outcome
                .entries
                .iter()
                .any(|entry| entry.path == "src/components" && entry.is_dir),
            "expected the directory, got {:?}",
            outcome.entries
        );
        let empty = index.search(&root, "empty").unwrap();
        assert!(
            empty
                .entries
                .iter()
                .any(|entry| entry.path == "empty directory" && entry.is_dir)
        );
    }

    #[test]
    fn completion_respects_gitignore_rules_in_a_git_workspace() {
        let workspace = tempfile::tempdir().expect("temp workspace");
        let root = workspace.path();
        gix::init(root).expect("gix init");
        fs::write(root.join(".gitignore"), "ignored-dir/\n*.log\n").unwrap();

        fs::create_dir_all(root.join("ignored-dir")).unwrap();
        fs::create_dir_all(root.join("src/nested/scratch")).unwrap();

        fs::write(root.join("src/main.rs"), "fn main() {}").unwrap();
        fs::write(root.join("src/notes.txt"), "notes").unwrap();
        fs::write(root.join("src/debug.log"), "log").unwrap();
        fs::write(root.join("ignored-dir/hidden.rs"), "fn hidden() {}").unwrap();

        let nested = root.join("src/nested");
        fs::write(
            nested.join(".gitignore"),
            "scratch/\n*.tmp\n!important.tmp\n",
        )
        .unwrap();
        fs::write(nested.join("scratch/temp.rs"), "fn temp() {}").unwrap();
        fs::write(nested.join("keep.rs"), "fn keep() {}").unwrap();
        fs::write(nested.join("data.tmp"), "tmp").unwrap();
        fs::write(nested.join("important.tmp"), "important").unwrap();

        let root = root.canonicalize().unwrap();
        let index = WorkspaceSearchIndex::new();
        wait_for_scan(&index, &root);

        let outcome = index.search(&root, "").expect("search");
        let indexed: BTreeSet<(&str, bool)> = outcome
            .entries
            .iter()
            .map(|entry| (entry.path.as_str(), entry.is_dir))
            .collect();

        assert_eq!(
            indexed,
            BTreeSet::from([
                (".gitignore", false),
                ("src", true),
                ("src/main.rs", false),
                ("src/notes.txt", false),
                ("src/nested", true),
                ("src/nested/.gitignore", false),
                ("src/nested/keep.rs", false),
                ("src/nested/important.tmp", false),
            ])
        );
    }

    #[test]
    fn bare_at_query_offers_workspace_entries() {
        let workspace = test_workspace();
        let root = workspace.path().canonicalize().unwrap();
        let index = WorkspaceSearchIndex::new();

        wait_for_scan(&index, &root);
        let outcome = index.search(&root, "").expect("search");

        assert!(!outcome.entries.is_empty());
        assert!(!outcome.scanning);
    }

    #[test]
    fn results_are_capped() {
        let dir = tempfile::tempdir().expect("temp workspace");
        let root = dir.path();
        for i in 0..(SEARCH_RESULT_LIMIT + 15) {
            fs::write(root.join(format!("match-{i:03}.txt")), "x").unwrap();
        }
        let root = root.canonicalize().unwrap();
        let index = WorkspaceSearchIndex::new();
        wait_for_scan(&index, &root);

        let outcome = index.search(&root, "match").expect("search");

        assert_eq!(outcome.entries.len(), SEARCH_RESULT_LIMIT);
    }

    #[test]
    fn cache_is_reused_and_bounded() {
        let workspace = test_workspace();
        let root = workspace.path().canonicalize().unwrap();
        let index = WorkspaceSearchIndex::new();
        wait_for_scan(&index, &root);

        index.search(&root, "main").expect("first");
        assert_eq!(index.cached_count(), 1);
        let second = index.search(&root, "main").expect("second");
        assert!(
            second
                .entries
                .iter()
                .any(|entry| entry.path == "src/main.rs")
        );
        assert_eq!(index.cached_count(), 1, "same workspace must reuse");

        let mut extra = Vec::new();
        for i in 0..MAX_CACHED_WORKSPACES {
            let dir = tempfile::tempdir().expect("temp workspace");
            let path = dir.path().canonicalize().unwrap();
            index.search(&path, "anything").expect("search");
            extra.push(dir);
            assert!(
                index.cached_count() <= MAX_CACHED_WORKSPACES,
                "cache exceeded the bound at {i}"
            );
        }
    }

    #[test]
    fn cached_index_reflects_created_files() {
        let workspace = test_workspace();
        let root = workspace.path().canonicalize().unwrap();
        let index = WorkspaceSearchIndex::new();
        wait_for_scan(&index, &root);
        let handle = index.picker_for(&root).unwrap();
        assert!(handle.0.wait_for_watcher(Duration::from_secs(10)));
        fs::write(root.join("src/new-file.rs"), "pub fn added() {}").unwrap();

        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let outcome = index.search(&root, "new-file").unwrap();
            if outcome
                .entries
                .iter()
                .any(|entry| entry.path == "src/new-file.rs")
            {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "watcher did not publish created file"
            );
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    #[test]
    fn idle_picker_is_replaced_without_canceling_an_active_handle() {
        let workspace = test_workspace();
        let root = workspace.path().canonicalize().unwrap();
        let index = WorkspaceSearchIndex::new();
        let first = index.picker_for(&root).unwrap();
        index
            .pickers
            .lock()
            .unwrap()
            .get_mut(&root)
            .unwrap()
            .last_used = Instant::now() - PICKER_TTL;
        let replacement = index.picker_for(&root).unwrap();
        assert!(!Arc::ptr_eq(&first, &replacement));
        assert!(first.0.wait_for_scan(Duration::from_secs(10)));
        assert!(first.0.read().unwrap().is_some());
    }
}
