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
            sessions.stop_all().await;
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
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use sprocket_workspace::{WorkspaceCancellation, default_command_shell};

    use super::*;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn pruning_busy_thread_does_not_block_unrelated_commands() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().to_path_buf();
        let registry = ThreadCommandSessions::default();
        let entered = Arc::new(tokio::sync::Notify::new());
        let (release, released) = std::sync::mpsc::channel();
        let released = std::sync::Mutex::new(released);
        let busy = registry
            .for_run("user", "busy-thread", root.clone(), root.join("logs"))
            .await
            .with_lifetime_guard_factory({
                let entered = entered.clone();
                move || {
                    // Hold the manager lock while acquiring the process guard.
                    entered.notify_one();
                    released
                        .lock()
                        .unwrap()
                        .recv_timeout(Duration::from_secs(5))?;
                    Err::<(), _>(std::io::Error::other("blocked spawn released").into())
                }
            });
        let spawn = tokio::spawn(async move {
            busy.exec_command(
                WorkspaceCancellation::new(),
                "echo unreachable",
                ".",
                &default_command_shell(),
                None,
                0,
                20_000,
            )
            .await
        });
        entered.notified().await;

        let mut pruning = Box::pin(registry.prune());
        assert!(futures::poll!(pruning.as_mut()).is_pending());
        let access = tokio::time::timeout(Duration::from_secs(1), async {
            let other = registry
                .for_run("user", "other-thread", root.clone(), root.join("logs"))
                .await;
            assert!(registry.get("user", "other-thread").await.is_some());
            assert!(other.running_commands().await.is_empty());
            assert!(!other.terminate_command("unknown").await);
            other
        })
        .await;

        // Unblock the worker even when the access check times out.
        release.send(()).unwrap();
        assert!(
            spawn
                .await
                .unwrap()
                .unwrap_err()
                .to_string()
                .contains("blocked spawn released")
        );
        assert_eq!(
            std::fs::read_dir(root.join("logs/sessions"))
                .unwrap()
                .count(),
            0
        );
        pruning.await;
        let other = access.expect("cleanup blocked access to an unrelated thread");
        registry.prune().await;
        assert!(registry.get("user", "other-thread").await.is_some());
        drop(other);
        registry.prune().await;
        assert!(registry.get("user", "other-thread").await.is_none());
        registry.stop_all().await;
    }

    #[tokio::test]
    async fn registry_keeps_commands_after_run_drop_and_isolates_thread_scopes() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().to_path_buf();
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
    }
}
