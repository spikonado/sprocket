use std::path::{Path, PathBuf};

const PROJECT_ROOT_MARKERS: [&str; 1] = [".git"];

/// Walk ancestors from `cwd` for a `.git` marker; stop at the process temp root.
pub(crate) fn find_project_root(cwd: &Path) -> PathBuf {
    let temp_root = std::env::temp_dir().canonicalize().ok();

    for ancestor in cwd.ancestors() {
        if temp_root
            .as_deref()
            .is_some_and(|temp_root| ancestor == temp_root)
        {
            break;
        }

        if PROJECT_ROOT_MARKERS
            .iter()
            .any(|marker| ancestor.join(marker).exists())
        {
            return ancestor.to_path_buf();
        }
    }

    cwd.to_path_buf()
}
