use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs::Permissions;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, OnceLock, Weak};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, anyhow, bail};
use diffy::patch_set::{FileOperation, ParseOptions, PatchKind, PatchSet};
use serde::Serialize;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex as AsyncMutex;

use crate::apply_patch_format::{
    PatchHunk, apply_update, is_apply_patch_format, parse_apply_patch,
};
use crate::tools::WorkspaceCancellation;

type WorkspacePatchLock = AsyncMutex<()>;

static WORKSPACE_PATCH_LOCKS: OnceLock<StdMutex<HashMap<PathBuf, Weak<WorkspacePatchLock>>>> =
    OnceLock::new();

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
    let patch_lock = workspace_patch_lock(&workspace_root);
    let patch_guard = tokio::select! {
        guard = patch_lock.lock() => guard,
        _ = cancellation.cancelled() => return Err(crate::tools::WorkspaceOperationCancelled.into()),
    };
    let result = async {
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
    .await;

    drop(patch_guard);
    release_workspace_patch_lock(&workspace_root, &patch_lock);
    result
}

fn workspace_patch_lock(root: &Path) -> Arc<WorkspacePatchLock> {
    let locks = WORKSPACE_PATCH_LOCKS.get_or_init(|| StdMutex::new(HashMap::new()));
    let mut locks = locks
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(lock) = locks.get(root).and_then(Weak::upgrade) {
        return lock;
    }

    let lock = Arc::new(WorkspacePatchLock::new(()));
    locks.insert(root.to_owned(), Arc::downgrade(&lock));
    lock
}

fn release_workspace_patch_lock(root: &Path, lock: &Arc<WorkspacePatchLock>) {
    let Some(locks) = WORKSPACE_PATCH_LOCKS.get() else {
        return;
    };
    let mut locks = locks
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if Arc::strong_count(lock) == 1
        && locks
            .get(root)
            .is_some_and(|registered| registered.ptr_eq(&Arc::downgrade(lock)))
    {
        locks.remove(root);
    }
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
        resolve_missing_patch_path(&resolved)
    } else {
        if !resolved.exists() {
            bail!("path does not exist: {}", resolved.display());
        }

        resolved
            .canonicalize()
            .with_context(|| format!("failed to resolve {}", resolved.display()))
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

fn resolve_missing_patch_path(resolved: &Path) -> Result<PathBuf> {
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

    for component in suffix.into_iter().rev() {
        canonical.push(component);
    }

    Ok(canonical)
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
                    destination,
                    contents,
                    permissions,
                });
            }
        }
    }

    Ok(changes)
}

fn unidiff_path_strip(patch: &str) -> usize {
    // Header-only unified diffs often still use git's a/ and b/ path prefixes.
    let mut saw_a = false;
    let mut saw_b = false;
    for line in patch.lines() {
        let line = line.trim_start();
        if line.starts_with("--- a/") || line.starts_with("--- \"a/") {
            saw_a = true;
        } else if line.starts_with("+++ b/") || line.starts_with("+++ \"b/") {
            saw_b = true;
        }
    }
    usize::from(saw_a && saw_b)
}

