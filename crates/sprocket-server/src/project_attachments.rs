use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

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
    pub workspace_path: String,
    pub repository_key: String,
    pub display_name: String,
    pub availability: WorkspaceAvailability,
    pub last_validated_at: u64,
    pub last_used_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
    /// Last persisted key when git identity changed, until the client rekeys threads.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_repository_key: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredProjectAttachment {
    #[serde(default)]
    workspace_path: String,
    #[serde(default)]
    repository_key: Option<String>,
    #[serde(default)]
    display_name: Option<String>,
    availability: WorkspaceAvailability,
    last_validated_at: u64,
    last_used_at: u64,
    #[serde(default)]
    unavailable_reason: Option<String>,
    #[serde(default)]
    previous_repository_key: Option<String>,
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
    pub workspace_path: String,
    #[serde(default)]
    pub replace_workspace_path: Option<String>,
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
        let mut listed: Vec<ProjectAttachmentRecord> = sessions.values().cloned().collect();
        listed.sort_by_key(|session| std::cmp::Reverse(session.last_used_at));
        Ok(listed)
    }

    pub async fn attach(&self, request: AttachProjectRequest) -> Result<ProjectAttachmentRecord> {
        self.ensure_loaded().await?;
        let now = crate::now_ms();
        let validated = validate_session_async(ProjectAttachmentRecord {
            workspace_path: request.workspace_path,
            repository_key: String::new(),
            display_name: String::new(),
            availability: WorkspaceAvailability::Available,
            last_validated_at: now,
            last_used_at: now,
            unavailable_reason: None,
            previous_repository_key: None,
        })
        .await?;

        if validated.availability == WorkspaceAvailability::Unavailable {
            if let Some(reason) = &validated.unavailable_reason {
                anyhow::bail!("{reason}");
            }
            anyhow::bail!("workspace path is unavailable");
        }

        {
            let mut sessions = self.attachments.write().await;
            sessions.insert(validated.workspace_path.clone(), validated.clone());
            if let Some(previous_path) = request
                .replace_workspace_path
                .as_deref()
                .map(str::trim)
                .filter(|path| !path.is_empty() && *path != validated.workspace_path)
            {
                sessions.remove(previous_path);
            }
        }
        self.save_to_disk().await?;
        Ok(validated)
    }

    pub async fn workspace_path(&self, workspace_path: &str) -> Result<String> {
        self.ensure_loaded().await?;
        let session = self.get_or_error(workspace_path).await?;
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

    async fn get_or_error(&self, workspace_path: &str) -> Result<ProjectAttachmentRecord> {
        let attachments = self.attachments.read().await;
        attachments.get(workspace_path).cloned().ok_or_else(|| {
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
            let stored: Vec<StoredProjectAttachment> = serde_json::from_str(&contents)
                .with_context(|| "failed to parse project attachments")?;
            let mut sessions = self.attachments.write().await;
            for entry in stored {
                if entry.workspace_path.trim().is_empty() {
                    continue;
                }
                let record = hydrate_stored_attachment(entry);
                sessions.insert(record.workspace_path.clone(), record);
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
            .map(|(workspace_path, attachment)| (workspace_path.clone(), attachment.clone()))
            .collect();
        let validated = tokio::task::spawn_blocking(move || {
            snapshot
                .into_iter()
                .map(|(previous_key, original)| {
                    let refreshed = validate_session_path(original.clone());
                    (previous_key, original, refreshed)
                })
                .collect::<Vec<_>>()
        })
        .await
        .context("project attachment validation task failed")?;

        let mut changed = false;
        let mut sessions = self.attachments.write().await;
        for (previous_key, original, refreshed) in validated {
            if sessions.get(&previous_key) != Some(&original) {
                continue;
            }

            if session_record_changed(&original, &refreshed) {
                changed = true;
            }
            if previous_key != refreshed.workspace_path {
                sessions.remove(&previous_key);
            }
            sessions.insert(refreshed.workspace_path.clone(), refreshed);
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
        let now = crate::now_ms();
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
            store.insert(session.workspace_path.clone(), session);
        }
    }
}

fn hydrate_stored_attachment(stored: StoredProjectAttachment) -> ProjectAttachmentRecord {
    let fallback_name = directory_name(&stored.workspace_path);
    validate_session_path(ProjectAttachmentRecord {
        workspace_path: stored.workspace_path,
        repository_key: stored.repository_key.unwrap_or_default(),
        display_name: stored.display_name.unwrap_or(fallback_name),
        availability: stored.availability,
        last_validated_at: stored.last_validated_at,
        last_used_at: stored.last_used_at,
        unavailable_reason: stored.unavailable_reason,
        previous_repository_key: stored.previous_repository_key,
    })
}

fn directory_name(workspace_path: &str) -> String {
    std::path::Path::new(workspace_path)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("workspace")
        .to_string()
}

fn mark_available(
    session: ProjectAttachmentRecord,
    resolution: WorkspacePathResolution,
) -> ProjectAttachmentRecord {
    ProjectAttachmentRecord {
        workspace_path: resolution.workspace_path,
        previous_repository_key: previous_repository_key_after_resolve(
            &session,
            &resolution.repository_key,
        ),
        repository_key: resolution.repository_key,
        display_name: resolution.display_name,
        availability: WorkspaceAvailability::Available,
        last_validated_at: crate::now_ms(),
        unavailable_reason: None,
        last_used_at: session.last_used_at,
    }
}

fn previous_repository_key_after_resolve(
    session: &ProjectAttachmentRecord,
    new_key: &str,
) -> Option<String> {
    let candidate = if !session.repository_key.is_empty() && session.repository_key != new_key {
        Some(session.repository_key.clone())
    } else {
        session.previous_repository_key.clone()
    };
    candidate.filter(|key| !key.is_empty() && key != new_key)
}

fn mark_unavailable(
    session: ProjectAttachmentRecord,
    error: &anyhow::Error,
) -> ProjectAttachmentRecord {
    let fallback_name = directory_name(&session.workspace_path);
    ProjectAttachmentRecord {
        availability: WorkspaceAvailability::Unavailable,
        last_validated_at: crate::now_ms(),
        unavailable_reason: Some(error.to_string()),
        repository_key: if session.repository_key.is_empty() {
            fallback_name.clone()
        } else {
            session.repository_key
        },
        display_name: if session.display_name.is_empty() {
            fallback_name
        } else {
            session.display_name
        },
        ..session
    }
}

fn validate_session_path(session: ProjectAttachmentRecord) -> ProjectAttachmentRecord {
    match resolve_workspace_path(&session.workspace_path, false) {
        Ok(resolution) => mark_available(session, resolution),
        Err(error) => mark_unavailable(session, &error),
    }
}

fn session_record_changed(
    previous: &ProjectAttachmentRecord,
    current: &ProjectAttachmentRecord,
) -> bool {
    previous.workspace_path != current.workspace_path
        || previous.repository_key != current.repository_key
        || previous.previous_repository_key != current.previous_repository_key
        || previous.display_name != current.display_name
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[tokio::test]
    async fn attach_and_list_project_attachment() {
        let temp_root =
            std::env::temp_dir().join(format!("sprocket-project-attachments-{}", crate::now_ms()));
        fs::create_dir_all(&temp_root).expect("temp dir");
        let store = ProjectAttachmentStore::new(temp_root.clone());

        let session = store
            .attach(AttachProjectRequest {
                workspace_path: env!("CARGO_MANIFEST_DIR").to_string(),
                replace_workspace_path: None,
            })
            .await
            .expect("attach");

        assert_eq!(session.availability, WorkspaceAvailability::Available);
        assert!(!session.repository_key.is_empty());
        let listed = store.list().await.expect("list");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].workspace_path, session.workspace_path);

        let _ = fs::remove_dir_all(temp_root);
    }

    #[cfg(unix)]
    #[test]
    fn workspace_path_resolution_uses_canonical_name_and_root_fallback() {
        use std::os::unix::fs::symlink;

        let temp_root =
            std::env::temp_dir().join(format!("sprocket-workspace-path-{}", crate::now_ms()));
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
        let temp_root =
            std::env::temp_dir().join(format!("sprocket-workspace-git-{}", crate::now_ms()));
        let project = temp_root.join("checkout");
        fs::create_dir_all(&project).expect("project dir");
        gix::init(&project).expect("gix init");
        let config_path = project.join(".git/config");
        let mut config = fs::read_to_string(&config_path).expect("read config");
        config
            .push_str("\n[remote \"origin\"]\n\turl = https://github.com/spikonado/sprocket.git\n");
        fs::write(config_path, config).expect("write config");

        let resolved =
            resolve_workspace_path(&project.to_string_lossy(), false).expect("resolve project");
        assert_eq!(resolved.display_name, "sprocket");
        assert_eq!(resolved.repository_key, "github.com/spikonado/sprocket");

        let _ = fs::remove_dir_all(temp_root);
    }

    #[tokio::test]
    async fn attach_replaces_the_previous_workspace_path() {
        let temp_root = std::env::temp_dir().join(format!(
            "sprocket-project-attachments-replace-{}",
            crate::now_ms()
        ));
        fs::create_dir_all(&temp_root).expect("temp dir");
        let store = ProjectAttachmentStore::new(temp_root.clone());
        let first = temp_root.join("first");
        let second = temp_root.join("second");
        fs::create_dir_all(&first).expect("first dir");
        fs::create_dir_all(&second).expect("second dir");

        let attached_first = store
            .attach(AttachProjectRequest {
                workspace_path: first.to_string_lossy().to_string(),
                replace_workspace_path: None,
            })
            .await
            .expect("attach first");
        let attached_second = store
            .attach(AttachProjectRequest {
                workspace_path: second.to_string_lossy().to_string(),
                replace_workspace_path: Some(attached_first.workspace_path.clone()),
            })
            .await
            .expect("attach second");

        let listed = store.list().await.expect("list");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].workspace_path, attached_second.workspace_path);

        let _ = fs::remove_dir_all(temp_root);
    }

    #[tokio::test]
    async fn load_rewrites_legacy_project_id_rows() {
        let temp_root = std::env::temp_dir().join(format!(
            "sprocket-project-attachments-legacy-{}",
            crate::now_ms()
        ));
        fs::create_dir_all(&temp_root).expect("temp dir");
        let workspace = temp_root.join("checkout");
        fs::create_dir_all(&workspace).expect("workspace dir");
        let store_path = temp_root.join(PROJECT_ATTACHMENTS_FILE);
        fs::write(
            store_path,
            serde_json::json!([{
                "projectId": "obsolete-convex-id",
                "workspacePath": workspace.to_string_lossy(),
                "availability": "available",
                "lastValidatedAt": 1,
                "lastUsedAt": 2
            }])
            .to_string(),
        )
        .expect("write legacy attachments");

        let listed = ProjectAttachmentStore::new(temp_root.clone())
            .list()
            .await
            .expect("list");
        let expected =
            resolve_workspace_path(&workspace.to_string_lossy(), false).expect("resolve");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].workspace_path, expected.workspace_path);
        assert_eq!(listed[0].repository_key, expected.repository_key);
        assert_eq!(listed[0].display_name, expected.display_name);

        let _ = fs::remove_dir_all(temp_root);
    }

    #[tokio::test]
    async fn list_keeps_the_previous_repository_key_when_git_identity_changes() {
        let temp_root = std::env::temp_dir().join(format!(
            "sprocket-project-attachments-rekey-{}",
            crate::now_ms()
        ));
        fs::create_dir_all(&temp_root).expect("temp dir");
        let workspace = temp_root.join("checkout");
        fs::create_dir_all(&workspace).expect("workspace dir");
        gix::init(&workspace).expect("gix init");
        let config_path = workspace.join(".git/config");
        let mut config = fs::read_to_string(&config_path).expect("read config");
        config
            .push_str("\n[remote \"origin\"]\n\turl = https://github.com/spikonado/sprocket.git\n");
        fs::write(config_path, config).expect("write config");
        fs::write(
            temp_root.join(PROJECT_ATTACHMENTS_FILE),
            serde_json::json!([{
                "workspacePath": workspace.to_string_lossy(),
                "repositoryKey": "legacy-key",
                "displayName": "checkout",
                "availability": "available",
                "lastValidatedAt": 1,
                "lastUsedAt": 2
            }])
            .to_string(),
        )
        .expect("write attachments");

        let listed = ProjectAttachmentStore::new(temp_root.clone())
            .list()
            .await
            .expect("list");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].repository_key, "github.com/spikonado/sprocket");
        assert_eq!(
            listed[0].previous_repository_key.as_deref(),
            Some("legacy-key")
        );

        let _ = fs::remove_dir_all(temp_root);
    }
}
