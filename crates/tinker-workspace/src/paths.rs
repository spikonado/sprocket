use std::path::{Component, Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail};

pub fn expand_home(path: &str) -> String {
    expand_home_with(path, home_dir().as_deref())
}

fn expand_home_with(path: &str, home: Option<&Path>) -> String {
    let Some(home) = home else {
        return path.to_string();
    };

    if path == "~" {
        return home.to_string_lossy().to_string();
    }

    if let Some(rest) = path.strip_prefix("~/") {
        return format!("{}/{}", home.to_string_lossy(), rest);
    }

    if let Some(rest) = path.strip_prefix("~\\") {
        return format!("{}\\{}", home.to_string_lossy(), rest);
    }

    path.to_string()
}

pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))
}

pub fn resolve_directory(base: &Path, path: &str) -> Result<PathBuf> {
    let expanded = PathBuf::from(expand_home(path.trim()));
    let candidate = if expanded.is_absolute() {
        expanded
    } else {
        base.join(expanded)
    };
    let resolved = candidate
        .canonicalize()
        .with_context(|| format!("failed to resolve directory {}", candidate.display()))?;
    if !resolved.is_dir() {
        bail!("not a directory: {}", resolved.display());
    }
    Ok(resolved)
}

pub fn normalize_windows_drive_root(path: &str) -> String {
    let bytes = path.as_bytes();
    if bytes.len() == 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        format!("{path}\\")
    } else {
        path.to_string()
    }
}

pub(crate) fn normalize_path(path: &Path) -> Result<PathBuf> {
    let mut normalized = PathBuf::new();

    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::Normal(segment) => normalized.push(segment),
            Component::ParentDir => {
                if matches!(
                    normalized.components().next_back(),
                    Some(Component::Normal(_))
                ) {
                    normalized.pop();
                } else if !normalized.has_root() {
                    normalized.push("..");
                }
                // Absolute path already at root: treat extra `..` as a no-op.
            }
        }
    }

    if normalized.as_os_str().is_empty() {
        bail!("invalid path {}", path.display());
    }

    Ok(normalized)
}

pub(crate) fn canonicalize_with_missing_tail(path: &Path) -> Result<PathBuf> {
    let mut existing_ancestor = path;
    let mut suffix = Vec::new();

    while !existing_ancestor.exists() {
        let name = existing_ancestor
            .file_name()
            .ok_or_else(|| anyhow!("invalid path {}", path.display()))?;
        suffix.push(name.to_os_string());
        existing_ancestor = existing_ancestor
            .parent()
            .ok_or_else(|| anyhow!("invalid path {}", path.display()))?;
    }

    let mut canonical = existing_ancestor
        .canonicalize()
        .with_context(|| format!("failed to resolve {}", existing_ancestor.display()))?;

    for component in suffix.into_iter().rev() {
        canonical.push(component);
    }

    Ok(canonical)
}

/// Strips Windows `\\?\` drive and UNC prefixes so paths are usable in the UI.
pub fn simplified_path(path: impl AsRef<Path>) -> PathBuf {
    PathBuf::from(simplified_path_str(&path.as_ref().to_string_lossy()))
}

fn simplified_path_str(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = path.strip_prefix(r"\\?\") {
        if rest.len() >= 2 && rest.as_bytes()[0].is_ascii_alphabetic() && rest.as_bytes()[1] == b':'
        {
            rest.to_string()
        } else {
            path.to_string()
        }
    } else {
        path.to_string()
    }
}

#[cfg(test)]
mod tests;
