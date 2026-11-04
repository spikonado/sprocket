use std::path::{Path, PathBuf};

pub(crate) fn find_project_root(cwd: &Path) -> PathBuf {
    match discover_repository(cwd) {
        Some(repo) => repo
            .workdir()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| cwd.to_path_buf()),
        None => cwd.to_path_buf(),
    }
}

pub(crate) fn discover_repository(cwd: &Path) -> Option<gix::Repository> {
    let mut options = gix::discover::upwards::Options::default();
    options.match_ceiling_dir_or_error = false;
    // Shared temp roots like `/tmp` can hold unrelated git metadata, so
    // workspaces under them must not inherit its project scope.
    if let Ok(temp_root) = std::env::temp_dir().canonicalize() {
        options.ceiling_dirs.push(temp_root);
    }

    gix::discover_opts(cwd, options, gix::open::Options::default()).ok()
}
