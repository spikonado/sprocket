use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Result, anyhow};
use sprocket_workspace::{CommandSessionInfo, CommandSessionManager};
use tokio::sync::Mutex;

#[derive(Clone, Default)]
pub(crate) struct CommandSessionStore {
    entries: Arc<Mutex<HashMap<String, CommandSessionEntry>>>,
}

struct CommandSessionEntry {
    workspace_root: PathBuf,
    manager: CommandSessionManager,
}

impl CommandSessionStore {
    pub(crate) async fn for_thread(
        &self,
        thread_id: &str,
        workspace_root: &Path,
    ) -> Result<CommandSessionManager> {
        let mut entries = self.entries.lock().await;
        if let Some(entry) = entries.get(thread_id) {
            if entry.workspace_root != workspace_root {
                return Err(anyhow!(
                    "thread command sessions belong to a different workspace"
                ));
            }
            return Ok(entry.manager.clone());
        }

        let manager = CommandSessionManager::new(workspace_root.to_path_buf());
        entries.insert(
            thread_id.to_string(),
            CommandSessionEntry {
                workspace_root: workspace_root.to_path_buf(),
                manager: manager.clone(),
            },
        );
        Ok(manager)
    }

    pub(crate) async fn stop_by_user(&self, thread_id: &str, session_id: &str) -> Result<()> {
        let manager = self
            .entries
            .lock()
            .await
            .get(thread_id)
            .map(|entry| entry.manager.clone());
        let Some(manager) = manager else {
            return Ok(());
        };
        manager.stop_by_user(session_id).await
    }

    pub(crate) async fn available_sessions(&self, thread_id: &str) -> Vec<CommandSessionInfo> {
        let manager = self
            .entries
            .lock()
            .await
            .get(thread_id)
            .map(|entry| entry.manager.clone());
        match manager {
            Some(manager) => manager.available_sessions().await,
            None => Vec::new(),
        }
    }
}
