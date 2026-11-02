use std::fs::{self, File, Metadata};
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use anyhow::{Context, Result, anyhow, bail};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::paths::{canonicalize_with_missing_tail, normalize_path};

pub const MAX_EDITABLE_FILE_BYTES: u64 = 2 * 1024 * 1024;
/// Viewers such as KiCanvas render large boards; real `.kicad_pcb` files reach ~100 MiB.
const MAX_VIEWABLE_FILE_BYTES: u64 = 128 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFileContent {
    pub content: Option<String>,
    pub version: String,
    pub size: u64,
    pub unsupported: Option<UnsupportedFile>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UnsupportedFile {
    Binary,
    TooLarge,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum WorkspaceFileWrite {
    Saved { version: String },
    Conflict { version: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceEntryKind {
    File,
    Directory,
}

struct FileSnapshot {
    version: String,
    size: u64,
    bytes: Option<Vec<u8>>,
}

pub fn read_workspace_file(root: &Path, path: &str) -> Result<WorkspaceFileContent> {
    let file_path = resolve_entry(root, path, true)?;
    let snapshot = read_snapshot(&file_path, path)?;
    let (content, unsupported) = match snapshot.bytes {
        None => (None, Some(UnsupportedFile::TooLarge)),
        Some(bytes) => match String::from_utf8(bytes) {
            Ok(text) if !text.contains('\0') => (Some(text), None),
            _ => (None, Some(UnsupportedFile::Binary)),
        },
    };
    Ok(WorkspaceFileContent {
        content,
        version: snapshot.version,
        size: snapshot.size,
        unsupported,
    })
}

pub struct WorkspaceText {
    pub content: String,
    /// Matches the `version` that file watches report, so a viewer can tell whether it missed a write.
    pub version: String,
}

pub fn read_workspace_text(root: &Path, path: &str) -> Result<WorkspaceText> {
    let file_path = resolve_entry(root, path, true)?;
    let file = File::open(&file_path).map_err(|error| entry_error(error, path, "open"))?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        bail!("{path} is not a file");
    }
    let mut bytes = Vec::new();
    (&file)
        .take(MAX_VIEWABLE_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .with_context(|| format!("failed to read {path}"))?;
    if bytes.len() as u64 > MAX_VIEWABLE_FILE_BYTES {
        bail!("{path} exceeds the 128 MiB viewer limit");
    }
    let version = if bytes.len() as u64 > MAX_EDITABLE_FILE_BYTES {
        too_large_snapshot(&metadata).version
    } else {
        content_version(&bytes)
    };
    let content = String::from_utf8(bytes).map_err(|_| anyhow!("{path} is not UTF-8 text"))?;
    Ok(WorkspaceText { content, version })
}

pub fn workspace_entry_kind(root: &Path, path: &str) -> Result<WorkspaceEntryKind> {
    let entry = resolve_entry(root, path, true)?;
    let metadata = fs::metadata(&entry).map_err(|error| entry_error(error, path, "inspect"))?;
    Ok(if metadata.is_dir() {
        WorkspaceEntryKind::Directory
    } else {
        WorkspaceEntryKind::File
    })
}

/// `expected_version: None` overwrites unconditionally.
pub fn write_workspace_file(
    root: &Path,
    path: &str,
    content: &str,
    expected_version: Option<&str>,
) -> Result<WorkspaceFileWrite> {
    if content.len() as u64 > MAX_EDITABLE_FILE_BYTES {
        bail!("file content exceeds the 2 MiB editor limit");
    }
    let file_path = resolve_entry(root, path, true)?;
    // Callers run on blocking threads; `blocking_lock` panics inside an async context.
    let _write_guard = crate::patch::PATCH_LOCK.blocking_lock();
    let existing = match fs::metadata(&file_path) {
        Ok(metadata) if metadata.is_file() => Some(metadata),
        Ok(_) => bail!("{path} is not a file"),
        Err(error) if error.kind() == ErrorKind::NotFound => None,
        Err(error) => return Err(error).with_context(|| format!("failed to inspect {path}")),
    };

    if let Some(expected) = expected_version {
        let current = match existing {
            Some(_) => read_snapshot(&file_path, path)?.version,
            None => String::new(),
        };
        if current != expected {
            return Ok(WorkspaceFileWrite::Conflict { version: current });
        }
    }

    let parent = file_path
        .parent()
        .with_context(|| format!("no parent directory for {path}"))?;
    fs::create_dir_all(parent).with_context(|| format!("failed to create parent of {path}"))?;
    let mut builder = tempfile::Builder::new();
    builder.prefix(".sprocket-save-");
    #[cfg(unix)]
    if existing.is_none() {
        use std::os::unix::fs::PermissionsExt;
        builder.permissions(fs::Permissions::from_mode(0o666));
    }
    let mut staged = builder
        .tempfile_in(parent)
        .with_context(|| format!("failed to stage {path}"))?;
    staged
        .write_all(content.as_bytes())
        .with_context(|| format!("failed to write {path}"))?;
    if let Some(metadata) = existing {
        staged
            .as_file()
            .set_permissions(metadata.permissions())
            .with_context(|| format!("failed to set permissions for {path}"))?;
    }
    staged
        .as_file()
        .sync_all()
        .with_context(|| format!("failed to flush {path}"))?;
    staged
        .persist(&file_path)
        .with_context(|| format!("failed to replace {path}"))?;

    Ok(WorkspaceFileWrite::Saved {
        version: content_version(content.as_bytes()),
    })
}

pub fn create_workspace_entry(root: &Path, path: &str, directory: bool) -> Result<()> {
    let entry = resolve_entry(root, path, false)?;
    if let Some(parent) = entry.parent() {
        fs::create_dir_all(parent).with_context(|| format!("failed to create parent of {path}"))?;
    }
    let created = if directory {
        fs::create_dir(&entry)
    } else {
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&entry)
            .map(drop)
    };
    created.map_err(|error| entry_error(error, path, "create"))
}

pub fn rename_workspace_entry(root: &Path, from: &str, to: &str) -> Result<()> {
    let source = resolve_entry(root, from, false)?;
    let destination = resolve_entry(root, to, false)?;
    fs::symlink_metadata(&source).map_err(|error| entry_error(error, from, "rename"))?;
    if destination.starts_with(&source) {
        bail!("cannot move {from} into itself");
    }
    if fs::symlink_metadata(&destination).is_ok() {
        bail!("{to} already exists");
    }
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).with_context(|| format!("failed to create parent of {to}"))?;
    }
    fs::rename(&source, &destination).with_context(|| format!("failed to rename {from} to {to}"))
}

pub fn delete_workspace_entry(root: &Path, path: &str) -> Result<()> {
    let entry = resolve_entry(root, path, false)?;
    let metadata =
        fs::symlink_metadata(&entry).map_err(|error| entry_error(error, path, "delete"))?;
    if metadata.is_dir() {
        fs::remove_dir_all(&entry)
    } else {
        fs::remove_file(&entry)
    }
    .with_context(|| format!("failed to delete {path}"))
}

/// Confines `path` to `root` and rejects the root itself. Without
/// `follow_final_link`, a trailing symlink is renamed or deleted as the link.
fn resolve_entry(root: &Path, path: &str, follow_final_link: bool) -> Result<PathBuf> {
    let root = root
        .canonicalize()
        .with_context(|| format!("failed to resolve workspace {}", root.display()))?;
    let relative = Path::new(path.trim_end_matches('/'));
    if relative.as_os_str().is_empty() {
        bail!("path must name an entry inside the workspace");
    }
    if relative.has_root() || relative.is_absolute() {
        bail!("path must be relative to the workspace: {path}");
    }
    let joined = normalize_path(&root.join(relative))?;
    let (Some(parent), Some(name)) = (joined.parent(), joined.file_name()) else {
        bail!("path escapes the workspace: {path}");
    };
    let entry = canonicalize_with_missing_tail(parent)?.join(name);
    let resolved = if follow_final_link {
        canonicalize_with_missing_tail(&entry)?
    } else {
        entry
    };
    if resolved == root || !resolved.starts_with(&root) {
        bail!("path escapes the workspace: {path}");
    }
    Ok(resolved)
}

fn read_snapshot(file_path: &Path, path: &str) -> Result<FileSnapshot> {
    let file = File::open(file_path).map_err(|error| entry_error(error, path, "open"))?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        bail!("{path} is not a file");
    }
    if metadata.len() > MAX_EDITABLE_FILE_BYTES {
        return Ok(too_large_snapshot(&metadata));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    (&file)
        .take(MAX_EDITABLE_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .with_context(|| format!("failed to read {path}"))?;
    if bytes.len() as u64 > MAX_EDITABLE_FILE_BYTES {
        return Ok(too_large_snapshot(&file.metadata()?));
    }
    Ok(FileSnapshot {
        version: content_version(&bytes),
        size: bytes.len() as u64,
        bytes: Some(bytes),
    })
}

fn too_large_snapshot(metadata: &Metadata) -> FileSnapshot {
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .unwrap_or_default()
        .as_nanos();
    FileSnapshot {
        version: format!("{}-{modified}", metadata.len()),
        size: metadata.len(),
        bytes: None,
    }
}

fn content_version(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn entry_error(error: std::io::Error, path: &str, action: &str) -> anyhow::Error {
    match error.kind() {
        ErrorKind::AlreadyExists => anyhow!("{path} already exists"),
        ErrorKind::NotFound => anyhow!("{path} does not exist"),
        _ => anyhow::Error::new(error).context(format!("failed to {action} {path}")),
    }
}

#[cfg(test)]
mod tests;