/// Strip a single surrounding markdown code fence (` ``` ` / ` ```diff `) when present.
///
/// Preserves patch-body whitespace (including trailing spaces/tabs on the last hunk line).
/// Only fence-separating newlines around the closing fence are removed.
fn strip_surrounding_markdown_fence(patch: &str) -> &str {
    let trimmed = patch.trim();
    if !trimmed.starts_with("```") {
        // Keep the original (incl. trailing newline); trimming would invent a no-newline-at-EOF edit.
        return patch;
    }
    let after_open = &trimmed[3..];
    let Some(newline) = after_open.find('\n') else {
        return patch;
    };
    let language = after_open[..newline].trim();
    if language
        .chars()
        .any(|c| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'))
    {
        return patch;
    }
    let body = &after_open[newline + 1..];
    // Closing fence on its own line (optional indent). Avoid `trim()` on the
    // body; that would strip intentional trailing spaces/tabs from the final
    // hunk line.
    if let Some((content, fence_line)) = body.rsplit_once('\n') {
        if fence_line.trim() == "```" {
            return content.strip_suffix('\r').unwrap_or(content);
        }
    }
    if body.trim() == "```" {
        return "";
    }
    patch
}

const NO_NEWLINE_MARKER: &str = "\\ No newline at end of file";

/// Rewrite `@@` hunk lengths from the body so wrong counts cannot truncate or fail before apply.
fn normalize_unified_diff_hunk_counts(patch: &str) -> Result<String> {
    let had_trailing_newline = patch.ends_with('\n');
    let lines = patch
        .lines()
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect::<Vec<_>>();

    let mut output = Vec::with_capacity(lines.len());
    let mut index = 0;
    while index < lines.len() {
        let line = lines[index];
        let Some((old_start, new_start, suffix)) = parse_unified_hunk_header(line) else {
            output.push(line.to_owned());
            index += 1;
            continue;
        };

        index += 1;
        let body_start = index;
        let mut old_count = 0usize;
        let mut new_count = 0usize;
        while index < lines.len() {
            if is_unified_section_boundary(&lines, index) {
                break;
            }
            let body_line = lines[index];
            // Blank lines immediately before the next file/hunk are padding, not context.
            if body_line.is_empty() && next_nonempty_is_section_boundary(&lines, index + 1) {
                break;
            }
            if is_no_newline_marker(body_line) {
                index += 1;
                continue;
            }
            match body_line.as_bytes().first() {
                None | Some(b' ') => {
                    old_count += 1;
                    new_count += 1;
                }
                Some(b'-') => old_count += 1,
                Some(b'+') => new_count += 1,
                _ => bail!(
                    "unexpected hunk body line at line {}: '{}'; \
                     expected a line starting with ' ', '+', or '-', or '{NO_NEWLINE_MARKER}'",
                    index + 1,
                    body_line
                ),
            }
            index += 1;
        }

        output.push(format_unified_hunk_header(
            old_start, old_count, new_start, new_count, suffix,
        ));
        output.extend(
            lines[body_start..index]
                .iter()
                .map(|line| (*line).to_owned()),
        );

        if index < lines.len() && !is_unified_section_boundary(&lines, index) {
            reject_orphaned_hunk_content(&lines, index)?;
        }
    }

    let mut normalized = output.join("\n");
    if had_trailing_newline {
        normalized.push('\n');
    }
    Ok(normalized)
}

/// Returns `(old_start, new_start, suffix)`; declared lengths are ignored (recounted from the body).
fn parse_unified_hunk_header(line: &str) -> Option<(usize, usize, &str)> {
    let rest = line.strip_prefix("@@ ")?;
    let (ranges, after) = rest.split_once(" @@")?;
    let (old_part, new_part) = ranges.split_once(' ')?;
    let old_part = old_part.strip_prefix('-')?;
    let new_part = new_part.strip_prefix('+')?;
    let (old_start, _) = parse_hunk_range(old_part)?;
    let (new_start, _) = parse_hunk_range(new_part)?;
    Some((old_start, new_start, after))
}

fn parse_hunk_range(range: &str) -> Option<(usize, usize)> {
    if let Some((start, len)) = range.split_once(',') {
        Some((start.parse().ok()?, len.parse().ok()?))
    } else {
        Some((range.parse().ok()?, 1))
    }
}

fn format_unified_hunk_header(
    old_start: usize,
    old_len: usize,
    new_start: usize,
    new_len: usize,
    suffix: &str,
) -> String {
    format!(
        "@@ -{} +{} @@{suffix}",
        format_hunk_range(old_start, old_len),
        format_hunk_range(new_start, new_len),
    )
}

fn format_hunk_range(start: usize, len: usize) -> String {
    if len == 1 {
        start.to_string()
    } else {
        format!("{start},{len}")
    }
}

fn is_no_newline_marker(line: &str) -> bool {
    line.starts_with(NO_NEWLINE_MARKER)
}

fn is_file_header_pair(lines: &[&str], index: usize) -> bool {
    if !lines[index].starts_with("--- ") {
        return false;
    }
    let mut next = index + 1;
    while next < lines.len() && lines[next].is_empty() {
        next += 1;
    }
    next < lines.len() && lines[next].starts_with("+++ ")
}

fn is_unified_section_boundary(lines: &[&str], index: usize) -> bool {
    let line = lines[index];
    line.starts_with("@@ ") || line.starts_with("diff --git ") || is_file_header_pair(lines, index)
}

fn next_nonempty_is_section_boundary(lines: &[&str], mut index: usize) -> bool {
    while index < lines.len() && lines[index].is_empty() {
        index += 1;
    }
    index >= lines.len() || is_unified_section_boundary(lines, index)
}

fn reject_orphaned_hunk_content(lines: &[&str], mut index: usize) -> Result<()> {
    while index < lines.len() {
        if is_unified_section_boundary(lines, index) {
            return Ok(());
        }
        if !lines[index].is_empty() {
            bail!(
                "orphaned hunk content at line {}: '{}'; \
                 fix the surrounding hunk or remove the leftover lines",
                index + 1,
                lines[index]
            );
        }
        index += 1;
    }
    Ok(())
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
    // Write the full replacement beside the target first. A crash mid-write
    // must not leave the original deleted with nothing in its place.
    // Use a unique sibling name so we never delete a user's `*.sprocket-tmp`
    // (or a recoverable `*.sprocket-bak` from an earlier failed replace).
    //
    // Windows replace moves the original to `*.sprocket-bak.*` before installing
    // the staged file; if that process dies mid-way, restore the backup first.
    recover_stranded_sprocket_bak(path).await?;

    let tmp = stage_unique_sibling(path, "tmp", contents, Some(permissions)).await?;

    match tokio::fs::rename(&tmp, path).await {
        Ok(()) => Ok(()),
        Err(error) => {
            #[cfg(windows)]
            {
                // Windows rename won't overwrite. Move the original aside first so
                // a failed install can restore it instead of deleting in place.
                if error.kind() == std::io::ErrorKind::AlreadyExists {
                    return replace_existing_windows(path, &tmp).await;
                }
            }
            let _ = tokio::fs::remove_file(&tmp).await;
            Err(error).with_context(|| format!("failed to replace {}", path.display()))
        }
    }
}

fn unique_sibling_path(path: &Path, kind: &str) -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let mut name = path
        .file_name()
        .map(|name| name.to_os_string())
        .unwrap_or_else(|| "file".into());
    name.push(format!(
        ".sprocket-{kind}.{}.{seq}.{nanos}",
        std::process::id()
    ));
    path.with_file_name(name)
}

