use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use sprocket_workspace::{
    resolve_git_repository_identity, resolve_or_create_workspace_root, resolve_workspace_root,
};
use tokio::sync::{Mutex, RwLock};

const PROJECT_ATTACHMENTS_FILE: &str = "project-attachments.json";
const STALE_UNAVAILABLE_WORKSPACE_MS: u64 = 1000 * 60 * 60 * 24 * 30;
const MAX_PERSISTED_PROJECT_ATTACHMENTS: usize = 200;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectAttachmentRecord {
    pub project_id: String,
    pub workspace_path: String,
    pub availability: WorkspaceAvailability,
    pub last_validated_at: u64,
    pub last_used_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceAvailability {
    Available,
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachProjectRequest {
    pub project_id: String,
    pub workspace_path: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePathResolution {
    pub workspace_path: String,
    /// Short UI label for the repository (repo name or directory name).
    pub display_name: String,
    /// Stable repository identity from git origin, or the directory name when unset.
    pub repository_key: String,
}

pub struct ProjectAttachmentStore {
    data_dir: PathBuf,
    attachments: RwLock<HashMap<String, ProjectAttachmentRecord>>,
    loaded: RwLock<bool>,
    refresh_lock: Mutex<()>,
}

impl ProjectAttachmentStore {
    pub fn new(data_dir: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            data_dir,
            attachments: RwLock::new(HashMap::new()),
            loaded: RwLock::new(false),
            refresh_lock: Mutex::new(()),
        })
    }

    pub async fn list(&self) -> Result<Vec<ProjectAttachmentRecord>> {
        self.ensure_loaded().await?;
        self.refresh_all().await?;
        let sessions = self.attachments.read().await;
        Ok(sessions.values().cloned().collect())
    }

    pub async fn attach(&self, request: AttachProjectRequest) -> Result<ProjectAttachmentRecord> {
        self.ensure_loaded().await?;
        let now = now_ms();
        let validated = validate_session_async(ProjectAttachmentRecord {
            project_id: request.project_id,
            workspace_path: request.workspace_path,
            availability: WorkspaceAvailability::Available,
            last_validated_at: now,
            last_used_at: now,
            unavailable_reason: None,
        })
        .await?;

        if validated.availability == WorkspaceAvailability::Unavailable {
            if let Some(reason) = &validated.unavailable_reason {
                anyhow::bail!("{reason}");
            }
            anyhow::bail!("workspace path is unavailable");
        }

        self.attachments
            .write()
            .await
            .insert(validated.project_id.clone(), validated.clone());
        self.save_to_disk().await?;
        Ok(validated)
    }

    pub async fn workspace_path(&self, project_id: &str) -> Result<String> {
        self.ensure_loaded().await?;
        let session = self.get_or_error(project_id).await?;
        let validated = validate_session_async(session).await?;
        if validated.availability != WorkspaceAvailability::Available {
            anyhow::bail!(
                validated
                    .unavailable_reason
                    .unwrap_or_else(|| "workspace path is unavailable".to_string())
            );
        }
        Ok(validated.workspace_path)
    }

    async fn get_or_error(&self, project_id: &str) -> Result<ProjectAttachmentRecord> {
        let sessions = self.attachments.read().await;
        sessions.get(project_id).cloned().ok_or_else(|| {
            anyhow::anyhow!("Project path is unavailable. Re-open this project in the desktop app.")
        })
    }

    async fn ensure_loaded(&self) -> Result<()> {
        let mut loaded = self.loaded.write().await;
        if *loaded {
            return Ok(());
        }

        tokio::fs::create_dir_all(&self.data_dir).await?;
        let store_path = self.data_dir.join(PROJECT_ATTACHMENTS_FILE);
        if tokio::fs::try_exists(&store_path).await? {
            let contents = tokio::fs::read_to_string(&store_path)
                .await
                .with_context(|| format!("failed to read {}", store_path.display()))?;
            let stored: Vec<ProjectAttachmentRecord> = serde_json::from_str(&contents)
                .with_context(|| "failed to parse project attachments")?;
            let mut sessions = self.attachments.write().await;
            for entry in stored {
                sessions.insert(entry.project_id.clone(), entry);
            }
        }

        *loaded = true;
        Ok(())
    }

    async fn refresh_all(&self) -> Result<()> {
        let _refresh_guard = self.refresh_lock.lock().await;
        let snapshot: Vec<(String, ProjectAttachmentRecord)> = self
            .attachments
            .read()
            .await
            .iter()
            .map(|(id, session)| (id.clone(), session.clone()))
            .collect();
        let validated = tokio::task::spawn_blocking(move || {
            snapshot
                .into_iter()
                .map(|(id, original)| {
                    let refreshed = validate_session_path(original.clone());
                    (id, original, refreshed)
                })
                .collect::<Vec<_>>()
        })
        .await
        .context("project attachment validation task failed")?;

        let mut changed = false;
        let mut sessions = self.attachments.write().await;
        for (project_id, original, refreshed) in validated {
            if sessions.get(&project_id) != Some(&original) {
                continue;
            }

            if session_availability_changed(&original, &refreshed) {
                changed = true;
            }
            sessions.insert(project_id, refreshed);
        }
        drop(sessions);

        if changed {
            self.save_to_disk().await?;
        }

        Ok(())
    }

    async fn save_to_disk(&self) -> Result<()> {
        self.prune().await;
        let store_path = self.data_dir.join(PROJECT_ATTACHMENTS_FILE);
        let payload = {
            let sessions = self.attachments.read().await;
            serde_json::to_string_pretty(&sessions.values().collect::<Vec<_>>())?
        };
        tokio::fs::write(store_path, payload).await?;
        Ok(())
    }

    async fn prune(&self) {
        let now = now_ms();
        let mut store = self.attachments.write().await;
        let mut sessions: Vec<ProjectAttachmentRecord> = store
            .values()
            .filter(|session| {
                session.availability == WorkspaceAvailability::Available
                    || now.saturating_sub(session.last_validated_at)
                        < STALE_UNAVAILABLE_WORKSPACE_MS
            })
            .cloned()
            .collect();

        sessions.sort_by_key(|session| std::cmp::Reverse(session.last_used_at));
        sessions.truncate(MAX_PERSISTED_PROJECT_ATTACHMENTS);

        store.clear();
        for session in sessions {
            store.insert(session.project_id.clone(), session);
        }
    }
}

fn mark_available(
    session: ProjectAttachmentRecord,
    workspace_path: String,
) -> ProjectAttachmentRecord {
    ProjectAttachmentRecord {
        workspace_path,
        availability: WorkspaceAvailability::Available,
        last_validated_at: now_ms(),
        unavailable_reason: None,
        ..session
    }
}

fn mark_unavailable(
    session: ProjectAttachmentRecord,
    error: &anyhow::Error,
) -> ProjectAttachmentRecord {
    ProjectAttachmentRecord {
        availability: WorkspaceAvailability::Unavailable,
        last_validated_at: now_ms(),
        unavailable_reason: Some(error.to_string()),
        ..session
    }
}

fn validate_session_path(session: ProjectAttachmentRecord) -> ProjectAttachmentRecord {
    match resolve_workspace_path(&session.workspace_path, false) {
        Ok(resolution) => mark_available(session, resolution.workspace_path),
        Err(error) => mark_unavailable(session, &error),
    }
}

fn session_availability_changed(
    previous: &ProjectAttachmentRecord,
    current: &ProjectAttachmentRecord,
) -> bool {
    previous.workspace_path != current.workspace_path
        || previous.availability != current.availability
        || previous.unavailable_reason != current.unavailable_reason
}

async fn validate_session_async(
    session: ProjectAttachmentRecord,
) -> Result<ProjectAttachmentRecord> {
    tokio::task::spawn_blocking(move || validate_session_path(session))
        .await
        .context("workspace validation task failed")
}

pub fn resolve_workspace_path(
    workspace_path: &str,
    create_if_missing: bool,
) -> Result<WorkspacePathResolution> {
    let root = if create_if_missing {
        resolve_or_create_workspace_root(workspace_path)?
    } else {
        resolve_workspace_root(workspace_path)?
    };
    let workspace_path = root.to_string_lossy().to_string();
    if workspace_path.is_empty() {
        anyhow::bail!("failed to resolve workspace path");
    }
    let identity = resolve_git_repository_identity(&root);

    Ok(WorkspacePathResolution {
        workspace_path,
        display_name: identity.display_name,
        repository_key: identity.repository_key,
    })
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[tokio::test]
    async fn attach_and_list_project_attachment() {
        let temp_root =
            std::env::temp_dir().join(format!("sprocket-project-attachments-{}", now_ms()));
        fs::create_dir_all(&temp_root).expect("temp dir");
        let store = ProjectAttachmentStore::new(temp_root.clone());

        let session = store
            .attach(AttachProjectRequest {
                project_id: "project-1".to_string(),
                workspace_path: env!("CARGO_MANIFEST_DIR").to_string(),
            })
            .await
            .expect("attach");

        assert_eq!(session.availability, WorkspaceAvailability::Available);
        let listed = store.list().await.expect("list");
        assert_eq!(listed.len(), 1);

        let _ = fs::remove_dir_all(temp_root);
    }

    #[cfg(unix)]
    #[test]
    fn workspace_path_resolution_uses_canonical_name_and_root_fallback() {
        use std::os::unix::fs::symlink;

        let temp_root = std::env::temp_dir().join(format!("sprocket-workspace-path-{}", now_ms()));
        let target = temp_root.join("real-project");
        let link = temp_root.join("project-link");
        fs::create_dir_all(&target).expect("target dir");
        symlink(&target, &link).expect("symlink");

        let linked = resolve_workspace_path(&link.to_string_lossy(), false).expect("linked path");
        assert_eq!(linked.workspace_path, target.to_string_lossy());
        assert_eq!(linked.display_name, "real-project");
        assert_eq!(linked.repository_key, "real-project");

        let root = resolve_workspace_path("/", false).expect("filesystem root");
        assert_eq!(root.display_name, "workspace");
        assert_eq!(root.repository_key, "workspace");

        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn workspace_path_resolution_uses_git_origin_repository_key() {
        use std::process::Command;

        let temp_root = std::env::temp_dir().join(format!("sprocket-workspace-git-{}", now_ms()));
        let project = temp_root.join("checkout");
        fs::create_dir_all(&project).expect("project dir");
        let init = Command::new("git")
            .args(["init"])
            .current_dir(&project)
            .status()
            .expect("run git init");
        assert!(init.success(), "git init failed");
        let add_origin = Command::new("git")
            .args([
                "remote",
                "add",
                "origin",
                "https://github.com/spikonado/sprocket.git",
            ])
            .current_dir(&project)
            .status()
            .expect("run git remote add");
        assert!(add_origin.success(), "git remote add failed");

        let resolved =
            resolve_workspace_path(&project.to_string_lossy(), false).expect("resolve project");
        assert_eq!(resolved.display_name, "sprocket");
        assert_eq!(resolved.repository_key, "github.com/spikonado/sprocket");

        let _ = fs::remove_dir_all(temp_root);
    }
}
