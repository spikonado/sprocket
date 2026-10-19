use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet};
use std::fs::Permissions;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail};
use diffy::patch_set::{FileOperation, ParseOptions, PatchKind, PatchSet};
use serde::Serialize;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex as AsyncMutex;

use crate::apply_patch_format::{
    PatchHunk, apply_update, is_apply_patch_format, parse_apply_patch,
};
use crate::commands::WorkspaceCancellation;
use crate::paths::{canonicalize_with_missing_tail, normalize_path};
use crate::unified_diff::{
    normalize_unified_diff_hunk_counts, strip_surrounding_markdown_fence, unidiff_path_strip,
};

/// Patches may target any absolute path and runs may start from different
/// directories, so one process-wide lock is the only key every overlapping
/// write shares.
static PATCH_LOCK: AsyncMutex<()> = AsyncMutex::const_new(());

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyPatchOutput {
    pub changes: Vec<PatchChangeOutput>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchChangeOutput {
    pub path: String,
    pub operation: PatchOperation,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PatchOperation {
    Created,
    Updated,
    Deleted,
    Renamed,
    Copied,
}

enum PreparedChange {
    Create {
        path: PathBuf,
        contents: Vec<u8>,
    },
    Delete {
        path: PathBuf,
    },
    Modify {
        source: PathBuf,
        destination: PathBuf,
        contents: Vec<u8>,
        permissions: Permissions,
    },
    Rename {
        source: PathBuf,
        destination: PathBuf,
        contents: Vec<u8>,
        permissions: Permissions,
    },
    Copy {
        source: PathBuf,
        destination: PathBuf,
        contents: Vec<u8>,
        permissions: Permissions,
    },
}

struct FileSnapshot {
    contents: Vec<u8>,
    permissions: Permissions,
}

struct PatchSnapshot {
    files: BTreeMap<PathBuf, Option<FileSnapshot>>,
    missing_directories: Vec<PathBuf>,
}

pub async fn apply_workspace_patch(
    workspace_root: PathBuf,
    cancellation: WorkspaceCancellation,
    patch: &str,
) -> Result<ApplyPatchOutput> {
    cancellation.ensure_active()?;
    if patch.trim().is_empty() {
        bail!("patch cannot be empty");
    }

    let workspace_root = tokio::fs::canonicalize(&workspace_root)
        .await
        .with_context(|| format!("failed to resolve workspace {}", workspace_root.display()))?;
    let _patch_guard = tokio::select! {
        guard = PATCH_LOCK.lock() => guard,
        _ = cancellation.cancelled() => return Err(crate::commands::WorkspaceOperationCancelled.into()),
    };
    cancellation.ensure_active()?;
    let changes = prepare_changes(&workspace_root, patch).await?;
    if changes.is_empty() {
        bail!("patch does not contain any file changes");
    }

    let snapshots = snapshot_paths(&changes).await?;
    let output = change_outputs(&workspace_root, &changes);

    if let Err(error) = apply_changes(&cancellation, &changes).await {
        if let Err(rollback_error) = restore_snapshot(&snapshots).await {
            return Err(error).context(format!(
                "patch failed and rollback also failed: {rollback_error:#}"
            ));
        }
        return Err(error);
    }

    Ok(ApplyPatchOutput { changes: output })
}

/// Join relative paths against `root`, normalize `.`/`..`, and canonicalize
/// existing paths (or the deepest existing ancestor when `allow_missing`).
/// Does not confine results to the workspace root.
fn resolve_patch_path(root: &Path, path: &str, allow_missing: bool) -> Result<PathBuf> {
    let expanded = crate::paths::expand_home(path);
    let candidate = if Path::new(&expanded).is_absolute() {
        PathBuf::from(&expanded)
    } else {
        root.join(&expanded)
    };

    let resolved = normalize_path(&candidate)?;

    if allow_missing {
        canonicalize_with_missing_tail(&resolved)
    } else {
        if !resolved.exists() {
            bail!("path does not exist: {}", resolved.display());
        }

        resolved
            .canonicalize()
            .with_context(|| format!("failed to resolve {}", resolved.display()))
    }
}

fn display_path(root: &Path, path: &Path) -> String {
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

async fn prepare_changes(root: &Path, patch: &str) -> Result<Vec<PreparedChange>> {
    let patch = strip_surrounding_markdown_fence(patch);
    if is_apply_patch_format(patch) {
        return prepare_apply_patch_changes(root, patch).await;
    }

    // Without a trailing newline, the last body line is treated as a no-newline-at-EOF edit.
    let patch = if patch.ends_with('\n') {
        Cow::Borrowed(patch)
    } else {
        Cow::Owned(format!("{patch}\n"))
    };
    let patch = normalize_unified_diff_hunk_counts(&patch)?;
    let (options, default_strip) = if patch.trim_start().starts_with("diff --git ") {
        (ParseOptions::gitdiff(), 1)
    } else {
        (ParseOptions::unidiff(), unidiff_path_strip(&patch))
    };

    let mut changes = Vec::new();
    let mut touched_paths = BTreeSet::new();

    for parsed in PatchSet::parse(&patch, options) {
        let parsed = parsed.context("failed to parse unified diff")?;
        let operation = parsed.operation();
        let strip = match operation {
            FileOperation::Rename { .. } | FileOperation::Copy { .. } => 0,
            _ => default_strip,
        };

        match operation.strip_prefix(strip) {
            FileOperation::Create(path) => {
                let path = resolve_patch_path(root, &path, true)?;
                ensure_missing(&path).await?;
                reserve_path(&mut touched_paths, &path)?;
                let contents = apply_text_patch(&path, &[], parsed.patch())?;
                changes.push(PreparedChange::Create { path, contents });
            }
            FileOperation::Delete(path) => {
                let path = resolve_existing_file(root, &path).await?;
                reserve_path(&mut touched_paths, &path)?;
                let header_only = parsed
                    .patch()
                    .as_text()
                    .is_some_and(|patch| patch.hunks().is_empty());
                if !header_only {
                    let remaining =
                        apply_text_patch(&path, &read_file(&path).await?, parsed.patch())?;
                    if !remaining.is_empty() {
                        bail!(
                            "delete patch does not remove all contents from {}",
                            path.display()
                        );
                    }
                }
                changes.push(PreparedChange::Delete { path });
            }
            FileOperation::Modify { original, modified } => {
                let source = resolve_existing_file(root, &original).await?;
                let destination = resolve_patch_path(root, &modified, true)?;
                reserve_path(&mut touched_paths, &source)?;
                if source != destination {
                    ensure_missing(&destination).await?;
                    reserve_path(&mut touched_paths, &destination)?;
                }
                let contents =
                    apply_text_patch(&source, &read_file(&source).await?, parsed.patch())?;
                let permissions = file_permissions(&source).await?;
                changes.push(PreparedChange::Modify {
                    source,
                    destination,
                    contents,
                    permissions,
                });
            }
            FileOperation::Rename { from, to } => {
                let source = resolve_existing_file(root, &from).await?;
                let destination = resolve_patch_path(root, &to, true)?;
                ensure_missing(&destination).await?;
                reserve_path(&mut touched_paths, &source)?;
                reserve_path(&mut touched_paths, &destination)?;
                let contents =
                    apply_text_patch(&source, &read_file(&source).await?, parsed.patch())?;
                let permissions = file_permissions(&source).await?;
                changes.push(PreparedChange::Rename {
                    source,
                    destination,
                    contents,
                    permissions,
                });
            }
            FileOperation::Copy { from, to } => {
                let source = resolve_existing_file(root, &from).await?;
                let destination = resolve_patch_path(root, &to, true)?;
                ensure_missing(&destination).await?;
                reserve_path(&mut touched_paths, &destination)?;
                let contents =
                    apply_text_patch(&source, &read_file(&source).await?, parsed.patch())?;
                let permissions = file_permissions(&source).await?;
                changes.push(PreparedChange::Copy {
                    source,
                    destination,
                    contents,
                    permissions,
                });
            }
        }
    }

    Ok(changes)
}

async fn prepare_apply_patch_changes(root: &Path, patch: &str) -> Result<Vec<PreparedChange>> {
    let hunks = parse_apply_patch(patch).context("failed to parse Begin Patch input")?;
    let mut changes = Vec::with_capacity(hunks.len());
    let mut touched_paths = BTreeSet::new();

    for hunk in hunks {
        match hunk {
            PatchHunk::Add { path, contents } => {
                let path = resolve_patch_path(root, &path, true)?;
                ensure_missing(&path).await?;
                reserve_path(&mut touched_paths, &path)?;
                changes.push(PreparedChange::Create { path, contents });
            }
            PatchHunk::Delete { path } => {
                let path = resolve_existing_file(root, &path).await?;
                reserve_path(&mut touched_paths, &path)?;
                changes.push(PreparedChange::Delete { path });
            }
            PatchHunk::Update {
                path,
                move_to,
                chunks,
            } => {
                let source = resolve_existing_file(root, &path).await?;
                reserve_path(&mut touched_paths, &source)?;
                let base = read_file(&source).await?;
                let contents = if chunks.is_empty() {
                    base
                } else {
                    apply_update(&source, &base, &chunks)?
                };
                let permissions = file_permissions(&source).await?;

                if let Some(destination) = move_to {
                    let destination = resolve_patch_path(root, &destination, true)?;
                    ensure_missing(&destination).await?;
                    reserve_path(&mut touched_paths, &destination)?;
                    changes.push(PreparedChange::Rename {
                        source,
                        destination,
                        contents,
                        permissions,
                    });
                } else {
                    changes.push(PreparedChange::Modify {
                        destination: source.clone(),
                        source,
                        contents,
                        permissions,
                    });
                }
            }
            PatchHunk::Copy {
                path,
                copy_to,
                chunks,
            } => {
                let source = resolve_existing_file(root, &path).await?;
                let destination = resolve_patch_path(root, &copy_to, true)?;
                ensure_missing(&destination).await?;
                reserve_path(&mut touched_paths, &destination)?;
                let base = read_file(&source).await?;
                let contents = if chunks.is_empty() {
                    base
                } else {
                    apply_update(&source, &base, &chunks)?
                };
                let permissions = file_permissions(&source).await?;
                changes.push(PreparedChange::Copy {
                    source,
                    destination,
                    contents,
                    permissions,
                });
            }
        }
    }

    Ok(changes)
}

fn apply_text_patch(path: &Path, base: &[u8], patch: &PatchKind<'_, str>) -> Result<Vec<u8>> {
    (|| {
        let text_patch = patch
            .as_text()
            .ok_or_else(|| anyhow!("binary patches are not supported"))?;
        let base = std::str::from_utf8(base).context("patch target is not valid UTF-8")?;
        diffy::apply(base, text_patch)
            .map(String::into_bytes)
            .context("patch context did not match the file")
    })()
    .with_context(|| format!("failed to apply patch to {}", path.display()))
}

async fn read_file(path: &Path) -> Result<Vec<u8>> {
    tokio::fs::read(path)
        .await
        .with_context(|| format!("failed to read {}", path.display()))
}

async fn resolve_existing_file(root: &Path, path: &str) -> Result<PathBuf> {
    let path = resolve_patch_path(root, path, false)?;
    let metadata = tokio::fs::metadata(&path)
        .await
        .with_context(|| format!("failed to inspect {}", path.display()))?;
    if !metadata.is_file() {
        bail!("patch path is not a file: {}", path.display());
    }
    Ok(path)
}

async fn ensure_missing(path: &Path) -> Result<()> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(_) => bail!("patch destination already exists: {}", path.display()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| format!("failed to inspect {}", path.display())),
    }
}

fn reserve_path(paths: &mut BTreeSet<PathBuf>, path: &Path) -> Result<()> {
    if !paths.insert(path.to_owned()) {
        bail!(
            "patch changes the same path more than once: {}",
            path.display()
        );
    }
    Ok(())
}

async fn snapshot_paths(changes: &[PreparedChange]) -> Result<PatchSnapshot> {
    let mut paths = BTreeSet::new();
    for change in changes {
        match change {
            PreparedChange::Create { path, .. } | PreparedChange::Delete { path } => {
                paths.insert(path.clone());
            }
            PreparedChange::Modify {
                source,
                destination,
                ..
            }
            | PreparedChange::Rename {
                source,
                destination,
                ..
            } => {
                paths.insert(source.clone());
                paths.insert(destination.clone());
            }
            PreparedChange::Copy { destination, .. } => {
                paths.insert(destination.clone());
            }
        }
    }

    let missing_directories = missing_parent_directories(&paths).await?;
    let mut files = BTreeMap::new();
    for path in paths {
        let snapshot = match tokio::fs::metadata(&path).await {
            Ok(metadata) => Some(FileSnapshot {
                contents: read_file(&path).await?,
                permissions: metadata.permissions(),
            }),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => {
                return Err(error).with_context(|| format!("failed to inspect {}", path.display()));
            }
        };
        files.insert(path, snapshot);
    }

    Ok(PatchSnapshot {
        files,
        missing_directories,
    })
}

async fn missing_parent_directories(paths: &BTreeSet<PathBuf>) -> Result<Vec<PathBuf>> {
    let mut directories = BTreeSet::new();
    for path in paths {
        let mut parent = path.parent();
        while let Some(directory) = parent {
            if tokio::fs::try_exists(directory).await? {
                break;
            }
            directories.insert(directory.to_owned());
            parent = directory.parent();
        }
    }

    let mut directories = directories.into_iter().collect::<Vec<_>>();
    directories.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
    Ok(directories)
}

async fn apply_changes(
    cancellation: &WorkspaceCancellation,
    changes: &[PreparedChange],
) -> Result<()> {
    for change in changes {
        cancellation.ensure_active()?;
        match change {
            PreparedChange::Create { path, contents } => {
                write_new_file(path, contents, None).await?
            }
            PreparedChange::Delete { path } => remove_file(path, "deleted file").await?,
            PreparedChange::Modify {
                source,
                destination,
                contents,
                permissions,
            } => {
                if source == destination {
                    replace_file(destination, contents, permissions.clone()).await?;
                } else {
                    write_new_file(destination, contents, Some(permissions.clone())).await?;
                    remove_file(source, "modified source").await?;
                }
            }
            PreparedChange::Rename {
                source,
                destination,
                contents,
                permissions,
            } => {
                write_new_file(destination, contents, Some(permissions.clone())).await?;
                remove_file(source, "renamed source").await?;
            }
            PreparedChange::Copy {
                destination,
                contents,
                permissions,
                ..
            } => {
                write_new_file(destination, contents, Some(permissions.clone())).await?;
            }
        }
    }
    cancellation.ensure_active()
}

async fn write_new_file(
    path: &Path,
    contents: &[u8],
    permissions: Option<Permissions>,
) -> Result<()> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .with_context(|| format!("failed to create {}", path.display()))?;
    }
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .await
        .with_context(|| format!("failed to create {}", path.display()))?;
    if let Some(permissions) = permissions {
        file.set_permissions(permissions)
            .await
            .with_context(|| format!("failed to set permissions for {}", path.display()))?;
    }
    file.write_all(contents)
        .await
        .with_context(|| format!("failed to write {}", path.display()))?;
    file.flush()
        .await
        .with_context(|| format!("failed to flush {}", path.display()))
}

