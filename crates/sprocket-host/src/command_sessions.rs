use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use sprocket_workspace::{CommandSessionManager, RunningCommand};
use tokio::sync::{Mutex, watch};

/// Owns command processes independently of the run that launched them. Scopes
/// come from authenticated run creation, never from a command tool argument.
#[derive(Default)]
pub struct ThreadCommandSessions {
    threads: Mutex<HashMap<(String, String), CommandSessionManager>>,
    stopped: AtomicBool,
    changes: watch::Sender<u64>,
}

impl ThreadCommandSessions {
    pub async fn for_run(
        &self,
        user_id: &str,
        thread_id: &str,
        workspace_root: PathBuf,
        log_directory: PathBuf,
    ) -> CommandSessionManager {
        let mut threads = self.threads.lock().await;
        if self.stopped.load(Ordering::Acquire) {
            let sessions = CommandSessionManager::new(workspace_root, log_directory);
            sessions.stop_all().await;
            return sessions;
        }
        threads
            .entry((user_id.to_string(), thread_id.to_string()))
            .or_insert_with(|| {
                CommandSessionManager::new(workspace_root.clone(), log_directory)
                    .with_change_signal(self.changes.clone())
            })
            .clone()
            .with_workspace_root(workspace_root)
    }

    pub async fn get(&self, user_id: &str, thread_id: &str) -> Option<CommandSessionManager> {
        self.threads
            .lock()
            .await
            .get(&(user_id.to_string(), thread_id.to_string()))
            .cloned()
    }

    pub async fn running_commands(&self, user_id: &str, thread_id: &str) -> Vec<RunningCommand> {
        match self.get(user_id, thread_id).await {
            Some(sessions) => sessions.running_commands().await,
            None => Vec::new(),
        }
    }

    /// Changes whenever any thread's running commands may have changed.
    pub fn subscribe_changes(&self) -> watch::Receiver<u64> {
        self.changes.subscribe()
    }

    pub async fn prune(&self) {
        let snapshot = self
            .threads
            .lock()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        futures::future::join_all(snapshot.iter().map(CommandSessionManager::prune_completed))
            .await;
        // Clones inflate Arc::strong_count, so try_is_unused would keep every manager.
        drop(snapshot);
        self.threads
            .lock()
            .await
            .retain(|_, sessions| !sessions.try_is_unused());
    }

    pub async fn stop_all(&self) {
        self.stopped.store(true, Ordering::Release);
        let threads = std::mem::take(&mut *self.threads.lock().await);
        futures::future::join_all(threads.values().map(CommandSessionManager::stop_all)).await;
    }
}

#[cfg(test)]
mod tests;
