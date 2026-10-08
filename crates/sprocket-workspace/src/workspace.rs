use std::path::PathBuf;

use anyhow::{Context, Result, bail};
pub fn resolve_workspace_root(path: &str) -> Result<PathBuf> {
    let expanded =
        crate::paths::expand_home(&crate::paths::normalize_windows_drive_root(path.trim()));
    let root: PathBuf = PathBuf::from(&expanded);
    if !root.exists() {
        bail!("workspace does not exist: {path}");
    }

    let canonical: PathBuf = root
        .canonicalize()
        .with_context(|| format!("failed to resolve workspace {}", root.display()))?;

    if !canonical.is_dir() {
        bail!("workspace is not a directory: {}", canonical.display());
    }

    Ok(crate::paths::simplified_path(canonical))
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn windows_workspace_spellings_resolve_to_the_same_display_path() {
        let root = crate::test_support::temp_workspace_labeled("sprocket-resolve-windows");
        let expected = crate::paths::simplified_path(&root);
        let displayed = expected.to_string_lossy();

        for query in [
            root.to_string_lossy().into_owned(),
            displayed.to_string(),
            displayed.replace('\\', "/"),
        ] {
            assert_eq!(resolve_workspace_root(&query).expect("resolve"), expected);
        }

        std::fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn bare_windows_drive_resolves_to_the_root_not_a_drive_current_directory() {
        let workspace = crate::test_support::temp_workspace_labeled("sprocket-resolve-drive");
        let root = workspace.ancestors().last().expect("drive root");
        let expected = crate::paths::simplified_path(root);
        let displayed = expected.to_string_lossy();
        let bare_drive = displayed.trim_end_matches('\\');

        assert_eq!(resolve_workspace_root(bare_drive).expect("resolve"), expected);

        std::fs::remove_dir_all(workspace).expect("cleanup");
    }
}
