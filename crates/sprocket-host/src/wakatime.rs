use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use sprocket_transcript::TranscriptStore;
use sprocket_workspace::SPROCKET_VERSION;
use tokio::sync::{Mutex, broadcast, oneshot};
use tokio::task::JoinHandle;

const SYNC_INTERVAL: Duration = Duration::from_secs(30);
const SYNC_TIMEOUT: Duration = Duration::from_secs(20);
static SYNC_LOCK: Mutex<()> = Mutex::const_new(());

pub(crate) struct WakaTimeSession {
    finish: oneshot::Sender<()>,
    task: JoinHandle<()>,
}

impl WakaTimeSession {
    pub(crate) async fn start(
        store: &TranscriptStore,
        user_id: &str,
        thread_id: &str,
        run_id: &str,
        workspace: &Path,
    ) -> Option<Self> {
        let executable = std::env::var_os("SPROCKET_WAKATIME_CLI").filter(|s| !s.is_empty())?;
        match Self::open(store, user_id, thread_id, run_id, workspace, executable).await {
            Ok(session) => Some(session),
            Err(error) => {
                tracing::warn!("could not start WakaTime tracking: {error:#}");
                None
            }
        }
    }

    async fn open(
        store: &TranscriptStore,
        user_id: &str,
        thread_id: &str,
        run_id: &str,
        workspace: &Path,
        executable: OsString,
    ) -> anyhow::Result<Self> {
        let changes = store.watch_changes();
        let path = store
            .thread_dir(user_id, thread_id)
            .join("wakatime")
            .join(format!("{run_id}.json"));
        let metadata = serde_json::to_vec(&serde_json::json!({
            "workspacePath": workspace,
            "version": SPROCKET_VERSION,
        }))?;
        tokio::task::spawn_blocking(move || crate::profile::write_private_file(&path, &metadata))
            .await??;
        let data_dir = store
            .root()
            .parent()
            .ok_or_else(|| anyhow::anyhow!("transcript root has no parent"))?
            .to_owned();
        let user_id = user_id.to_owned();
        let thread_id = thread_id.to_owned();
        let (finish, stopped) = oneshot::channel();
        let task = tokio::spawn(watch(
            executable, data_dir, user_id, thread_id, changes, stopped,
        ));
        Ok(Self { finish, task })
    }

    pub(crate) async fn finish(self) {
        let _ = self.finish.send(());
        if let Err(error) = self.task.await {
            tracing::warn!("WakaTime tracking stopped: {error}");
        }
    }
}

async fn watch(
    executable: OsString,
    data_dir: PathBuf,
    user_id: String,
    thread_id: String,
    mut changes: broadcast::Receiver<(String, String)>,
    mut stopped: oneshot::Receiver<()>,
) {
    loop {
        tokio::select! {
            biased;
            _ = &mut stopped => break,
            change = changes.recv() => match change {
                Ok((user, thread)) if user == user_id && thread == thread_id => {},
                Err(broadcast::error::RecvError::Lagged(_)) => {},
                Err(broadcast::error::RecvError::Closed) => break,
                _ => continue,
            },
        }
        tokio::select! {
            biased;
            _ = &mut stopped => break,
            _ = tokio::time::sleep(SYNC_INTERVAL) => {},
        }
        changes = changes.resubscribe();
        sync(&executable, &data_dir).await;
    }
    sync(&executable, &data_dir).await;
}

async fn sync(executable: &OsString, data_dir: &Path) {
    let _guard = SYNC_LOCK.lock().await;
    let result = tokio::time::timeout(
        SYNC_TIMEOUT,
        tokio::process::Command::new(executable)
            .args([
                "--sync-ai-activity",
                "--plugin",
                &format!("Sprocket/{SPROCKET_VERSION} sprocket-wakatime/{SPROCKET_VERSION}"),
                "--timeout",
                "15",
            ])
            .env("SPROCKET_DATA_DIR", data_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .status(),
    )
    .await;
    match result {
        Ok(Ok(status)) if status.success() => {}
        Ok(Ok(status)) => {
            tracing::warn!("WakaTime sync exited with {status}; see ~/.wakatime/wakatime.log")
        }
        Ok(Err(error)) => tracing::warn!("could not run WakaTime sync: {error}"),
        Err(_) => tracing::warn!("WakaTime sync timed out"),
    }
}

#[cfg(all(test, unix))]
mod tests;
