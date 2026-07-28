use std::path::PathBuf;

use anyhow::{Context, Result, bail};
pub fn resolve_workspace_root(path: &str) -> Result<PathBuf> {
    let expanded = crate::paths::expand_home(path.trim());
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

    Ok(canonical)
}
