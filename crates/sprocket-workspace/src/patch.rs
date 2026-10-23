use std::collections::{BTreeMap, BTreeSet};
use std::fs::Permissions;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail};
use serde::Serialize;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex as AsyncMutex;

use crate::apply_patch_format::{PatchSection, UpdateChunk, apply_update, parse_apply_patch};
use crate::commands::WorkspaceCancellation;
use crate::paths::{canonicalize_with_missing_tail, expand_home, normalize_path, simplified_path};

/// Patches may target any absolute path and runs may start from different
/// directories, so one process-wide lock is the only key every overlapping
/// write shares. Editor saves take it too so their version check and replace
/// stay atomic with respect to patches and each other.
pub(crate) static PATCH_LOCK: AsyncMutex<()> = AsyncMutex::const_new(());

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

#[derive(Clone)]
struct FileContents {
    bytes: Vec<u8>,
    /// `None` for files the patch creates, so they get the OS default mode.
    permissions: Option<Permissions>,
}

#[derive(Clone)]
enum FileState {
    Missing,
    File(FileContents),
    NotAFile,
}

struct TrackedFile {
    original: FileState,
    /// `None` until a section changes the file.
    updated: Option<FileState>,
}

impl TrackedFile {
    fn current(&self) -> &FileState {
        self.updated.as_ref().unwrap_or(&self.original)
    }
}

/// Sections apply in order against this in-memory view, so later sections see
/// earlier ones; nothing touches disk until every section has applied.
struct PatchFiles<'a> {
    cwd: &'a Path,
    files: BTreeMap<PathBuf, TrackedFile>,
}

pub async fn apply_workspace_patch(
    cwd: PathBuf,
    cancellation: WorkspaceCancellation,
    patch: &str,
) -> Result<ApplyPatchOutput> {
    cancellation.ensure_active()?;
    let sections = parse_apply_patch(patch).context("invalid patch")?;

    let cwd = tokio::fs::canonicalize(&cwd)
        .await
        .with_context(|| format!("failed to resolve working directory {}", cwd.display()))?;
    let _patch_guard = tokio::select! {
        guard = PATCH_LOCK.lock() => guard,
        _ = cancellation.cancelled() => return Err(crate::commands::WorkspaceOperationCancelled.into()),
    };
    cancellation.ensure_active()?;

    let mut files = PatchFiles {
        cwd: &cwd,
        files: BTreeMap::new(),
    };
    let mut changes = Vec::with_capacity(sections.len());
    for section in sections {
        changes.push(files.apply(section).await?);
    }
    let files = files.files;

    let missing_directories = missing_parent_directories(&files).await?;
    if let Err(error) = commit(&cancellation, &files).await {
        if let Err(rollback_error) = restore(&files, &missing_directories).await {
            return Err(error).context(format!(
                "patch failed and rollback also failed: {rollback_error:#}"
            ));
        }
        return Err(error);
    }

    Ok(ApplyPatchOutput { changes })
}

impl PatchFiles<'_> {
    async fn apply(&mut self, section: PatchSection) -> Result<PatchChangeOutput> {
        Ok(match section {
            PatchSection::Add { path, contents } => {
                let path = self.resolve(&path)?;
                self.ensure_vacant(&path).await?;
                self.set(
                    &path,
                    FileState::File(FileContents {
                        bytes: contents,
                        permissions: None,
                    }),
                );
                change(&path, PatchOperation::Created, None)
            }
            PatchSection::Delete { path } => {
                let (path, _) = self.existing_file(&path).await?;
                self.set(&path, FileState::Missing);
                change(&path, PatchOperation::Deleted, None)
            }
            PatchSection::Update {
                path,
                move_to,
                chunks,
            } => {
                let (source, file) = self.existing_file(&path).await?;
                let file = updated(&source, file, &chunks)?;
                let destination = move_to
                    .map(|destination| self.resolve(&destination))
                    .transpose()?
                    .filter(|destination| *destination != source);
                match destination {
                    Some(destination) => {
                        self.ensure_vacant(&destination).await?;
                        self.set(&source, FileState::Missing);
                        self.set(&destination, FileState::File(file));
                        change(
                            &destination,
                            PatchOperation::Renamed,
                            Some(source.as_path()),
                        )
                    }
                    None => {
                        self.set(&source, FileState::File(file));
                        change(&source, PatchOperation::Updated, None)
                    }
                }
            }
            PatchSection::Copy {
                path,
                copy_to,
                chunks,
            } => {
                let (source, file) = self.existing_file(&path).await?;
                let file = updated(&source, file, &chunks)?;
                let destination = self.resolve(&copy_to)?;
                self.ensure_vacant(&destination).await?;
                self.set(&destination, FileState::File(file));
                change(&destination, PatchOperation::Copied, Some(source.as_path()))
            }
        })
    }

    /// Join relative paths against the cwd, normalize `.`/`..`, and
    /// canonicalize the deepest existing ancestor. Does not confine results
    /// to the cwd.
    fn resolve(&self, path: &str) -> Result<PathBuf> {
        let candidate = self.cwd.join(expand_home(path));
        canonicalize_with_missing_tail(&normalize_path(&candidate)?)
    }

    async fn tracked(&mut self, path: &Path) -> Result<&TrackedFile> {
        if !self.files.contains_key(path) {
            let original = load(path).await?;
            self.files.insert(
                path.to_owned(),
                TrackedFile {
                    original,
                    updated: None,
                },
            );
        }
        Ok(&self.files[path])
    }

    async fn existing_file(&mut self, path: &str) -> Result<(PathBuf, &FileContents)> {
        let path = self.resolve(path)?;
        let cwd = self.cwd;
        match self.tracked(&path).await?.current() {
            FileState::File(contents) => Ok((path, contents)),
            FileState::Missing => Err(path_error("path does not exist", &path, cwd)),
            FileState::NotAFile => bail!("patch path is not a file: {}", display_path(&path)),
        }
    }

    async fn ensure_vacant(&mut self, path: &Path) -> Result<()> {
        let vacant = matches!(self.tracked(path).await?.current(), FileState::Missing);
        if vacant {
            Ok(())
        } else {
            Err(path_error(
                "patch destination already exists",
                path,
                self.cwd,
            ))
        }
    }

    fn set(&mut self, path: &Path, state: FileState) {
        self.files
            .get_mut(path)
            .expect("paths are tracked before they are set")
            .updated = Some(state);
    }
}

