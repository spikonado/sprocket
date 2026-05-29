use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use sprocket_workspace::{
    WorkspaceOverview, build_workspace_overview, resolve_or_create_workspace_root,
    resolve_workspace_root,
};
use tokio::sync::RwLock;

const WORKSPACE_SESSIONS_FILE: &str = "workspace-sessions.json";
const STALE_UNAVAILABLE_WORKSPACE_MS: u64 = 1000 * 60 * 60 * 24 * 30;
const MAX_PERSISTED_WORKSPACE_SESSIONS: usize = 200;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSessionRecord {
    pub workspace_session_id: String,
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
pub struct AttachWorkspaceSessionRequest {
    pub workspace_session_id: String,
    pub workspace_path: String,
}

pub struct WorkspaceSessionStore {
    data_dir: PathBuf,
    sessions: RwLock<HashMap<String, WorkspaceSessionRecord>>,
    loaded: RwLock<bool>,
}

impl WorkspaceSessionStore {
    pub fn new(data_dir: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            data_dir,
            sessions: RwLock::new(HashMap::new()),
            loaded: RwLock::new(false),
        })
    }

    pub async fn list(&self) -> Result<Vec<WorkspaceSessionRecord>> {
        self.ensure_loaded().await?;
        self.refresh_all().await?;
        let sessions = self.sessions.read().await;
        Ok(sessions.values().cloned().collect())
    }

    pub async fn attach(
        &self,
        request: AttachWorkspaceSessionRequest,
    ) -> Result<WorkspaceSessionRecord> {
        self.ensure_loaded().await?;
        let now = now_ms();
        let validated = validate_session(WorkspaceSessionRecord {
            workspace_session_id: request.workspace_session_id,
            workspace_path: request.workspace_path,
            availability: WorkspaceAvailability::Available,
            last_validated_at: now,
            last_used_at: now,
            unavailable_reason: None,
        })?;

        if validated.session.availability == WorkspaceAvailability::Unavailable {
            if let Some(reason) = &validated.session.unavailable_reason {
                anyhow::bail!("{reason}");
            }
            anyhow::bail!("workspace path is unavailable");
        }

        self.sessions.write().await.insert(
            validated.session.workspace_session_id.clone(),
            validated.session.clone(),
        );
        self.save_to_disk().await?;
        Ok(validated.session)
    }

    pub async fn overview(&self, workspace_session_id: &str) -> Result<WorkspaceOverview> {
        self.ensure_loaded().await?;
        let session = self.get_or_error(workspace_session_id).await?;
        let validated = validate_session(session)?;
        self.sessions.write().await.insert(
            workspace_session_id.to_string(),
            WorkspaceSessionRecord {
                last_used_at: now_ms(),
                ..validated.session.clone()
            },
        );
        self.save_to_disk().await?;
        validated.overview.ok_or_else(|| {
            anyhow::anyhow!(
                validated
                    .session
                    .unavailable_reason
                    .unwrap_or_else(|| "workspace path is unavailable".to_string())
            )
        })
    }

    pub async fn workspace_path(&self, workspace_session_id: &str) -> Result<String> {
        self.ensure_loaded().await?;
        let session = self.get_or_error(workspace_session_id).await?;
        let validated = validate_session(session)?;
        if validated.session.availability != WorkspaceAvailability::Available {
            anyhow::bail!(
                validated
                    .session
                    .unavailable_reason
                    .unwrap_or_else(|| "workspace path is unavailable".to_string())
            );
        }
        Ok(validated.session.workspace_path)
    }

    async fn get_or_error(&self, workspace_session_id: &str) -> Result<WorkspaceSessionRecord> {
        let sessions = self.sessions.read().await;
        sessions.get(workspace_session_id).cloned().ok_or_else(|| {
            anyhow::anyhow!(
                "Workspace path is unavailable. Re-open this workspace in the desktop app."
            )
        })
    }

    async fn ensure_loaded(&self) -> Result<()> {
        let mut loaded = self.loaded.write().await;
        if *loaded {
            return Ok(());
        }

        fs::create_dir_all(&self.data_dir)?;
        let store_path = self.data_dir.join(WORKSPACE_SESSIONS_FILE);
        if store_path.exists() {
            let contents = fs::read_to_string(&store_path)
                .with_context(|| format!("failed to read {}", store_path.display()))?;
            let stored: Vec<WorkspaceSessionRecord> = serde_json::from_str(&contents)
                .with_context(|| "failed to parse workspace sessions")?;
            let mut sessions = self.sessions.write().await;
            for entry in stored {
                sessions.insert(entry.workspace_session_id.clone(), entry);
            }
        }

        *loaded = true;
        Ok(())
    }

    async fn refresh_all(&self) -> Result<()> {
        let ids: Vec<String> = self.sessions.read().await.keys().cloned().collect();
        let mut changed = false;

        for workspace_session_id in ids {
            let existing = self
                .sessions
                .read()
                .await
                .get(&workspace_session_id)
                .cloned();
            let Some(existing) = existing else {
                continue;
            };

            let validated = validate_session(existing)?;
            let mut sessions = self.sessions.write().await;
            if sessions.get(&workspace_session_id) != Some(&validated.session) {
                sessions.insert(workspace_session_id, validated.session);
                changed = true;
            }
        }

        if changed {
            self.save_to_disk().await?;
        }

        Ok(())
    }

    async fn save_to_disk(&self) -> Result<()> {
        self.prune().await;
        let store_path = self.data_dir.join(WORKSPACE_SESSIONS_FILE);
        let sessions = self.sessions.read().await;
        let payload = serde_json::to_string_pretty(&sessions.values().collect::<Vec<_>>())?;
        fs::write(store_path, payload)?;
        Ok(())
    }

    async fn prune(&self) {
        let now = now_ms();
        let mut sessions: Vec<WorkspaceSessionRecord> = self
            .sessions
            .read()
            .await
            .values()
            .filter(|session| {
                session.availability == WorkspaceAvailability::Available
                    || now.saturating_sub(session.last_validated_at)
                        < STALE_UNAVAILABLE_WORKSPACE_MS
            })
            .cloned()
            .collect();

        sessions.sort_by_key(|session| std::cmp::Reverse(session.last_used_at));
        sessions.truncate(MAX_PERSISTED_WORKSPACE_SESSIONS);

        let mut store = self.sessions.write().await;
        store.clear();
        for session in sessions {
            store.insert(session.workspace_session_id.clone(), session);
        }
    }
}

