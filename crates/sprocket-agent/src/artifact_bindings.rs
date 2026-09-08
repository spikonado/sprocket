use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, bail};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug)]
pub struct ArtifactBindings {
    directory: PathBuf,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ArtifactBinding {
    pub registration_id: String,
    pub artifact_id: Option<String>,
    pub scope: String,
    pub thread_id: Option<String>,
    pub local_path: String,
    pub content_hash: String,
}

pub struct BindingGuard {
    _lock: std::fs::File,
    directory: PathBuf,
    pub bindings: Vec<ArtifactBinding>,
}

pub fn content_hash(content: &str) -> String {
    format!("{:x}", Sha256::digest(content.as_bytes()))
}

impl ArtifactBindings {
    pub fn new(root: &Path, deployment: &str, user_id: &str, workspace: &Path) -> Self {
        let workspace = workspace
            .canonicalize()
            .unwrap_or_else(|_| workspace.to_path_buf());
        let identity = serde_json::to_vec(&(deployment.trim_end_matches('/'), user_id, workspace))
            .expect("binding identity is serializable");
        Self {
            directory: root.join(format!("{:x}", Sha256::digest(identity))),
        }
    }

    pub async fn lock(&self) -> anyhow::Result<BindingGuard> {
        tokio::fs::create_dir_all(&self.directory).await?;
        let path = self.directory.join("bindings.lock");
        let lock = tokio::task::spawn_blocking(move || {
            std::fs::OpenOptions::new()
                .create(true)
                .truncate(false)
                .read(true)
                .write(true)
                .open(path)
        })
        .await??;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        loop {
            if tokio::time::Instant::now() >= deadline {
                bail!("Artifact bindings are busy; retry the operation.");
            }
            match lock.try_lock() {
                Ok(()) => break,
                Err(std::fs::TryLockError::WouldBlock) => {
                    tokio::time::sleep(Duration::from_millis(25)).await
                }
                Err(std::fs::TryLockError::Error(error)) => return Err(error.into()),
            }
        }
        let bindings = match tokio::fs::read(self.directory.join("bindings.json")).await {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .context("Invalid artifact bindings; refusing to overwrite them")?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => return Err(error.into()),
        };
        Ok(BindingGuard {
            _lock: lock,
            directory: self.directory.clone(),
            bindings,
        })
    }
}

impl BindingGuard {
    pub async fn at_path(
        &self,
        workspace: &Path,
        path: &str,
        scope: &str,
        thread_id: Option<&str>,
    ) -> Option<ArtifactBinding> {
        let destination = path_identity(workspace, path).await;
        for binding in &self.bindings {
            if binding.scope == scope
                && binding.thread_id.as_deref() == thread_id
                && path_identity(workspace, &binding.local_path).await == destination
            {
                return Some(binding.clone());
            }
        }
        None
    }

    pub async fn validate_destination(
        &self,
        workspace: &Path,
        binding: &ArtifactBinding,
    ) -> anyhow::Result<()> {
        if let Some(existing) = self
            .at_path(
                workspace,
                &binding.local_path,
                &binding.scope,
                binding.thread_id.as_deref(),
            )
            .await
        {
            if existing.artifact_id.is_some() && existing.artifact_id != binding.artifact_id {
                bail!("This path is already bound to another artifact in the same scope.");
            }
        }
        Ok(())
    }

    pub fn get(&self, artifact_id: &str) -> Option<&ArtifactBinding> {
        self.bindings
            .iter()
            .find(|binding| binding.artifact_id.as_deref() == Some(artifact_id))
    }

    pub fn reserve(
        &mut self,
        path: String,
        scope: &str,
        thread_id: Option<&str>,
    ) -> &mut ArtifactBinding {
        let index = self
            .bindings
            .iter()
            .position(|binding| {
                binding.local_path == path
                    && binding.scope == scope
                    && binding.thread_id.as_deref() == thread_id
            })
            .unwrap_or_else(|| {
                self.bindings.push(ArtifactBinding {
                    registration_id: uuid::Uuid::new_v4().to_string(),
                    artifact_id: None,
                    scope: scope.into(),
                    thread_id: thread_id.map(str::to_string),
                    local_path: path,
                    content_hash: String::new(),
                });
                self.bindings.len() - 1
            });
        &mut self.bindings[index]
    }

    pub fn bind(&mut self, binding: ArtifactBinding) -> anyhow::Result<()> {
        if self.bindings.iter().any(|existing| {
            existing.local_path == binding.local_path
                && existing.scope == binding.scope
                && existing.thread_id == binding.thread_id
                && existing.artifact_id.is_some()
                && existing.artifact_id != binding.artifact_id
        }) {
            bail!("This path is already bound to another artifact in the same scope.");
        }
        self.bindings.retain(|existing| {
            existing.artifact_id != binding.artifact_id
                && existing.registration_id != binding.registration_id
        });
        self.bindings.push(binding);
        Ok(())
    }

    pub async fn persist(&self) -> anyhow::Result<()> {
        let bytes = serde_json::to_vec(&self.bindings)?;
        let directory = self.directory.clone();
        // A cancelled caller must not release the lock while publication still runs.
        let lock = self._lock.try_clone()?;
        tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
            use std::io::Write;
            let _lock = lock;
            let mut temporary = tempfile::NamedTempFile::new_in(&directory)?;
            temporary.write_all(&bytes)?;
            temporary.as_file().sync_all()?;
            temporary.persist(directory.join("bindings.json"))?;
            #[cfg(unix)]
            {
                std::fs::File::open(&directory)?.sync_all()?;
                if let Some(parent) = directory.parent() {
                    std::fs::File::open(parent)?.sync_all()?;
                }
            }
            Ok(())
        })
        .await?
    }
}