async fn replace_file(path: &Path, contents: &[u8], permissions: Permissions) -> Result<()> {
    let parent = path
        .parent()
        .with_context(|| format!("no parent directory for {}", path.display()))?;
    tokio::fs::create_dir_all(parent)
        .await
        .with_context(|| format!("failed to create {}", parent.display()))?;
    let parent = parent.to_owned();
    let staging = tokio::task::spawn_blocking(move || {
        tempfile::Builder::new()
            .prefix(".sprocket-patch-")
            .tempdir_in(parent)
    })
    .await
    .context("staging directory task failed")?
    .with_context(|| format!("failed to stage replacement for {}", path.display()))?;
    let staged_path = staging.path().join("replacement");
    write_new_file(&staged_path, contents, Some(permissions))
        .await
        .with_context(|| format!("failed to stage replacement for {}", path.display()))?;
    tokio::fs::rename(&staged_path, path)
        .await
        .with_context(|| format!("failed to replace {}", path.display()))
}

async fn file_permissions(path: &Path) -> Result<Permissions> {
    tokio::fs::metadata(path)
        .await
        .map(|metadata| metadata.permissions())
        .with_context(|| format!("failed to inspect {}", path.display()))
}

async fn remove_file(path: &Path, description: &str) -> Result<()> {
    tokio::fs::remove_file(path)
        .await
        .with_context(|| format!("failed to remove {description} {}", path.display()))
}

