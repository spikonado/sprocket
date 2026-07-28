use std::path::{Path, PathBuf};

/// Discover the git worktree that owns `cwd`, stopping at the process temp root.
///
/// Shared temp roots like `/tmp` are process-global and can contain unrelated
/// git metadata. Treat them as a hard ceiling so ephemeral workspaces do not
/// accidentally inherit project scope from ambient temp directories.
///
/// When no repository is found (or it has no worktree), returns `cwd`.
pub(crate) fn find_project_root(cwd: &Path) -> PathBuf {
    match discover_repository(cwd) {
        Some(repo) => repo
            .workdir()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| cwd.to_path_buf()),
        None => cwd.to_path_buf(),
    }
}

/// Discover the git repository that owns `cwd`, using the process temp root as a ceiling.
pub(crate) fn discover_repository(cwd: &Path) -> Option<gix::Repository> {
    let mut options = gix::discover::upwards::Options::default();
    options.match_ceiling_dir_or_error = false;
    if let Ok(temp_root) = std::env::temp_dir().canonicalize() {
        options.ceiling_dirs.push(temp_root);
    }

    gix::discover_opts(cwd, options, gix::open::Options::default()).ok()
}