async fn path_identity(workspace: &Path, path: &str) -> PathBuf {
    let destination = workspace.join(path);
    if let Ok(canonical) = tokio::fs::canonicalize(&destination).await {
        return canonical;
    }
    if let (Some(parent), Some(name)) = (destination.parent(), destination.file_name()) {
        if let Ok(parent) = tokio::fs::canonicalize(parent).await {
            return parent.join(name);
        }
    }
    destination.components().collect()
}

pub fn normalize_destination(path: &str) -> anyhow::Result<String> {
    if path.is_empty() || path.len() > 4096 || path.contains('\0') {
        bail!("Invalid artifact destination path.");
    }
    let path = Path::new(path);
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .context("Destination must name a UTF-8 file.")?;
    if name.chars().count() > 200 {
        bail!("Artifact filename must not exceed 200 characters.");
    }
    let normalized: PathBuf = path
        .components()
        .filter(|component| !matches!(component, std::path::Component::CurDir))
        .collect();
    Ok(normalized
        .to_str()
        .context("Destination must be UTF-8.")?
        .into())
}

pub async fn save_new_file(workspace: &Path, path: &str, content: &str) -> anyhow::Result<String> {
    let normalized = normalize_destination(path)?;
    let path = normalized.as_str();
    if content.len() > sprocket_workspace::MAX_ARTIFACT_BYTES {
        bail!("Artifact content is too large.");
    }
    let destination = workspace.join(path);
    if let Some(parent) = destination.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let content_bytes = content.as_bytes().to_vec();
    let publication = tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        use std::io::Write;
        let mut temporary = tempfile::NamedTempFile::new_in(destination.parent().unwrap())?;
        temporary.write_all(&content_bytes)?;
        temporary.as_file().sync_all()?;
        temporary
            .persist_noclobber(destination)
            .map_err(|error| error.error)?;
        Ok(())
    })
    .await?;
    match publication {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let existing = sprocket_workspace::read_artifact_file(workspace, path).await?;
            if existing.content != content {
                bail!("Destination already exists with different contents; choose another path.");
            }
        }
        Err(error) => return Err(error.into()),
    }
    Ok(sprocket_workspace::read_artifact_file(workspace, path)
        .await?
        .local_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn bindings_survive_restart_and_are_isolated_and_locked() {
        let dir = tempfile::tempdir().unwrap();
        let store = ArtifactBindings::new(dir.path(), "deployment", "alice", Path::new("/ws"));
        let mut guard = store.lock().await.unwrap();
        let entry = guard.reserve("notes.md".into(), "project", None);
        entry.artifact_id = Some("artifact".into());
        entry.content_hash = content_hash("hello");
        guard.persist().await.unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(50), store.lock())
                .await
                .is_err()
        );
        drop(guard);
        let reopened = ArtifactBindings::new(dir.path(), "deployment", "alice", Path::new("/ws"));
        assert_eq!(
            reopened
                .lock()
                .await
                .unwrap()
                .get("artifact")
                .unwrap()
                .local_path,
            "notes.md"
        );
        for (deployment, user, workspace) in [
            ("other", "alice", "/ws"),
            ("deployment", "bob", "/ws"),
            ("deployment", "alice", "/other"),
        ] {
            assert!(
                ArtifactBindings::new(dir.path(), deployment, user, Path::new(workspace))
                    .lock()
                    .await
                    .unwrap()
                    .bindings
                    .is_empty()
            );
        }
    }

    #[tokio::test]
    async fn saves_relative_and_absolute_paths_without_overwriting() {
        let dir = tempfile::tempdir().unwrap();
        save_new_file(dir.path(), "nested/doc.md", "hello")
            .await
            .unwrap();
        save_new_file(dir.path(), "nested/doc.md", "hello")
            .await
            .unwrap();
        assert!(
            save_new_file(dir.path(), "nested/doc.md", "changed")
                .await
                .is_err()
        );
        let path = dir.path().join("absolute.md");
        save_new_file(Path::new("/unused"), path.to_str().unwrap(), "absolute")
            .await
            .unwrap();
        assert_eq!(
            tokio::fs::read_to_string(dir.path().join("nested/doc.md"))
                .await
                .unwrap(),
            "hello"
        );
    }

    #[tokio::test]
    async fn equivalent_paths_cannot_bind_different_artifacts() {
        let dir = tempfile::tempdir().unwrap();
        let store =
            ArtifactBindings::new(&dir.path().join("data"), "deployment", "alice", dir.path());
        save_new_file(dir.path(), "doc.md", "hello").await.unwrap();
        let mut guard = store.lock().await.unwrap();
        let mut binding = guard.reserve("doc.md".into(), "project", None).clone();
        binding.artifact_id = Some("first".into());
        guard.bind(binding.clone()).unwrap();
        binding.artifact_id = Some("second".into());
        for path in [
            "./doc.md".to_string(),
            dir.path().join("doc.md").to_str().unwrap().to_string(),
        ] {
            binding.local_path = path;
            assert!(
                guard
                    .validate_destination(dir.path(), &binding)
                    .await
                    .is_err()
            );
        }
    }
}
