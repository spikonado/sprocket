use std::path::{Component, Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail};
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

pub fn resolve_workspace_path(
    root: &Path,
    path: &str,
    allow_missing_file: bool,
) -> Result<PathBuf> {
    let candidate = if Path::new(path).is_absolute() {
        PathBuf::from(path)
    } else {
        root.join(path)
    };

    let resolved = normalize_path(&candidate)?;

    if !resolved.starts_with(root) {
        bail!("path escapes the workspace root");
    }

    let resolved = if allow_missing_file {
        resolve_missing_workspace_path(root, &resolved)?
    } else {
        if !resolved.exists() {
            bail!("path does not exist: {}", resolved.display());
        }

        resolved
            .canonicalize()
            .with_context(|| format!("failed to resolve {}", resolved.display()))?
    };

    if !resolved.starts_with(root) {
        bail!("path escapes the workspace root");
    }

    Ok(resolved)
}

fn normalize_path(path: &Path) -> Result<PathBuf> {
    let mut normalized = PathBuf::new();

    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::Normal(segment) => normalized.push(segment),
            Component::ParentDir => {
                if !normalized.pop() {
                    bail!("path escapes the workspace root");
                }
            }
        }
    }

    Ok(normalized)
}

fn resolve_missing_workspace_path(root: &Path, resolved: &Path) -> Result<PathBuf> {
    let mut existing_ancestor = resolved;
    let mut suffix = Vec::new();

    while !existing_ancestor.exists() {
        let name = existing_ancestor
            .file_name()
            .ok_or_else(|| anyhow!("invalid path {}", resolved.display()))?;
        suffix.push(name.to_os_string());
        existing_ancestor = existing_ancestor
            .parent()
            .ok_or_else(|| anyhow!("invalid path {}", resolved.display()))?;
    }

    let mut canonical = existing_ancestor
        .canonicalize()
        .with_context(|| format!("failed to resolve {}", existing_ancestor.display()))?;

    if !canonical.starts_with(root) {
        bail!("path escapes the workspace root");
    }

    for component in suffix.into_iter().rev() {
        canonical.push(component);
    }

    Ok(canonical)
}

pub fn relative_to_root(root: &Path, path: &Path) -> String {
    let relative = path
        .strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/");

    if relative.is_empty() {
        ".".to_string()
    } else {
        relative
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::resolve_workspace_path;
    use crate::test_support::temp_workspace;

    #[test]
    fn allows_missing_nested_paths_inside_workspace() {
        let root = temp_workspace();
        let resolved = resolve_workspace_path(&root, "nested/deep/file.txt", true)
            .expect("missing nested path should resolve");

        assert_eq!(resolved, root.join("nested/deep/file.txt"));

        fs::remove_dir_all(root).expect("temp dir should be removed");
    }

    #[test]
    fn rejects_missing_paths_with_clear_error() {
        let root = temp_workspace();
        let error = resolve_workspace_path(&root, "missing.txt", false)
            .expect_err("missing file should fail");

        assert!(
            error.to_string().contains("path does not exist"),
            "unexpected error: {error:#}"
        );

        fs::remove_dir_all(root).expect("temp dir should be removed");
    }
}
