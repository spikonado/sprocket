use std::path::{Component, Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesystemBrowseEntry {
    pub name: String,
    pub full_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesystemBrowseResult {
    pub parent_path: String,
    pub entries: Vec<FilesystemBrowseEntry>,
    #[serde(default)]
    pub volume_list: bool,
}

pub fn browse_filesystem(partial_path: &str, cwd: Option<&str>) -> Result<FilesystemBrowseResult> {
    #[cfg(windows)]
    if is_windows_volume_list_query(partial_path.trim()) {
        return list_windows_volumes();
    }

    let directory = resolve_browse_directory(partial_path, cwd)?;
    let parent_path = display_path(&directory);
    let mut entries = list_directory_entries(&directory)?;

    if let Some(parent_entry) = parent_browse_entry(&directory) {
        entries.insert(0, parent_entry);
    }

    Ok(FilesystemBrowseResult {
        parent_path,
        entries,
        volume_list: false,
    })
}

pub fn resolve_or_create_workspace_root(path: &str) -> Result<PathBuf> {
    let expanded =
        crate::paths::expand_home(&crate::paths::normalize_windows_drive_root(path.trim()));
    let candidate = PathBuf::from(&expanded);

    if candidate.exists() {
        return super::resolve_workspace_root(path);
    }

    std::fs::create_dir_all(&candidate)
        .with_context(|| format!("failed to create workspace {}", candidate.display()))?;
    super::resolve_workspace_root(path)
}

fn resolve_browse_directory(partial_path: &str, cwd: Option<&str>) -> Result<PathBuf> {
    let trimmed = crate::paths::normalize_windows_drive_root(partial_path.trim());
    if trimmed.is_empty() {
        return default_browse_directory();
    }

    let expanded = crate::paths::expand_home(&trimmed);
    let mut candidate = PathBuf::from(expanded);

    if is_relative_path(&trimmed) {
        let Some(cwd_path) = cwd.map(PathBuf::from) else {
            bail!("relative paths require a current directory");
        };
        candidate = cwd_path.join(candidate);
    }

    candidate = normalize_path(&candidate)?;

    if candidate.exists() {
        let canonical = candidate
            .canonicalize()
            .with_context(|| format!("failed to resolve {}", candidate.display()))?;
        if canonical.is_dir() {
            return Ok(canonical);
        }

        return canonical
            .parent()
            .map(|parent| parent.to_path_buf())
            .ok_or_else(|| anyhow::anyhow!("invalid browse path {}", candidate.display()));
    }

    let mut existing = candidate.as_path();

    while !existing.exists() {
        if existing.file_name().is_none() {
            return default_browse_directory();
        }
        existing = existing
            .parent()
            .ok_or_else(|| anyhow::anyhow!("invalid browse path {}", candidate.display()))?;
    }

    let mut resolved = existing
        .canonicalize()
        .with_context(|| format!("failed to resolve {}", existing.display()))?;

    if !resolved.is_dir() {
        resolved = resolved
            .parent()
            .map(|parent| parent.to_path_buf())
            .ok_or_else(|| anyhow::anyhow!("invalid browse path {}", candidate.display()))?;
    }

    Ok(resolved)
}

fn list_directory_entries(directory: &Path) -> Result<Vec<FilesystemBrowseEntry>> {
    let mut entries: Vec<_> = std::fs::read_dir(directory)
        .with_context(|| format!("failed to read directory {}", directory.display()))?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let file_type = entry.file_type().ok()?;
            if !file_type.is_dir() && !file_type.is_symlink() {
                return None;
            }
            let canonical = entry.path().canonicalize().ok()?;
            if !canonical.is_dir() {
                return None;
            }
            Some(FilesystemBrowseEntry {
                name: entry.file_name().to_string_lossy().into_owned(),
                full_path: display_path(&canonical),
            })
        })
        .collect();

    entries.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    Ok(entries)
}

fn parent_browse_entry(directory: &Path) -> Option<FilesystemBrowseEntry> {
    let full_path = match directory.parent() {
        Some(parent) if parent != directory => display_path(parent),
        #[cfg(windows)]
        _ => "\\".to_string(),
        #[cfg(not(windows))]
        _ => return None,
    };

    Some(FilesystemBrowseEntry {
        name: "..".to_string(),
        full_path,
    })
}

fn display_path(path: &Path) -> String {
    crate::paths::simplified_path(path)
        .to_string_lossy()
        .into_owned()
}

