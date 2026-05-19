use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail};
use serde::Serialize;
use walkdir::WalkDir;

const WORKSPACE_SCAN_LIMIT: usize = 20_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceOverview {
    pub root_path: String,
    pub name: String,
    pub git_branch: Option<String>,
    pub git_dirty: bool,
    pub file_count: usize,
    pub directory_count: usize,
    pub top_level_entries: Vec<WorkspaceEntry>,
    pub recent_files: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceEntry {
    pub name: String,
    pub kind: String,
}

pub fn build_workspace_overview(root: &Path) -> Result<WorkspaceOverview> {
    let canonical_root = root
        .canonicalize()
        .with_context(|| format!("failed to resolve {}", root.display()))?;
    let root_name = canonical_root
        .file_name()
        .unwrap_or_else(|| OsStr::new("workspace"))
        .to_string_lossy()
        .to_string();

    let top_level_entries = collect_top_level_entries(&canonical_root)?;
    let (file_count, directory_count, recent_files) = scan_workspace(&canonical_root);
    let (git_branch, git_dirty) = git_state(&canonical_root).unwrap_or((None, false));

    Ok(WorkspaceOverview {
        root_path: canonical_root.to_string_lossy().to_string(),
        name: root_name,
        git_branch,
        git_dirty,
        file_count,
        directory_count,
        top_level_entries,
        recent_files,
    })
}

pub fn resolve_workspace_root(path: &str) -> Result<PathBuf> {
    let root: PathBuf = PathBuf::from(path);
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
    relative_path: &str,
    allow_missing_file: bool,
) -> Result<PathBuf> {
    let candidate = if Path::new(relative_path).is_absolute() {
        PathBuf::from(relative_path)
    } else {
        root.join(relative_path)
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

pub fn resolve_read_path(root: &Path, requested_path: &str) -> Result<PathBuf> {
    let candidate = if Path::new(requested_path).is_absolute() {
        PathBuf::from(requested_path)
    } else {
        root.join(requested_path)
    };

    let normalized = normalize_path(&candidate)?;
    if normalized.exists() {
        normalized
            .canonicalize()
            .with_context(|| format!("failed to resolve {}", normalized.display()))
    } else {
        Ok(normalized)
    }
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

fn collect_top_level_entries(root: &Path) -> Result<Vec<WorkspaceEntry>> {
    let entries = std::fs::read_dir(root)?
        .filter_map(Result::ok)
        .take(12)
        .map(|entry| {
            let file_type = entry.file_type().ok();
            let kind = if file_type
                .as_ref()
                .is_some_and(|file_type| file_type.is_dir())
            {
                "directory"
            } else {
                "file"
            };

            WorkspaceEntry {
                name: entry.file_name().to_string_lossy().to_string(),
                kind: kind.to_string(),
            }
        })
        .collect();

    Ok(entries)
}

fn scan_workspace(root: &Path) -> (usize, usize, Vec<String>) {
    let mut file_count = 0;
    let mut directory_count = 0;
    let mut recent_entries = Vec::new();

    for entry in WalkDir::new(root)
        .into_iter()
        .filter_map(Result::ok)
        .take(WORKSPACE_SCAN_LIMIT)
    {
        if entry.file_type().is_dir() {
            directory_count += 1;
            continue;
        }

        if !entry.file_type().is_file() {
            continue;
        }

        file_count += 1;

        let modified = entry
            .metadata()
            .ok()
            .and_then(|metadata| metadata.modified().ok());

        if let Some(modified) = modified {
            recent_entries.push((modified, relative_to_root(root, entry.path())));
        }
    }

    recent_entries.sort_by(|left, right| right.0.cmp(&left.0));
    let recent_files = recent_entries
        .into_iter()
        .take(6)
        .map(|(_, path)| path)
        .collect();

    (file_count, directory_count, recent_files)
}

fn git_state(root: &Path) -> Result<(Option<String>, bool)> {
    let Ok(repo) = gix::discover(root) else {
        return Ok((None, false));
    };

    let branch = repo
        .head_name()
        .context("failed to read git head")?
        .map(|name| name.shorten().to_string())
        .or_else(|| Some("HEAD".to_string()));
    let dirty = repo
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

    use super::{resolve_read_path, resolve_workspace_path};

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

    #[test]
    fn resolves_read_paths_outside_workspace() {
        let root = temp_workspace();
        let external_root = temp_workspace();
        let external_file = external_root.join("external.txt");
        fs::write(&external_file, "outside\n").expect("fixture should be written");

        let resolved = resolve_read_path(&root, &external_file.to_string_lossy())
            .expect("read path outside root should resolve");

        assert_eq!(resolved, external_file);

        fs::remove_dir_all(root).expect("temp dir should be removed");
        fs::remove_dir_all(external_root).expect("temp dir should be removed");
    }
}
