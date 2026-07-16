use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex, OnceLock, Weak};

use anyhow::{Context, Result, anyhow, bail};
use cap_std::ambient_authority;
use cap_std::fs::{Dir, Metadata, OpenOptions, Permissions};
use diffy::patch_set::{FileOperation, ParseOptions, PatchKind, PatchSet};
use serde::Serialize;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex as AsyncMutex;

use crate::tools::WorkspaceCancellation;
use crate::workspace::{relative_to_root, resolve_workspace_path};

type WorkspacePatchLock = AsyncMutex<()>;

static WORKSPACE_PATCH_LOCKS: OnceLock<StdMutex<HashMap<PathBuf, Weak<WorkspacePatchLock>>>> =
    OnceLock::new();

#[derive(Clone)]
struct PatchFilesystem {
    root: PathBuf,
    dir: Arc<Dir>,
}

impl PatchFilesystem {
    fn open(root: PathBuf) -> Result<Self> {
        let dir = Dir::open_ambient_dir(&root, ambient_authority())
            .with_context(|| format!("failed to open workspace {}", root.display()))?;
        Ok(Self {
            root,
            dir: Arc::new(dir),
        })
    }

    fn relative_path(&self, path: &Path) -> Result<PathBuf> {
        path.strip_prefix(&self.root)
            .map(Path::to_owned)
            .with_context(|| format!("path escapes the workspace: {}", path.display()))
    }

    async fn run<T, F>(&self, operation: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&Dir) -> std::io::Result<T> + Send + 'static,
    {
        let dir = self.dir.clone();
        tokio::task::spawn_blocking(move || operation(&dir))
            .await
            .context("workspace filesystem task failed")?
            .map_err(Into::into)
    }

    async fn read(&self, path: &Path) -> Result<Vec<u8>> {
        let path = self.relative_path(path)?;
        self.run(move |dir| dir.read(path)).await
    }

    async fn metadata(&self, path: &Path) -> Result<Metadata> {
        let path = self.relative_path(path)?;
        self.run(move |dir| dir.metadata(path)).await
    }

    async fn symlink_metadata(&self, path: &Path) -> Result<Metadata> {
        let path = self.relative_path(path)?;
        self.run(move |dir| dir.symlink_metadata(path)).await
    }

    async fn try_exists(&self, path: &Path) -> Result<bool> {
        let path = self.relative_path(path)?;
        self.run(move |dir| dir.try_exists(path)).await
    }

    async fn create_file(
        &self,
        path: &Path,
        permissions: Option<Permissions>,
    ) -> Result<cap_std::fs::File> {
        let path = self.relative_path(path)?;
        self.run(move |dir| {
            if let Some(parent) = path.parent() {
                dir.create_dir_all(parent)?;
            }
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            let file = dir.open_with(&path, &options)?;
            if let Some(permissions) = permissions {
                file.set_permissions(permissions)?;
            }
            Ok(file)
        })
        .await
    }

    async fn remove_file(&self, path: &Path) -> Result<()> {
        let path = self.relative_path(path)?;
        self.run(move |dir| dir.remove_file(path)).await
    }

