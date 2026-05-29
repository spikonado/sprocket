use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceOverview {
    pub root_path: String,
    pub name: String,
    pub git_branch: Option<String>,
    pub git_dirty: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceEntry {
    pub name: String,
    pub kind: String,
}

pub fn build_workspace_overview(root: &Path) -> Result<WorkspaceOverview> {
    let canonical_root: PathBuf = root
        .canonicalize()
        .with_context(|| format!("failed to resolve {}", root.display()))?;
    let root_name: String = canonical_root
        .file_name()
        .unwrap_or_else(|| OsStr::new("workspace"))
        .to_string_lossy()
        .to_string();

    let (git_branch, git_dirty): (Option<String>, bool) =
        git_state(&canonical_root).unwrap_or((None, false));

    Ok(WorkspaceOverview {
        root_path: canonical_root.to_string_lossy().to_string(),
        name: root_name,
        git_branch,
        git_dirty,
    })
}

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

fn git_state(root: &Path) -> Result<(Option<String>, bool)> {
    let Ok(repo) = gix::discover(root) else {
        return Ok((None, false));
    };

    let branch: Option<String> = repo
        .head_name()
        .context("failed to read git head")?
        .map(|name| name.shorten().to_string())
        .or_else(|| Some("HEAD".to_string()));
    let dirty: bool = repo
        .status(gix::progress::Discard)
        .context("failed to build git status")?
        .untracked_files(gix::status::UntrackedFiles::Collapsed)
        .into_iter(std::iter::empty())
        .context("failed to iterate git status")?
        .next()
        .transpose()
        .context("failed to read git status item")?
        .is_some();

    Ok((branch, dirty))
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::resolve_workspace_path;

    fn temp_workspace() -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after unix epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("sprocket-workspace-tests-{unique}"));
        fs::create_dir_all(&path).expect("temp dir should be created");
        path.canonicalize().expect("temp dir should resolve")
    }

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
