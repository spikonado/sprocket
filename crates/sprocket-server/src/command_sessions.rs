use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use sprocket_workspace::CommandSessionManager;
use tokio::sync::Mutex;

/// Owns command processes independently of the run that launched them. Scopes
/// come from authenticated run creation, never from a command tool argument.
#[derive(Default)]
pub(crate) struct ThreadCommandSessions {
    threads: Mutex<HashMap<(String, String), CommandSessionManager>>,
    stopped: AtomicBool,
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
            sessions.terminate_all();
            return sessions;
        }
        threads
            .entry((user_id.to_string(), thread_id.to_string()))
            .or_insert_with(|| CommandSessionManager::new(workspace_root.clone(), log_directory))
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

    pub async fn prune(&self) {
        let mut threads = self.threads.lock().await;
        let mut unused = Vec::new();
        for (scope, sessions) in threads.iter() {
            sessions.prune_completed().await;
            if sessions.is_unused().await {
                unused.push(scope.clone());
            }
        }
        for scope in unused {
            threads.remove(&scope);
        }
    }

    pub async fn stop_all(&self) {
        self.stopped.store(true, Ordering::Release);
        let threads = std::mem::take(&mut *self.threads.lock().await);
        futures::future::join_all(threads.values().map(CommandSessionManager::stop_all)).await;
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use sprocket_workspace::{WorkspaceCancellation, default_command_shell};

    use super::*;

    #[tokio::test]
    async fn registry_keeps_commands_after_run_drop_and_isolates_thread_scopes() {
        let root =
            std::env::temp_dir().join(format!("sprocket-thread-commands-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let registry = Arc::new(ThreadCommandSessions::default());
        let run = registry
            .for_run("user", "thread", root.clone(), root.join("logs"))
            .await;
        let started = run
            .exec_command(
                WorkspaceCancellation::new(),
                "sleep 5",
                ".",
                &default_command_shell(),
                Some(5_000),
                0,
                20_000,
            )
            .await
            .unwrap();
        let session_id = started.session_id.unwrap();
        drop(run);
        registry.prune().await;
        let next_run = registry
            .for_run("user", "thread", root.clone(), root.join("logs"))
            .await;
        assert_eq!(next_run.running_commands().await[0].session_id, session_id);
        assert!(registry.get("other-user", "thread").await.is_none());
        assert!(registry.get("user", "other-thread").await.is_none());
        let other_thread = registry
            .for_run("user", "other-thread", root.clone(), root.join("logs"))
            .await;
        assert!(!other_thread.terminate_command(&session_id).await);
        drop(other_thread);
        registry.prune().await;
        assert!(registry.get("user", "other-thread").await.is_none());
        registry.stop_all().await;
        assert!(next_run.running_commands().await.is_empty());
        assert!(registry.get("user", "thread").await.is_none());
        let late_run = registry
            .for_run("user", "late-thread", root.clone(), root.join("logs"))
            .await;
        assert!(
            late_run
                .exec_command(
                    WorkspaceCancellation::new(),
                    "touch leaked",
                    ".",
                    &default_command_shell(),
                    None,
                    0,
                    20_000,
                )
                .await
                .unwrap_err()
                .to_string()
                .contains("shutting down")
        );
        assert!(!root.join("leaked").exists());
        std::fs::remove_dir_all(root).unwrap();
    }
}