#[cfg(any(windows, test))]
fn is_windows_volume_list_query(path: &str) -> bool {
    path == "/" || path == "\\"
}

#[cfg(any(windows, test))]
fn drive_letters_from_mask(mask: u32) -> Vec<char> {
    (b'A'..=b'Z')
        .enumerate()
        .filter(|(index, _)| mask & (1 << *index) != 0)
        .map(|(_, letter)| char::from(letter))
        .collect()
}

#[cfg(windows)]
fn list_windows_volumes() -> Result<FilesystemBrowseResult> {
    let entries = drive_letters_from_mask(logical_drive_mask())
        .into_iter()
        .map(|letter| FilesystemBrowseEntry {
            name: format!("{letter}:\\"),
            full_path: format!("{letter}:\\"),
        })
        .collect();

    Ok(FilesystemBrowseResult {
        parent_path: "\\".to_string(),
        entries,
        volume_list: true,
    })
}

#[cfg(windows)]
fn logical_drive_mask() -> u32 {
    // SAFETY: GetLogicalDrives is a parameterless Win32 query.
    unsafe { GetLogicalDrives() }
}

#[cfg(windows)]
unsafe extern "system" {
    fn GetLogicalDrives() -> u32;
}

fn default_browse_directory() -> Result<PathBuf> {
    if let Some(home) = crate::paths::home_dir() {
        if home.exists() {
            return home
                .canonicalize()
                .with_context(|| format!("failed to resolve home directory {}", home.display()));
        }
    }

    PathBuf::from("/")
        .canonicalize()
        .context("failed to resolve /")
}

fn is_relative_path(path: &str) -> bool {
    path.starts_with("./")
        || path.starts_with("../")
        || path.starts_with(".\\")
        || path.starts_with("..\\")
        || (!path.starts_with('/')
            && !path.starts_with('\\')
            && !path.starts_with('~')
            && !is_windows_absolute(path))
}

fn is_windows_absolute(path: &str) -> bool {
    let mut chars = path.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    let Some(second) = chars.next() else {
        return false;
    };

    first.is_ascii_alphabetic() && second == ':'
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
                    bail!("path escapes above the filesystem root");
                }
            }
        }
    }

    Ok(normalized)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        crate::test_support::temp_workspace_labeled(name)
    }

    #[test]
    fn lists_child_directories() {
        let root = temp_dir("sprocket-browse-root");
        let child = root.join("child-a");
        fs::create_dir_all(&child).expect("child dir");

        let result = browse_filesystem(&root.to_string_lossy(), None).expect("browse");
        let names: Vec<String> = result
            .entries
            .iter()
            .map(|entry| entry.name.clone())
            .collect();

        assert!(names.contains(&"..".to_string()));
        assert!(names.contains(&"child-a".to_string()));

        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn resolves_nonexistent_leaf_against_existing_parent() {
        let root = temp_dir("sprocket-browse-parent");
        let partial = root.join("new-project").to_string_lossy().to_string();

        let result = browse_filesystem(&partial, None).expect("browse");
        assert_eq!(result.parent_path, root.to_string_lossy());

        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn listing_succeeds_when_a_child_cannot_be_resolved() {
        let root = temp_dir("sprocket-browse-mixed");
        fs::create_dir(root.join("visible")).expect("visible dir");
        fs::write(root.join("notes.txt"), "hi").expect("file");

        #[cfg(unix)]
        std::os::unix::fs::symlink("missing", root.join("broken")).expect("dangling symlink");

        let result = browse_filesystem(&root.to_string_lossy(), None).expect("browse");
        let names: Vec<&str> = result
            .entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect();

        assert!(names.contains(&"visible"));
        assert!(!names.contains(&"notes.txt"));
        #[cfg(unix)]
        assert!(!names.contains(&"broken"));

        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn filesystem_root_can_be_browsed() {
        let result = browse_filesystem("/", None).expect("browse root");
        assert!(!result.entries.is_empty());
        assert!(!result.entries.iter().any(|entry| entry.name == ".."));
    }

    #[test]
    fn parses_windows_logical_drive_mask() {
        assert_eq!(drive_letters_from_mask(0b1101), vec!['A', 'C', 'D']);
    }

    #[test]
    fn detects_windows_volume_list_query() {
        assert!(is_windows_volume_list_query("/"));
        assert!(is_windows_volume_list_query("\\"));
        assert!(!is_windows_volume_list_query("//server/share"));
        assert!(!is_windows_volume_list_query(r"D:\"));
    }
}