fn path_error(message: &str, path: &Path, cwd: &Path) -> anyhow::Error {
    anyhow!(
        "{message}: {} (relative paths resolve from {})",
        display_path(path),
        display_path(cwd)
    )
}

fn updated(path: &Path, file: &FileContents, chunks: &[UpdateChunk]) -> Result<FileContents> {
    if chunks.is_empty() {
        return Ok(file.clone());
    }
    Ok(FileContents {
        bytes: apply_update(path, &file.bytes, chunks)?,
        permissions: file.permissions.clone(),
    })
}

fn change(path: &Path, operation: PatchOperation, source: Option<&Path>) -> PatchChangeOutput {
    PatchChangeOutput {
        path: display_path(path),
        operation,
        source: source.map(display_path),
    }
}

fn display_path(path: &Path) -> String {
    simplified_path(path).to_string_lossy().replace('\\', "/")
}

async fn load(path: &Path) -> Result<FileState> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(FileState::Missing);
        }
        Err(error) => {
            return Err(error).with_context(|| format!("failed to inspect {}", path.display()));
        }
    }
    match tokio::fs::metadata(path).await {
        Ok(metadata) if metadata.is_file() => Ok(FileState::File(FileContents {
            bytes: tokio::fs::read(path)
                .await
                .with_context(|| format!("failed to read {}", path.display()))?,
            permissions: Some(metadata.permissions()),
        })),
        // Directories and dangling symlinks.
        Ok(_) => Ok(FileState::NotAFile),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(FileState::NotAFile),
        Err(error) => Err(error).with_context(|| format!("failed to inspect {}", path.display())),
    }
}

async fn missing_parent_directories(
    files: &BTreeMap<PathBuf, TrackedFile>,
) -> Result<Vec<PathBuf>> {
    let mut directories = BTreeSet::new();
    for (path, file) in files {
        if !matches!(file.updated, Some(FileState::File(_))) {
            continue;
        }
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

async fn commit(
    cancellation: &WorkspaceCancellation,
    files: &BTreeMap<PathBuf, TrackedFile>,
) -> Result<()> {
    // Removals first so a later section can create a file where a removed one was.
    for (path, file) in files {
        if let (FileState::File(_), Some(FileState::Missing)) = (&file.original, &file.updated) {
            cancellation.ensure_active()?;
            tokio::fs::remove_file(path)
                .await
                .with_context(|| format!("failed to remove {}", path.display()))?;
        }
    }
    for (path, file) in files {
        let Some(FileState::File(contents)) = &file.updated else {
            continue;
        };
        cancellation.ensure_active()?;
        match &file.original {
            FileState::File(original) => {
                let permissions = contents
                    .permissions
                    .clone()
                    .or_else(|| original.permissions.clone());
                replace_file(path, &contents.bytes, permissions).await?;
            }
            FileState::Missing | FileState::NotAFile => {
                write_new_file(path, &contents.bytes, contents.permissions.clone()).await?;
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

async fn replace_file(
    path: &Path,
    contents: &[u8],
    permissions: Option<Permissions>,
) -> Result<()> {
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
    write_new_file(&staged_path, contents, permissions)
        .await
        .with_context(|| format!("failed to stage replacement for {}", path.display()))?;
    tokio::fs::rename(&staged_path, path)
        .await
        .with_context(|| format!("failed to replace {}", path.display()))
}

async fn restore(
    files: &BTreeMap<PathBuf, TrackedFile>,
    missing_directories: &[PathBuf],
) -> Result<()> {
    let mut errors = Vec::new();
    for (path, file) in files {
        if file.updated.is_none() {
            continue;
        }
        let result = match &file.original {
            FileState::File(original) => {
                replace_file(path, &original.bytes, original.permissions.clone()).await
            }
            FileState::Missing => match tokio::fs::remove_file(path).await {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(error) => Err(error.into()),
            },
            FileState::NotAFile => Ok(()),
        };
        if let Err(error) = result {
            errors.push(format!("{}: {error:#}", path.display()));
        }
    }

    for directory in missing_directories {
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

#[cfg(test)]
mod tests;