    async fn remove_dir(&self, path: &Path) -> Result<()> {
        let path = self.relative_path(path)?;
        self.run(move |dir| dir.remove_dir(path)).await
    }
}

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
    let filesystem = PatchFilesystem::open(workspace_root.clone())?;
    let patch_lock = workspace_patch_lock(&workspace_root);
    let patch_guard = tokio::select! {
        guard = patch_lock.lock() => guard,
        _ = cancellation.cancelled() => return Err(crate::tools::WorkspaceOperationCancelled.into()),
    };
    let result = async {
        cancellation.ensure_active()?;
        let changes = prepare_changes(&filesystem, &workspace_root, patch).await?;
        if changes.is_empty() {
            bail!("patch does not contain any file changes");
        }

        let snapshots = snapshot_paths(&filesystem, &changes).await?;
        let output = change_outputs(&workspace_root, &changes);

        if let Err(error) = apply_changes(&filesystem, &cancellation, &changes).await {
            if let Err(rollback_error) = restore_snapshot(&filesystem, &snapshots).await {
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

async fn prepare_changes(
    filesystem: &PatchFilesystem,
    root: &Path,
    patch: &str,
) -> Result<Vec<PreparedChange>> {
    let mut changes = Vec::new();
    let mut touched_paths = BTreeSet::new();

    for parsed in PatchSet::parse(patch, ParseOptions::gitdiff()) {
        let parsed = parsed.context("failed to parse git-style unified diff")?;
        let operation = parsed.operation();
        let strip = match operation {
            FileOperation::Rename { .. } | FileOperation::Copy { .. } => 0,
            _ => 1,
        };

        match operation.strip_prefix(strip) {
            FileOperation::Create(path) => {
                let path = resolve_workspace_path(root, &path, true)?;
                ensure_missing(filesystem, &path).await?;
                reserve_path(&mut touched_paths, &path)?;
                let contents = apply_text_patch(&path, &[], parsed.patch())?;
                changes.push(PreparedChange::Create { path, contents });
            }
            FileOperation::Delete(path) => {
                let path = resolve_existing_file(filesystem, root, &path).await?;
                reserve_path(&mut touched_paths, &path)?;
                let header_only = parsed
                    .patch()
                    .as_text()
                    .is_some_and(|patch| patch.hunks().is_empty());
                if !header_only {
                    let remaining = apply_text_patch(
                        &path,
                        &read_file(filesystem, &path).await?,
                        parsed.patch(),
                    )?;
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
                let source = resolve_existing_file(filesystem, root, &original).await?;
                let destination = resolve_workspace_path(root, &modified, true)?;
                reserve_path(&mut touched_paths, &source)?;
                if source != destination {
                    ensure_missing(filesystem, &destination).await?;
                    reserve_path(&mut touched_paths, &destination)?;
                }
                let contents = apply_text_patch(
                    &source,
                    &read_file(filesystem, &source).await?,
                    parsed.patch(),
                )?;
                let permissions = file_permissions(filesystem, &source).await?;
                changes.push(PreparedChange::Modify {
                    source,
                    destination,
                    contents,
                    permissions,
                });
            }
            FileOperation::Rename { from, to } => {
                let source = resolve_existing_file(filesystem, root, &from).await?;
                let destination = resolve_workspace_path(root, &to, true)?;
                ensure_missing(filesystem, &destination).await?;
                reserve_path(&mut touched_paths, &source)?;
                reserve_path(&mut touched_paths, &destination)?;
                let contents = apply_text_patch(
                    &source,
                    &read_file(filesystem, &source).await?,
                    parsed.patch(),
                )?;
                let permissions = file_permissions(filesystem, &source).await?;
                changes.push(PreparedChange::Rename {
                    source,
                    destination,
                    contents,
                    permissions,
                });
            }
            FileOperation::Copy { from, to } => {
                let source = resolve_existing_file(filesystem, root, &from).await?;
                let destination = resolve_workspace_path(root, &to, true)?;
                ensure_missing(filesystem, &destination).await?;
                reserve_path(&mut touched_paths, &destination)?;
                let contents = apply_text_patch(
                    &source,
                    &read_file(filesystem, &source).await?,
                    parsed.patch(),
                )?;
                let permissions = file_permissions(filesystem, &source).await?;
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

async fn read_file(filesystem: &PatchFilesystem, path: &Path) -> Result<Vec<u8>> {
    filesystem
        .read(path)
        .await
        .with_context(|| format!("failed to read {}", path.display()))
}

async fn resolve_existing_file(
    filesystem: &PatchFilesystem,
    root: &Path,
    path: &str,
) -> Result<PathBuf> {
    let path = resolve_workspace_path(root, path, false)?;
    if !filesystem
        .metadata(&path)
        .await
        .with_context(|| format!("failed to inspect {}", path.display()))?
        .is_file()
    {
        bail!("patch path is not a file: {}", path.display());
    }
    Ok(path)
}

async fn ensure_missing(filesystem: &PatchFilesystem, path: &Path) -> Result<()> {
    match filesystem.symlink_metadata(path).await {
        Ok(_) => bail!("patch destination already exists: {}", path.display()),
        Err(error)
            if error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
        {
            Ok(())
        }
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

async fn snapshot_paths(
    filesystem: &PatchFilesystem,
    changes: &[PreparedChange],
) -> Result<PatchSnapshot> {
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

    let missing_directories = missing_parent_directories(filesystem, &paths).await?;
    let mut files = BTreeMap::new();
    for path in paths {
        let snapshot = match filesystem.metadata(&path).await {
            Ok(metadata) => Some(FileSnapshot {
                contents: filesystem
                    .read(&path)
                    .await
                    .with_context(|| format!("failed to read {}", path.display()))?,
                permissions: metadata.permissions(),
            }),
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
            {
                None
            }
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

async fn missing_parent_directories(
    filesystem: &PatchFilesystem,
    paths: &BTreeSet<PathBuf>,
) -> Result<Vec<PathBuf>> {
    let mut directories = BTreeSet::new();
    for path in paths {
        let mut parent = path.parent();
        while let Some(directory) = parent {
            if directory == filesystem.root || filesystem.try_exists(directory).await? {
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
    filesystem: &PatchFilesystem,
    cancellation: &WorkspaceCancellation,
    changes: &[PreparedChange],
) -> Result<()> {
    for change in changes {
        cancellation.ensure_active()?;
        match change {
            PreparedChange::Create { path, contents } => {
                write_new_file(filesystem, path, contents, None).await?
            }
            PreparedChange::Delete { path } => {
                remove_file(filesystem, path, "deleted file").await?
            }
            PreparedChange::Modify {
                source,
                destination,
                contents,
                permissions,
            } => {
                if source == destination {
                    replace_file(filesystem, destination, contents, permissions.clone()).await?;
                } else {
                    write_new_file(filesystem, destination, contents, Some(permissions.clone()))
                        .await?;
                    remove_file(filesystem, source, "modified source").await?;
                }
            }
            PreparedChange::Rename {
                source,
                destination,
                contents,
                permissions,
            } => {
                write_new_file(filesystem, destination, contents, Some(permissions.clone()))
                    .await?;
                remove_file(filesystem, source, "renamed source").await?;
            }
            PreparedChange::Copy {
                destination,
                contents,
                permissions,
                ..
            } => {
                write_new_file(filesystem, destination, contents, Some(permissions.clone()))
                    .await?;
            }
        }
    }
    cancellation.ensure_active()
}

async fn write_new_file(
    filesystem: &PatchFilesystem,
    path: &Path,
    contents: &[u8],
    permissions: Option<Permissions>,
) -> Result<()> {
    let file = filesystem
        .create_file(path, permissions)
        .await
        .with_context(|| format!("failed to create {}", path.display()))?;
    let mut file = tokio::fs::File::from_std(file.into_std());
    file.write_all(contents)
        .await
        .with_context(|| format!("failed to write {}", path.display()))?;
    file.flush()
        .await
        .with_context(|| format!("failed to flush {}", path.display()))
}

async fn replace_file(
    filesystem: &PatchFilesystem,
    path: &Path,
    contents: &[u8],
    permissions: Permissions,
) -> Result<()> {
    filesystem
        .remove_file(path)
        .await
        .with_context(|| format!("failed to replace {}", path.display()))?;
    write_new_file(filesystem, path, contents, Some(permissions)).await
}

async fn file_permissions(filesystem: &PatchFilesystem, path: &Path) -> Result<Permissions> {
    filesystem
        .metadata(path)
        .await
        .map(|metadata| metadata.permissions())
        .with_context(|| format!("failed to inspect {}", path.display()))
}

async fn remove_file(filesystem: &PatchFilesystem, path: &Path, description: &str) -> Result<()> {
    filesystem
        .remove_file(path)
        .await
        .with_context(|| format!("failed to remove {description} {}", path.display()))
}

async fn restore_snapshot(filesystem: &PatchFilesystem, snapshot: &PatchSnapshot) -> Result<()> {
    let mut errors = Vec::new();
    for (path, file_snapshot) in &snapshot.files {
        let result = match file_snapshot {
            Some(snapshot) => {
                async {
                    match filesystem.remove_file(path).await {
                        Ok(()) => {}
                        Err(error)
                            if error.downcast_ref::<std::io::Error>().is_some_and(|error| {
                                error.kind() == std::io::ErrorKind::NotFound
                            }) => {}
                        Err(error) => return Err(error),
                    }
                    write_new_file(
                        filesystem,
                        path,
                        &snapshot.contents,
                        Some(snapshot.permissions.clone()),
                    )
                    .await
                }
                .await
            }
            None => match filesystem.remove_file(path).await {
                Ok(()) => Ok(()),
                Err(error)
                    if error
                        .downcast_ref::<std::io::Error>()
                        .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
                {
                    Ok(())
                }
                Err(error) => Err(error),
            },
        };
        if let Err(error) = result {
            errors.push(format!("{}: {error:#}", path.display()));
        }
    }

    for directory in &snapshot.missing_directories {
        match filesystem.remove_dir(directory).await {
            Ok(()) => {}
            Err(error)
                if error.downcast_ref::<std::io::Error>().is_some_and(|error| {
                    matches!(
                        error.kind(),
                        std::io::ErrorKind::NotFound | std::io::ErrorKind::DirectoryNotEmpty
                    )
                }) => {}
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
                path: relative_to_root(root, path),
                operation,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::{PatchFilesystem, apply_workspace_patch, write_new_file};
    use crate::test_support::temp_workspace;
    use crate::tools::{WorkspaceCancellation, WorkspaceOperationCancelled};

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
    async fn rejects_parent_replaced_with_escaping_symlink() {
        use std::os::unix::fs::symlink;

        let root = temp_workspace();
        let outside = temp_workspace();
        fs::create_dir(root.join("nested")).unwrap();
        let filesystem = PatchFilesystem::open(root.clone()).unwrap();
        fs::rename(root.join("nested"), root.join("moved")).unwrap();
        symlink(&outside, root.join("nested")).unwrap();

        write_new_file(
            &filesystem,
            &root.join("nested/escaped.txt"),
            b"escaped\n",
            None,
        )
        .await
        .expect_err("capability path must reject the escaping symlink");

        assert!(!outside.join("escaped.txt").exists());
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }

    #[tokio::test]
    async fn rejects_escaping_path_before_mutating_files() {
        let root = temp_workspace();
        fs::write(root.join("safe.txt"), "before\n").unwrap();
        let patch = "diff --git a/safe.txt b/safe.txt\n\
            --- a/safe.txt\n\
            +++ b/safe.txt\n\
            @@ -1 +1 @@\n\
            -before\n\
            +after\n\
            diff --git a/../escape.txt b/../escape.txt\n\
            new file mode 100644\n\
            --- /dev/null\n\
            +++ b/../escape.txt\n\
            @@ -0,0 +1 @@\n\
            +escaped\n";

        let error = apply_workspace_patch(root.clone(), WorkspaceCancellation::new(), patch)
            .await
            .expect_err("escaping patch should fail");

        assert!(error.to_string().contains("escapes the workspace"));
        assert_eq!(
            fs::read_to_string(root.join("safe.txt")).unwrap(),
            "before\n"
        );
        assert!(!root.parent().unwrap().join("escape.txt").exists());
        fs::remove_dir_all(root).unwrap();
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
}
