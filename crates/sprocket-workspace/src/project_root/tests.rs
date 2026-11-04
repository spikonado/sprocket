use super::*;
use std::fs;
use std::path::{Path, PathBuf};

fn relative_to_cwd(path: &Path) -> Option<PathBuf> {
    let cwd = std::env::current_dir().ok()?.canonicalize().ok()?;
    let path = path.canonicalize().ok()?;
    let mut relative = PathBuf::new();
    let mut dir = cwd.as_path();
    loop {
        if let Ok(suffix) = path.strip_prefix(dir) {
            relative.push(suffix);
            return Some(relative);
        }
        relative.push("..");
        dir = dir.parent()?;
    }
}

#[test]
fn discovered_repository_paths_stay_absolute() {
    let root = crate::test_support::temp_workspace_labeled("sprocket-git-repo-absolute-paths");
    gix::init(&root).expect("gix init");
    let cwd = relative_to_cwd(&root).expect("relative path from cwd");
    assert!(!cwd.is_absolute());

    let repo = discover_repository(&cwd).expect("discover");
    assert!(repo.git_dir().is_absolute());
    assert!(repo.common_dir().is_absolute());
    assert!(repo.workdir().is_some_and(Path::is_absolute));

    let _ = fs::remove_dir_all(root);
}