struct ValidatedWorkspaceSession {
    session: WorkspaceSessionRecord,
    overview: Option<WorkspaceOverview>,
}

fn validate_session(session: WorkspaceSessionRecord) -> Result<ValidatedWorkspaceSession> {
    match workspace_overview_for_path(&session.workspace_path, false) {
        Ok(overview) => Ok(ValidatedWorkspaceSession {
            session: WorkspaceSessionRecord {
                workspace_path: overview.root_path.clone(),
                availability: WorkspaceAvailability::Available,
                last_validated_at: now_ms(),
                unavailable_reason: None,
                ..session
            },
            overview: Some(overview),
        }),
        Err(error) => Ok(ValidatedWorkspaceSession {
            session: WorkspaceSessionRecord {
                availability: WorkspaceAvailability::Unavailable,
                last_validated_at: now_ms(),
                unavailable_reason: Some(error.to_string()),
                ..session
            },
            overview: None,
        }),
    }
}

pub fn workspace_overview_for_path(
    workspace_path: &str,
    create_if_missing: bool,
) -> Result<WorkspaceOverview> {
    let root = if create_if_missing {
        resolve_or_create_workspace_root(workspace_path)?
    } else {
        resolve_workspace_root(workspace_path)?
    };
    let overview = build_workspace_overview(&root)?;
    if overview.root_path.is_empty() {
        anyhow::bail!("failed to resolve workspace path");
    }
    Ok(overview)
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
    async fn attach_and_list_workspace_session() {
        let temp_root = std::env::temp_dir().join(format!("sprocket-workspace-store-{}", now_ms()));
        fs::create_dir_all(&temp_root).expect("temp dir");
        let store = WorkspaceSessionStore::new(temp_root.clone());

        let overview =
            workspace_overview_for_path(env!("CARGO_MANIFEST_DIR"), false).expect("overview");
        let session = store
            .attach(AttachWorkspaceSessionRequest {
                workspace_session_id: "session-1".to_string(),
                workspace_path: overview.root_path,
            })
            .await
            .expect("attach");

        assert_eq!(session.availability, WorkspaceAvailability::Available);
        let listed = store.list().await.expect("list");
        assert_eq!(listed.len(), 1);

        let _ = fs::remove_dir_all(temp_root);
    }
}
