use super::*;
use std::collections::BTreeSet;
use std::fs;
use std::time::Duration;

impl WorkspaceSearchIndex {
    fn cached_count(&self) -> usize {
        self.pickers.lock().expect("picker cache").len()
    }
}

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
            (".", true),
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

    let listing = index.list_paths(&root).expect("list paths");
    assert!(!listing.scanning && !listing.truncated);
    assert_eq!(
        listing
            .paths
            .iter()
            .map(String::as_str)
            .collect::<BTreeSet<_>>(),
        BTreeSet::from([
            ".gitignore",
            "src/",
            "src/main.rs",
            "src/notes.txt",
            "src/nested/",
            "src/nested/.gitignore",
            "src/nested/keep.rs",
            "src/nested/important.tmp",
        ])
    );
    let untracked = GitStatusEntry {
        path: "src/main.rs".to_string(),
        status: GitFileStatus::Untracked,
    };
    // fff publishes git status from a background worker after the scan finishes.
    let deadline = Instant::now() + Duration::from_secs(30);
    while !index
        .list_paths(&root)
        .unwrap()
        .git_status
        .contains(&untracked)
    {
        assert!(Instant::now() < deadline, "git status did not load in time");
        std::thread::sleep(Duration::from_millis(50));
    }
    assert_eq!(
        index.list_paths(&root).unwrap().content_hash(),
        index.list_paths(&root).unwrap().content_hash()
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