async fn stage_unique_sibling(
    path: &Path,
    kind: &str,
    contents: &[u8],
    permissions: Option<Permissions>,
) -> Result<PathBuf> {
    let mut last_error = None;
    for _ in 0..16 {
        let candidate = unique_sibling_path(path, kind);
        if tokio::fs::try_exists(&candidate).await.unwrap_or(false) {
            continue;
        }
        match write_new_file(&candidate, contents, permissions.clone()).await {
            Ok(()) => return Ok(candidate),
            Err(error) => {
                let already_exists = error.chain().any(|cause| {
                    cause
                        .downcast_ref::<std::io::Error>()
                        .is_some_and(|io_error| {
                            io_error.kind() == std::io::ErrorKind::AlreadyExists
                        })
                });
                if already_exists {
                    last_error = Some(error);
                    continue;
                }
                // create_new succeeded and a later write step failed. Remove our
                // partial sibling instead of treating it as a name collision.
                let _ = tokio::fs::remove_file(&candidate).await;
                return Err(error).with_context(|| {
                    format!("failed to stage replacement for {}", path.display())
                });
            }
        }
    }
    Err(last_error.unwrap_or_else(|| anyhow!("failed to allocate staging path")))
        .with_context(|| format!("failed to stage replacement for {}", path.display()))
}

/// Restore `{name}.sprocket-bak.*` when `path` is missing after an interrupted replace.
async fn recover_stranded_sprocket_bak(path: &Path) -> Result<()> {
    if tokio::fs::try_exists(path).await.unwrap_or(false) {
        return Ok(());
    }
    let Some(bak) = newest_sprocket_bak_sibling(path).await? else {
        return Ok(());
    };
    tokio::fs::rename(&bak, path)
        .await
        .with_context(|| format!("failed to restore stranded backup for {}", path.display()))?;
    Ok(())
}

/// Matches `unique_sibling_path`: `{file_name}.sprocket-{kind}.{pid}.{seq}.{nanos}`.
fn parse_sprocket_sibling(name: &str, file_name: &str, kind: &str) -> Option<(u128, u64, u32)> {
    let prefix = format!("{file_name}.sprocket-{kind}.");
    let rest = name.strip_prefix(&prefix)?;
    let mut parts = rest.split('.');
    let pid: u32 = parts.next()?.parse().ok()?;
    let seq: u64 = parts.next()?.parse().ok()?;
    let nanos: u128 = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((nanos, seq, pid))
}

/// Same-process seq is monotonic even if the wall clock jumps backward.
/// Different processes have no shared counter, so timestamp is the fallback.
fn sprocket_sibling_is_newer(
    candidate: (u128, u64, u32),
    best: (u128, u64, u32),
) -> bool {
    let (candidate_nanos, candidate_seq, candidate_pid) = candidate;
    let (best_nanos, best_seq, best_pid) = best;
    if candidate_pid == best_pid {
        (candidate_seq, candidate_nanos) > (best_seq, best_nanos)
    } else {
        (candidate_nanos, candidate_seq, candidate_pid) > (best_nanos, best_seq, best_pid)
    }
}