async fn restore_snapshot(snapshot: &PatchSnapshot) -> Result<()> {
    let mut errors = Vec::new();
    for (path, file_snapshot) in &snapshot.files {
        let result = match file_snapshot {
            Some(file_snapshot) => {
                replace_file(
                    path,
                    &file_snapshot.contents,
                    file_snapshot.permissions.clone(),
                )
                .await
            }
            None => match tokio::fs::remove_file(path).await {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(error) => Err(error.into()),
            },
        };
        if let Err(error) = result {
            errors.push(format!("{}: {error:#}", path.display()));
        }
    }

    for directory in &snapshot.missing_directories {
        match tokio::fs::remove_dir(directory).await {
            Ok(()) => {}
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::DirectoryNotEmpty
                ) => {}
            Err(error) => errors.push(format!("{}: {error}", directory.display())),
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        bail!("failed to restore workspace: {}", errors.join("; "))
    }
}

fn change_outputs(root: &Path, changes: &[PreparedChange]) -> Vec<PatchChangeOutput> {
    changes
        .iter()
        .map(|change| {
            let (path, operation, source) = match change {
                PreparedChange::Create { path, .. } => (path, PatchOperation::Created, None),
                PreparedChange::Delete { path } => (path, PatchOperation::Deleted, None),
                PreparedChange::Modify { destination, .. } => {
                    (destination, PatchOperation::Updated, None)
                }
                PreparedChange::Rename {
                    source,
                    destination,
                    ..
                } => (
                    destination,
                    PatchOperation::Renamed,
                    Some(display_path(root, source)),
                ),
                PreparedChange::Copy {
                    source,
                    destination,
                    ..
                } => (
                    destination,
                    PatchOperation::Copied,
                    Some(display_path(root, source)),
                ),
            };
            PatchChangeOutput {
                path: display_path(root, path),
                operation,
                source,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests;
