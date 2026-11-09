use std::collections::HashMap;
#[cfg(unix)]
use std::path::Path;
use std::path::PathBuf;
#[cfg(unix)]
use std::sync::Arc;

#[cfg(unix)]
use sprocket_workspace::CommandHistory;
use sprocket_workspace::{CommandContainer, CommandSessionManager, RunningCommand};
use tokio::sync::{Mutex, watch};

#[cfg(unix)]
use crate::lifetime::HostLifetime;

#[derive(Clone, Copy, Default, PartialEq)]
enum Lifecycle {
    #[default]
    Running,
    Stopped,
    /// Commands keep running for the server that replaces this one.
    Detached,
}

#[derive(Default)]
pub struct ThreadCommandSessions {
    threads: Mutex<HashMap<(String, String), CommandSessionManager>>,
    lifecycle: std::sync::Mutex<Lifecycle>,
    changes: watch::Sender<()>,
    container: Option<CommandContainer>,
}

impl ThreadCommandSessions {
    /// Servers that share `container_name` share the processes left by commands.
    pub fn new(container_name: &str) -> Self {
        let container = CommandContainer::create(container_name).unwrap_or_else(|error| {
            tracing::warn!(
                "processes that leave a command's process group will outlive the server: {error:#}"
            );
            None
        });
        Self {
            container,
            ..Self::default()
        }
    }

    pub async fn for_run(
        &self,
        user_id: &str,
        thread_id: &str,
        workspace_root: PathBuf,
        log_directory: PathBuf,
    ) -> CommandSessionManager {
        let mut threads = self.threads.lock().await;
        if *self.lifecycle.lock().unwrap() != Lifecycle::Running {
            let sessions = CommandSessionManager::new(workspace_root, log_directory);
            sessions.stop_all().await;
            return sessions;
        }
        threads
            .entry((user_id.to_string(), thread_id.to_string()))
            .or_insert_with(|| self.manager(workspace_root.clone(), log_directory))
            .clone()
            .with_workspace_root(workspace_root)
    }

    fn manager(&self, workspace_root: PathBuf, log_directory: PathBuf) -> CommandSessionManager {
        CommandSessionManager::new(workspace_root, log_directory)
            .with_change_signal(self.changes.clone())
            .with_container(self.container.clone())
    }

    /// Takes over the commands that this machine's previous server left running.
    #[cfg(unix)]
    pub async fn adopt(&self, store_root: &Path, machine_id: &str, lifetime: &Arc<HostLifetime>) {
        let records = match crate::command_sync::session_records(store_root).await {
            Ok(records) => records,
            Err(error) => {
                tracing::warn!("failed to find commands left by the previous server: {error:#}");
                return;
            }
        };
        for record in records.into_iter().flatten() {
            if tokio::fs::try_exists(record.path.with_extension("synced"))
                .await
                .unwrap_or(false)
            {
                continue;
            }
            let Ok(bytes) = tokio::fs::read(&record.path).await else {
                continue;
            };
            let Ok(history) = serde_json::from_slice::<CommandHistory>(&bytes) else {
                continue;
            };
            let Some(session_id) = record.path.file_stem().and_then(|stem| stem.to_str()) else {
                continue;
            };
            if !history.result.running
                || history.process.is_none()
                || history.machine_id != machine_id
            {
                continue;
            }
            let manager = self
                .threads
                .lock()
                .await
                .entry((history.user_id.clone(), history.thread_id.clone()))
                .or_insert_with(|| self.manager(PathBuf::from(&history.workdir), record.directory))
                .clone();
            let lifetime = Arc::clone(lifetime);
            if let Err(error) = manager
                .with_lifetime_guard_factory(move || lifetime.run_guard())
                .adopt(session_id, history)
                .await
            {
                tracing::warn!("failed to adopt command {session_id}: {error:#}");
            }
        }
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

    pub fn subscribe_changes(&self) -> watch::Receiver<()> {
        self.changes.subscribe()
    }

    pub async fn prune(&self) {
        let managers = self
            .threads
            .lock()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        futures::future::join_all(
            managers
                .into_iter()
                .map(|sessions| async move { sessions.prune_completed().await }),
        )
        .await;
        self.threads
            .lock()
            .await
            .retain(|_, sessions| !sessions.try_is_unused());
    }

    pub async fn stop_all(&self) {
        *self.lifecycle.lock().unwrap() = Lifecycle::Stopped;
        let threads = std::mem::take(&mut *self.threads.lock().await);
        futures::future::join_all(threads.values().map(CommandSessionManager::stop_all)).await;
        if let Some(container) = &self.container
            && let Err(error) = container.kill().await
        {
            tracing::warn!("failed to stop processes left by commands: {error:#}");
        }
    }

    /// Leaves running commands, and the processes they started, to the next server.
    #[cfg(unix)]
    pub async fn detach_all(&self) {
        *self.lifecycle.lock().unwrap() = Lifecycle::Detached;
        let threads = std::mem::take(&mut *self.threads.lock().await);
        futures::future::join_all(threads.values().map(CommandSessionManager::detach_all)).await;
    }

    /// Windows ties commands to the server's job object, so they can't outlive it.
    #[cfg(windows)]
    pub async fn detach_all(&self) {
        self.stop_all().await;
    }

    pub fn is_detached(&self) -> bool {
        *self.lifecycle.lock().unwrap() == Lifecycle::Detached
    }
}

#[cfg(test)]
mod tests;
