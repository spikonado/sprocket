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
    pub local_path: String,
    pub content_hash: String,
}

pub struct BindingGuard {
    _lock: std::fs::File,
    directory: PathBuf,
    pub bindings: Vec<ArtifactBinding>,
}

pub fn content_hash(content: &str) -> String {
    hex::encode(Sha256::digest(content.as_bytes()))
}

/// Legacy thread bindings can converge on one project path. Preserve every
/// binding, but pause synchronization until the user chooses distinct paths.
pub async fn conflicting_binding_ids(
    workspace: &Path,
    bindings: &[ArtifactBinding],
) -> std::collections::HashSet<String> {
    let mut paths: std::collections::HashMap<PathBuf, Vec<&ArtifactBinding>> =
        std::collections::HashMap::new();
    for binding in bindings {
        paths
            .entry(path_identity(workspace, &binding.local_path).await)
            .or_default()
            .push(binding);
    }
    paths
        .into_values()
        .filter(|bindings| bindings.len() > 1)
        .flatten()
        .map(|binding| binding.registration_id.clone())
        .collect()
}

impl ArtifactBindings {
    pub fn new(root: &Path, deployment: &str, user_id: &str, workspace: &Path) -> Self {
        let workspace = workspace
            .canonicalize()
            .unwrap_or_else(|_| workspace.to_path_buf());
        let identity = serde_json::to_vec(&(deployment.trim_end_matches('/'), user_id, workspace))
            .expect("binding identity is serializable");
        Self {
            directory: root.join(hex::encode(Sha256::digest(identity))),
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
        let (bindings, legacy_fields) = self.load().await?;
        let guard = BindingGuard {
            _lock: lock,
            directory: self.directory.clone(),
            bindings,
        };
        if legacy_fields {
            guard.persist().await?;
        }
        Ok(guard)
    }

    pub async fn snapshot(&self) -> anyhow::Result<Vec<ArtifactBinding>> {
        Ok(self.load().await?.0)
    }

    async fn load(&self) -> anyhow::Result<(Vec<ArtifactBinding>, bool)> {
        match tokio::fs::read(self.directory.join("bindings.json")).await {
            Ok(bytes) => {
                let rows: Vec<serde_json::Value> = serde_json::from_slice(&bytes)
                    .context("Invalid artifact bindings; refusing to overwrite them")?;
                let legacy_fields = rows
                    .iter()
                    .any(|row| row.get("scope").is_some() || row.get("thread_id").is_some());
                let bindings = serde_json::from_value(serde_json::Value::Array(rows))
                    .context("Invalid artifact bindings; refusing to overwrite them")?;
                Ok((bindings, legacy_fields))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok((Vec::new(), false)),
            Err(error) => Err(error.into()),
        }
    }
}

impl BindingGuard {
    pub async fn at_path(
        &self,
        workspace: &Path,
        path: &str,
    ) -> anyhow::Result<Option<ArtifactBinding>> {
        let destination = path_identity(workspace, path).await;
        let mut existing = None;
        for binding in &self.bindings {
            if path_identity(workspace, &binding.local_path).await == destination {
                if existing.is_some() {
                    bail!(
                        "Multiple artifacts are bound to this path; save or rebind them to distinct paths."
                    );
                }
                existing = Some(binding.clone());
            }
        }
        Ok(existing)
    }

    pub async fn validate_destination(
        &self,
        workspace: &Path,
        binding: &ArtifactBinding,
    ) -> anyhow::Result<()> {
        let destination = path_identity(workspace, &binding.local_path).await;
        for existing in &self.bindings {
            let conflicts = match (&existing.artifact_id, &binding.artifact_id) {
                (Some(existing), Some(next)) => existing != next,
                (Some(_), None) => true,
                (None, _) => existing.registration_id != binding.registration_id,
            };
            if conflicts && path_identity(workspace, &existing.local_path).await == destination {
                bail!("This path is already bound to another artifact; choose a distinct path.");
            }
        }
        Ok(())
    }

    pub fn get(&self, artifact_id: &str) -> Option<&ArtifactBinding> {
        self.bindings
            .iter()
            .find(|binding| binding.artifact_id.as_deref() == Some(artifact_id))
    }

    pub async fn delete_artifact(
        &mut self,
        workspace: &Path,
        artifact_id: &str,
    ) -> anyhow::Result<()> {
        let mut paths = Vec::new();
        for binding in &self.bindings {
            if binding.artifact_id.as_deref() == Some(artifact_id) {
                self.validate_destination(workspace, binding).await?;
                paths.push(workspace.join(&binding.local_path));
            }
        }
        if paths.is_empty() {
            return Ok(());
        }
        // Keep the binding lock held if cancellation outlives the filesystem operation.
        let lock = self._lock.try_clone()?;
        tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
            let _lock = lock;
            for path in paths {
                match std::fs::remove_file(&path) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => {
                        return Err(error).with_context(|| {
                            format!("Cannot delete artifact file {}", path.display())
                        });
                    }
                }
            }
            Ok(())
        })
        .await??;
        self.bindings
            .retain(|binding| binding.artifact_id.as_deref() != Some(artifact_id));
        self.persist().await
    }

    pub fn reserve(&mut self, path: String) -> &mut ArtifactBinding {
        let index = self
            .bindings
            .iter()
            .position(|binding| binding.local_path == path)
            .unwrap_or_else(|| {
                self.bindings.push(ArtifactBinding {
                    registration_id: uuid::Uuid::new_v4().to_string(),
                    artifact_id: None,
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
                && existing.artifact_id.is_some()
                && existing.artifact_id != binding.artifact_id
        }) {
            bail!("This path is already bound to another artifact; choose a distinct path.");
        }
        self.bindings.retain(|existing| {
            (binding.artifact_id.is_none() || existing.artifact_id != binding.artifact_id)
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
    if content.len() > crate::MAX_ARTIFACT_BYTES {
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
            let existing = crate::read_artifact_file(workspace, path).await?;
            if existing.content != content {
                bail!("Destination already exists with different contents; choose another path.");
            }
        }
        Err(error) => return Err(error.into()),
    }
    Ok(crate::read_artifact_file(workspace, path).await?.local_path)
}

#[cfg(test)]
mod tests;