async fn newest_sprocket_bak_sibling(path: &Path) -> Result<Option<PathBuf>> {
    let Some(parent) = path.parent() else {
        return Ok(None);
    };
    let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
        return Ok(None);
    };
    let mut entries = match tokio::fs::read_dir(parent).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(error).with_context(|| format!("failed to list {}", parent.display()));
        }
    };

    let mut newest: Option<((u128, u64, u32), PathBuf)> = None;
    while let Some(entry) = entries.next_entry().await? {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let Some(key) = parse_sprocket_sibling(name, file_name, "bak") else {
            continue;
        };
        if !entry.file_type().await?.is_file() {
            continue;
        }
        if newest
            .as_ref()
            .is_none_or(|(best, _)| sprocket_sibling_is_newer(key, *best))
        {
            newest = Some((key, entry.path()));
        }
    }
    Ok(newest.map(|(_, path)| path))
}

#[cfg(windows)]
async fn replace_existing_windows(path: &Path, tmp: &Path) -> Result<()> {
    // Never clear a pre-existing backup name; allocate a unique sibling instead.
    let bak = unique_sibling_path(path, "bak");

    match tokio::fs::rename(path, &bak).await {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            let _ = tokio::fs::remove_file(tmp).await;
            return Err(error).with_context(|| format!("failed to replace {}", path.display()));
        }
    }

    match tokio::fs::rename(tmp, path).await {
        Ok(()) => {
            let _ = tokio::fs::remove_file(&bak).await;
            Ok(())
        }
        Err(error) => {
            match tokio::fs::rename(&bak, path).await {
                Ok(()) => {
                    let _ = tokio::fs::remove_file(tmp).await;
                }
                Err(_) => {
                    // Leave bak + tmp so nothing is silently discarded.
                    // A later replace_file will restore bak if `path` is still missing.
                }
            }
            Err(error).with_context(|| format!("failed to replace {}", path.display()))
        }
    }
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
                // Same crash-safe replace as apply: never delete then rewrite.
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
            let (path, operation) = match change {
                PreparedChange::Create { path, .. } => (path, PatchOperation::Created),
                PreparedChange::Delete { path } => (path, PatchOperation::Deleted),
                PreparedChange::Modify { destination, .. } => {
                    (destination, PatchOperation::Updated)
                }
                PreparedChange::Rename { destination, .. } => {
                    (destination, PatchOperation::Renamed)
                }
                PreparedChange::Copy { destination, .. } => (destination, PatchOperation::Copied),
            };
            PatchChangeOutput {
                path: display_path(root, path),
                operation,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::Mutex;

    use super::{
        apply_workspace_patch, normalize_unified_diff_hunk_counts, recover_stranded_sprocket_bak,
        replace_file, sprocket_sibling_is_newer, write_new_file,
    };
    use crate::test_support::temp_workspace;
    use crate::tools::{WorkspaceCancellation, WorkspaceOperationCancelled};

    static HOME_ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn same_process_bak_prefers_later_seq_if_clock_jumps_back() {
        let older = (200_u128, 1_u64, 10_u32);
        let newer = (50_u128, 2_u64, 10_u32);
        assert!(sprocket_sibling_is_newer(newer, older));
        assert!(!sprocket_sibling_is_newer(older, newer));
    }

    #[tokio::test]
    async fn restores_stranded_sprocket_bak_before_replace() {
        let root = temp_workspace();
        let target = root.join("file.txt");
        let bak = root.join("file.txt.sprocket-bak.1.2.3");
        fs::write(&bak, "original\n").unwrap();
        assert!(!target.exists());

        recover_stranded_sprocket_bak(&target)
            .await
            .expect("stranded bak should restore");
        assert_eq!(fs::read_to_string(&target).unwrap(), "original\n");
        assert!(!bak.exists());

        replace_file(
            &target,
            b"replacement\n",
            fs::metadata(&target).unwrap().permissions(),
        )
        .await
        .expect("replace after recovery");
        assert_eq!(fs::read_to_string(&target).unwrap(), "replacement\n");
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn recovery_ignores_non_format_sprocket_bak_siblings() {
        let root = temp_workspace();
        let target = root.join("file.txt");
        let user_notes = root.join("file.txt.sprocket-bak.notes");
        let stale = root.join("file.txt.sprocket-bak.1.1.100");
        let newest = root.join("file.txt.sprocket-bak.1.2.200");
        fs::write(&user_notes, "user notes\n").unwrap();
        fs::write(&stale, "stale original\n").unwrap();
        fs::write(&newest, "latest original\n").unwrap();
        assert!(!target.exists());

        recover_stranded_sprocket_bak(&target)
            .await
            .expect("valid bak should restore");
        assert_eq!(fs::read_to_string(&target).unwrap(), "latest original\n");
        assert!(!newest.exists());
        assert_eq!(fs::read_to_string(&user_notes).unwrap(), "user notes\n");
        assert_eq!(fs::read_to_string(&stale).unwrap(), "stale original\n");
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn recovery_does_not_promote_unrelated_prefix_matches() {
        let root = temp_workspace();
        let target = root.join("file.txt");
        let decoy = root.join("file.txt.sprocket-bak.user-notes");
        fs::write(&decoy, "do not restore me\n").unwrap();
        assert!(!target.exists());

        recover_stranded_sprocket_bak(&target)
            .await
            .expect("unrelated sibling should be ignored");
        assert!(!target.exists());
        assert_eq!(fs::read_to_string(&decoy).unwrap(), "do not restore me\n");
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn applies_begin_patch_format() {
        let root = temp_workspace();
        fs::write(root.join("source.txt"), "before\n").unwrap();
        fs::write(root.join("delete.txt"), "delete me\n").unwrap();
        let patch = "*** Begin Patch\n\
            *** Add File: created.txt\n\
            +created\n\
            *** Delete File: delete.txt\n\
            *** Update File: source.txt\n\
            *** Move to: moved.txt\n\
            @@\n\
            -before\n\
            +after\n\
            *** End Patch";

        let output = apply_workspace_patch(root.clone(), WorkspaceCancellation::new(), patch)
            .await
            .expect("apply_patch format should apply");

        assert_eq!(output.changes.len(), 3);
        assert_eq!(
            fs::read_to_string(root.join("created.txt")).unwrap(),
            "created\n"
        );
        assert_eq!(
            fs::read_to_string(root.join("moved.txt")).unwrap(),
            "after\n"
        );
        assert!(!root.join("source.txt").exists());
        assert!(!root.join("delete.txt").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn copies_and_renames_with_begin_patch() {
        let root = temp_workspace();
        fs::write(root.join("src.txt"), "shared\n").unwrap();
        fs::write(root.join("old.txt"), "keep\n").unwrap();
        let patch = "*** Begin Patch\n\
            *** Copy File: src.txt\n\
            *** Copy to: dest.txt\n\
            @@\n\
            -shared\n\
            +copied\n\
            *** Update File: old.txt\n\
            *** Move to: renamed.txt\n\
            *** End Patch";

        let output = apply_workspace_patch(root.clone(), WorkspaceCancellation::new(), patch)
            .await
            .expect("copy/rename envelope should apply");

        assert_eq!(output.changes.len(), 2);
        assert_eq!(
            fs::read_to_string(root.join("src.txt")).unwrap(),
            "shared\n"
        );
        assert_eq!(
            fs::read_to_string(root.join("dest.txt")).unwrap(),
            "copied\n"
        );
        assert_eq!(
            fs::read_to_string(root.join("renamed.txt")).unwrap(),
            "keep\n"
        );
        assert!(!root.join("old.txt").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn applies_unified_diff_without_git_header() {
        let root = temp_workspace();
        fs::write(root.join("file.txt"), "before\n").unwrap();
        let patch = "--- file.txt\n\
            +++ file.txt\n\
            @@ -1 +1 @@\n\
            -before\n\
            +after\n";

        apply_workspace_patch(root.clone(), WorkspaceCancellation::new(), patch)
            .await
            .expect("unified diff should apply");

        assert_eq!(
            fs::read_to_string(root.join("file.txt")).unwrap(),
            "after\n"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn strips_ab_prefixes_from_header_only_unified_diff() {
        let root = temp_workspace();
        fs::write(root.join("file.txt"), "before\n").unwrap();
        let patch = "--- a/file.txt\n\
            +++ b/file.txt\n\
            @@ -1 +1 @@\n\
            -before\n\
            +after\n";

        apply_workspace_patch(root.clone(), WorkspaceCancellation::new(), patch)
            .await
            .expect("a/b unified diff should apply");

        assert_eq!(
            fs::read_to_string(root.join("file.txt")).unwrap(),
            "after\n"
        );
        assert!(!root.join("a").exists());
        assert!(!root.join("b").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn applies_multi_file_patch() {
        let root = temp_workspace();
        fs::write(root.join("modify.txt"), "before\n").unwrap();
        fs::write(root.join("delete.txt"), "delete me\n").unwrap();
        let patch = "diff --git a/modify.txt b/modify.txt\n\
            --- a/modify.txt\n\
            +++ b/modify.txt\n\
            @@ -1 +1 @@\n\
            -before\n\
            +after\n\
            diff --git a/create.txt b/create.txt\n\
            new file mode 100644\n\
            --- /dev/null\n\
            +++ b/create.txt\n\
            @@ -0,0 +1 @@\n\
            +created\n\
            diff --git a/delete.txt b/delete.txt\n\
            deleted file mode 100644\n\
            --- a/delete.txt\n\
            +++ /dev/null\n\
            @@ -1 +0,0 @@\n\
            -delete me\n";

        let output = apply_workspace_patch(root.clone(), WorkspaceCancellation::new(), patch)
            .await
            .expect("patch should apply");

        assert_eq!(output.changes.len(), 3);
        assert_eq!(
            fs::read_to_string(root.join("modify.txt")).unwrap(),
            "after\n"
        );
        assert_eq!(
            fs::read_to_string(root.join("create.txt")).unwrap(),
            "created\n"
        );
        assert!(!root.join("delete.txt").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn applies_hunks_while_renaming() {
        let root = temp_workspace();
        fs::write(root.join("old.txt"), "before\n").unwrap();
        let patch = "diff --git a/old.txt b/new.txt\n\
            similarity index 50%\n\
            rename from old.txt\n\
            rename to new.txt\n\
            --- a/old.txt\n\
            +++ b/new.txt\n\
            @@ -1 +1 @@\n\
            -before\n\
            +after\n";

        apply_workspace_patch(root.clone(), WorkspaceCancellation::new(), patch)
            .await
            .expect("rename patch should apply");

        assert!(!root.join("old.txt").exists());
        assert_eq!(fs::read_to_string(root.join("new.txt")).unwrap(), "after\n");
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn applies_header_only_delete() {
        let root = temp_workspace();
        fs::write(root.join("delete.txt"), "content\n").unwrap();
        let patch = "diff --git a/delete.txt b/delete.txt\n\
            deleted file mode 100644\n\
            index 1111111..0000000\n";

        apply_workspace_patch(root.clone(), WorkspaceCancellation::new(), patch)
            .await
            .expect("header-only delete should apply");

        assert!(!root.join("delete.txt").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn copies_one_source_to_multiple_files() {
        let root = temp_workspace();
        fs::write(root.join("source.txt"), "content\n").unwrap();
        let patch = "diff --git a/source.txt b/first.txt\n\
            similarity index 100%\n\
            copy from source.txt\n\
            copy to first.txt\n\
            diff --git a/source.txt b/second.txt\n\
            similarity index 100%\n\
            copy from source.txt\n\
            copy to second.txt\n";

        apply_workspace_patch(root.clone(), WorkspaceCancellation::new(), patch)
            .await
            .expect("copy patch should apply");

        assert_eq!(
            fs::read_to_string(root.join("source.txt")).unwrap(),
            "content\n"
        );
        assert_eq!(
            fs::read_to_string(root.join("first.txt")).unwrap(),
            "content\n"
        );
        assert_eq!(
            fs::read_to_string(root.join("second.txt")).unwrap(),
            "content\n"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn serializes_overlapping_patches() {
        let root = temp_workspace();
        let contents = format!("before\n{}", "padding\n".repeat(100_000));
        fs::write(root.join("file.txt"), contents).unwrap();
        let first_patch = "diff --git a/file.txt b/file.txt\n\
            --- a/file.txt\n\
            +++ b/file.txt\n\
            @@ -1 +1 @@\n\
            -before\n\
            +first\n";
        let second_patch = "diff --git a/file.txt b/file.txt\n\
            --- a/file.txt\n\
            +++ b/file.txt\n\
            @@ -1 +1 @@\n\
            -before\n\
            +second\n";

        let (first, second) = tokio::join!(
            apply_workspace_patch(root.clone(), WorkspaceCancellation::new(), first_patch),
            apply_workspace_patch(root.clone(), WorkspaceCancellation::new(), second_patch)
        );

        assert_ne!(first.is_ok(), second.is_ok());
        let final_contents = fs::read_to_string(root.join("file.txt")).unwrap();
        assert!(final_contents.starts_with("first\n") || final_contents.starts_with("second\n"));
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn rejects_dangling_symlink_destination() {
        use std::os::unix::fs::symlink;

        let root = temp_workspace();
        symlink("../outside.txt", root.join("created.txt")).unwrap();
        let patch = "diff --git a/created.txt b/created.txt\n\
            new file mode 100644\n\
            --- /dev/null\n\
            +++ b/created.txt\n\
            @@ -0,0 +1 @@\n\
            +content\n";

        let error = apply_workspace_patch(root.clone(), WorkspaceCancellation::new(), patch)
            .await
            .expect_err("dangling symlink should be rejected");

        assert!(error.to_string().contains("destination already exists"));
        assert!(!root.parent().unwrap().join("outside.txt").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn writes_through_symlink_outside_workspace() {
        use std::os::unix::fs::symlink;

        let root = temp_workspace();
        let outside = temp_workspace();
        fs::create_dir(root.join("nested")).unwrap();
        fs::rename(root.join("nested"), root.join("moved")).unwrap();
        symlink(&outside, root.join("nested")).unwrap();

        write_new_file(&root.join("nested/escaped.txt"), b"escaped\n", None)
            .await
            .expect("writes through symlink outside the workspace should succeed");

        assert_eq!(
            fs::read_to_string(outside.join("escaped.txt")).unwrap(),
            "escaped\n"
        );
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }

    #[tokio::test]
    async fn applies_patch_outside_workspace_root() {
        let root = temp_workspace();
        let outside = temp_workspace();
        fs::write(outside.join("outside.txt"), "before\n").unwrap();
        let outside_file = outside.join("outside.txt");
        let patch = format!(
            "*** Begin Patch\n\
            *** Update File: {}\n\
            @@\n\
            -before\n\
            +after\n\
            *** End Patch",
            outside_file.display()
        );

        let output = apply_workspace_patch(root.clone(), WorkspaceCancellation::new(), &patch)
            .await
            .expect("patch outside the workspace root should apply");

        assert_eq!(output.changes.len(), 1);
        assert_eq!(
            output.changes[0].path,
            outside_file.to_string_lossy().replace('\\', "/")
        );
        assert_eq!(fs::read_to_string(&outside_file).unwrap(), "after\n");
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }

    #[tokio::test]
    async fn cancelled_patch_does_not_mutate_files() {
        let root = temp_workspace();
        fs::write(root.join("file.txt"), "before\n").unwrap();
        let cancellation = WorkspaceCancellation::new();
        cancellation.cancel();
        let patch = "diff --git a/file.txt b/file.txt\n\
            --- a/file.txt\n\
            +++ b/file.txt\n\
            @@ -1 +1 @@\n\
            -before\n\
            +after\n";

        let error = apply_workspace_patch(root.clone(), cancellation, patch)
            .await
            .expect_err("cancelled patch should fail");

        assert!(error.is::<WorkspaceOperationCancelled>());
        assert_eq!(
            fs::read_to_string(root.join("file.txt")).unwrap(),
            "before\n"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn applies_all_lines_when_hunk_count_under_declared() {
        let root = temp_workspace();
        // Declares 2 added lines but body has 3. Previously truncated silently.
        let patch = "diff --git a/file.txt b/file.txt\n\
            new file mode 100644\n\
            --- /dev/null\n\
            +++ b/file.txt\n\
            @@ -0,0 +1,2 @@\n\
            +one\n\
            +two\n\
            +three\n";

        apply_workspace_patch(root.clone(), WorkspaceCancellation::new(), patch)
            .await
            .expect("under-declared hunk counts should be corrected");

        assert_eq!(
            fs::read_to_string(root.join("file.txt")).unwrap(),
            "one\ntwo\nthree\n"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn rejects_orphaned_hunk_body_after_junk() {
        let root = temp_workspace();
        let patch = "--- file.txt\n\
            +++ file.txt\n\
            @@ -1 +1 @@\n\
            -before\n\
            +after\n\
            not-a-hunk-line\n\
            +orphaned\n";
        fs::write(root.join("file.txt"), "before\n").unwrap();

        let error = apply_workspace_patch(root.clone(), WorkspaceCancellation::new(), patch)
            .await
            .expect_err("orphaned hunk lines must not be ignored");

        assert!(
            error.to_string().contains("unexpected hunk body line"),
            "unexpected error: {error:#}"
        );
        assert_eq!(
            fs::read_to_string(root.join("file.txt")).unwrap(),
            "before\n"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn rejects_create_hunk_body_without_plus_prefixes() {
        let root = temp_workspace();
        let patch = "--- /dev/null\n\
            +++ file.txt\n\
            @@ -0,0 +1 @@\n\
            hello\n";

        let error = apply_workspace_patch(root.clone(), WorkspaceCancellation::new(), patch)
            .await
            .expect_err("create body without + prefixes must fail");

        assert!(
            error.to_string().contains("unexpected hunk body line"),
            "unexpected error: {error:#}"
        );
        assert!(!root.join("file.txt").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn rejects_update_hunk_body_that_is_only_junk() {
        let root = temp_workspace();
        fs::write(root.join("file.txt"), "before\n").unwrap();
        let patch = "--- file.txt\n\
            +++ file.txt\n\
            @@ -1 +1 @@\n\
            this is junk\n";

        let error = apply_workspace_patch(root.clone(), WorkspaceCancellation::new(), patch)
            .await
            .expect_err("junk-only update body must fail");

        assert!(
            error.to_string().contains("unexpected hunk body line"),
            "unexpected error: {error:#}"
        );
        assert_eq!(
            fs::read_to_string(root.join("file.txt")).unwrap(),
            "before\n"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn applies_non_ascii_content_via_begin_patch_and_unified_diff() {
        let root = temp_workspace();
        fs::write(root.join("existing.txt"), "café\n").unwrap();

        let begin_patch = "*** Begin Patch\n\
            *** Add File: unicode.txt\n\
            +こんにちは\n\
            *** Update File: existing.txt\n\
            @@\n\
            -café\n\
            +café crème\n\
            *** End Patch";
        apply_workspace_patch(root.clone(), WorkspaceCancellation::new(), begin_patch)
            .await
            .expect("Begin Patch with non-ASCII should apply");
        assert_eq!(
            fs::read_to_string(root.join("unicode.txt")).unwrap(),
            "こんにちは\n"
        );
        assert_eq!(
            fs::read_to_string(root.join("existing.txt")).unwrap(),
            "café crème\n"
        );

        let unified = "--- existing.txt\n\
            +++ existing.txt\n\
            @@ -1 +1 @@\n\
            -café crème\n\
            +naïve résumé\n";
        apply_workspace_patch(root.clone(), WorkspaceCancellation::new(), unified)
            .await
            .expect("unified diff with non-ASCII should apply");
        assert_eq!(
            fs::read_to_string(root.join("existing.txt")).unwrap(),
            "naïve résumé\n"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn applies_begin_patch_inside_markdown_fence() {
        let root = temp_workspace();
        let patch = "```\n\
            *** Begin Patch\n\
            *** Add File: fenced.txt\n\
            +hello\n\
            *** End Patch\n\
            ```";

        apply_workspace_patch(root.clone(), WorkspaceCancellation::new(), patch)
            .await
            .expect("fenced Begin Patch should apply");

        assert_eq!(
            fs::read_to_string(root.join("fenced.txt")).unwrap(),
            "hello\n"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn preserves_trailing_whitespace_in_fenced_unified_diff() {
        let root = temp_workspace();
        // Last hunk line ends with two spaces and a tab; it must survive fence stripping.
        let patch = "```diff\n\
            --- /dev/null\n\
            +++ spaced.txt\n\
            @@ -0,0 +1 @@\n\
            +final  \t\n\
            ```";

        apply_workspace_patch(root.clone(), WorkspaceCancellation::new(), patch)
            .await
            .expect("fenced unified diff should apply");

        assert_eq!(fs::read(root.join("spaced.txt")).unwrap(), b"final  \t\n");
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn expands_home_prefix_in_patch_paths() {
        let _guard = HOME_ENV_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let root = temp_workspace();
        let home = temp_workspace();
        let previous_home = std::env::var_os("HOME");
        // SAFETY: serialized by HOME_ENV_LOCK for this test only.
        unsafe {
            std::env::set_var("HOME", &home);
        }

        let patch = "*** Begin Patch\n\
            *** Add File: ~/from-home.txt\n\
            +home-relative\n\
            *** End Patch";
        let result = apply_workspace_patch(root.clone(), WorkspaceCancellation::new(), patch).await;

        match previous_home {
            Some(value) => unsafe { std::env::set_var("HOME", value) },
            None => unsafe { std::env::remove_var("HOME") },
        }

        result.expect("~/ paths should resolve under $HOME");
        assert_eq!(
            fs::read_to_string(home.join("from-home.txt")).unwrap(),
            "home-relative\n"
        );
        assert!(!root.join("~/from-home.txt").exists());
        assert!(!root.join("from-home.txt").exists());
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn normalize_rewrites_under_and_over_declared_hunk_lengths() {
        let under = "\
--- a/file.txt
+++ b/file.txt
@@ -1,1 +1,2 @@
 keep
-old
+new
+extra
";
        let under_normalized = normalize_unified_diff_hunk_counts(under).expect("normalize");
        assert!(under_normalized.contains("@@ -1,2 +1,3 @@"));
        assert!(under_normalized.contains("+extra\n"));

        let over = "\
--- /dev/null
+++ b/file.txt
@@ -0,0 +1,5 @@
+one
+two
";
        let over_normalized = normalize_unified_diff_hunk_counts(over).expect("normalize");
        assert!(over_normalized.contains("@@ -0,0 +1,2 @@"));
    }
}
