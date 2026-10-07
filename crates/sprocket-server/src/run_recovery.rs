use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::StreamExt;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex as AsyncMutex;
use tokio::task::JoinHandle;
use tokio::time::{MissedTickBehavior, interval, timeout};
use uuid::Uuid;

use crate::AppState;
use crate::routes::agent::{RunAgentApiRequest, WorkspaceAccess, launch_recovery};

const MAX_RECOVERIES: u8 = 3;
const MAX_RECORDS: usize = 256;
const MAX_AGE_MS: u64 = 24 * 60 * 60 * 1000;
const RETRY_DELAY_MS: u64 = 30_000;
const RPC_TIMEOUT: Duration = Duration::from_secs(15);
// Must match convex/lib/runRecovery.ts.
const SUBMISSION_PREFIX: &str = "automatic-recovery:";

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct RecoveryRecord {
    pub request: RunAgentApiRequest,
    pub workspace_access: WorkspaceAccess,
    pub allow_interaction: bool,
    recoveries: u8,
    created_at: u64,
}

impl RecoveryRecord {
    pub(crate) fn new(
        mut request: RunAgentApiRequest,
        workspace_access: WorkspaceAccess,
        allow_interaction: bool,
    ) -> Self {
        // Only continuations are replayed; the original prompt and attachment
        // references already belong to the durable cloud transcript.
        request.prompt.clear();
        request.storage_ids.clear();
        Self {
            request,
            workspace_access,
            allow_interaction,
            recoveries: 0,
            created_at: crate::now_ms(),
        }
    }

    fn key(&self) -> String {
        format!("{}:{}", self.request.user_id, self.request.submission_id)
    }

    fn continuation(&self, run_id: String, thread_id: String) -> Option<Self> {
        if self.recoveries >= MAX_RECOVERIES {
            return None;
        }
        let mut next = self.clone();
        next.recoveries += 1;
        next.request.submission_id = format!("{SUBMISSION_PREFIX}{}", Uuid::new_v4());
        next.request.execution_secret = Some(new_execution_secret());
        next.request.thread_id = Some(thread_id);
        next.request.repository_key = None;
        next.request.continuation_of_run_id = Some(run_id);
        next.request.prompt.clear();
        next.request.storage_ids.clear();
        Some(next)
    }
}

pub(crate) fn new_execution_secret() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

pub(crate) struct RunRecovery {
    path: std::path::PathBuf,
    records: AsyncMutex<BTreeMap<String, RecoveryRecord>>,
    active: Arc<Mutex<HashMap<String, usize>>>,
}

pub(crate) struct ActiveRun {
    key: String,
    active: Arc<Mutex<HashMap<String, usize>>>,
}

impl Drop for ActiveRun {
    fn drop(&mut self) {
        let mut active = self.active.lock().unwrap();
        if let Some(count) = active.get_mut(&self.key) {
            *count -= 1;
            if *count == 0 {
                active.remove(&self.key);
            }
        }
    }
}

impl RunRecovery {
    pub(crate) fn load(data_dir: &Path) -> anyhow::Result<Arc<Self>> {
        let path = data_dir.join("run-recovery.json");
        let records: BTreeMap<String, RecoveryRecord> = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
            Err(error) => return Err(error.into()),
        };
        if records.len() > MAX_RECORDS {
            anyhow::bail!("Too many saved run recovery records.");
        }
        Ok(Arc::new(Self {
            path,
            records: AsyncMutex::new(records),
            active: Arc::new(Mutex::new(HashMap::new())),
        }))
    }

    // The guard outlives the detached executor. Duplicate HTTP submissions may
    // reconcile the same run; Convex still allows only one executor claim.
    pub(crate) async fn begin(
        self: &Arc<Self>,
        record: RecoveryRecord,
    ) -> anyhow::Result<ActiveRun> {
        let key = record.key();
        let guard = self
            .track(key.clone(), false)
            .expect("shared run reservation");
        // A caller retry must retain the original capability and retry budget.
        self.update(key, Some(record), true).await?;
        Ok(guard)
    }

    fn track(&self, key: String, exclusive: bool) -> Option<ActiveRun> {
        let mut active = self.active.lock().unwrap();
        if exclusive && active.contains_key(&key) {
            return None;
        }
        *active.entry(key.clone()).or_default() += 1;
        Some(ActiveRun {
            key,
            active: Arc::clone(&self.active),
        })
    }

    pub(crate) async fn saved(&self, user_id: &str, submission_id: &str) -> Option<RecoveryRecord> {
        self.records
            .lock()
            .await
            .get(&format!("{user_id}:{submission_id}"))
            .cloned()
    }

    async fn replace(
        self: &Arc<Self>,
        key: &str,
        replacement: Option<RecoveryRecord>,
    ) -> anyhow::Result<()> {
        self.update(key.to_string(), replacement, false).await
    }

    async fn update(
        self: &Arc<Self>,
        key: String,
        replacement: Option<RecoveryRecord>,
        only_if_absent: bool,
    ) -> anyhow::Result<()> {
        let store = Arc::clone(self);
        // Keep the lock through both the disk write and memory commit even if
        // the requesting HTTP handler or recovery worker is dropped.
        tokio::spawn(async move {
            let mut records = store.records.lock().await;
            if only_if_absent && records.contains_key(&key) {
                return anyhow::Ok(());
            }
            let mut next = records.clone();
            if !only_if_absent {
                next.remove(&key);
            }
            if let Some(record) = replacement {
                if !next.contains_key(&record.key()) && next.len() >= MAX_RECORDS {
                    anyhow::bail!("Too many runs awaiting recovery.");
                }
                next.entry(record.key()).or_insert(record);
            }
            store.persist(&next).await?;
            *records = next;
            anyhow::Ok(())
        })
        .await?
    }

    async fn persist(&self, records: &BTreeMap<String, RecoveryRecord>) -> anyhow::Result<()> {
        let path = self.path.clone();
        let bytes = serde_json::to_vec(records)?;
        tokio::task::spawn_blocking(move || crate::profile::write_private_file(&path, &bytes))
            .await?
    }
}

#[derive(Deserialize)]
#[serde(tag = "state", rename_all = "camelCase")]
enum RecoveryState {
    Discard,
    Pending,
    Missing,
    Recover {
        #[serde(rename = "runId")]
        run_id: String,
        #[serde(rename = "threadId")]
        thread_id: String,
    },
}

async fn recover_one(state: &AppState, record: RecoveryRecord) -> anyhow::Result<()> {
    let key = record.key();
    let Some(reservation) = state.run_recovery.track(key.clone(), true) else {
        return Ok(());
    };
    if crate::now_ms().saturating_sub(record.created_at) >= MAX_AGE_MS {
        return state.run_recovery.replace(&key, None).await;
    }
    let recovery: RecoveryState = timeout(RPC_TIMEOUT, async {
        let client = state.convex_client_for(&record.request.user_id).await?;
        let mut args = BTreeMap::from([
            (
                "submissionId".into(),
                record.request.submission_id.clone().into(),
            ),
            (
                "machineId".into(),
                state.machine_identity.installation_id.clone().into(),
            ),
        ]);
        if let Some(parent) = &record.request.continuation_of_run_id {
            args.insert("continuationOfRunId".into(), parent.clone().into());
        }
        client.query("runRecovery:state", args).await
    })
    .await??;
    match recovery {
        RecoveryState::Pending => return Ok(()),
        RecoveryState::Discard => return state.run_recovery.replace(&key, None).await,
        RecoveryState::Missing if record.recoveries > 0 => {}
        RecoveryState::Missing => return state.run_recovery.replace(&key, None).await,
        RecoveryState::Recover { run_id, thread_id } => {
            let Some(next) = record.continuation(run_id, thread_id) else {
                return state.run_recovery.replace(&key, None).await;
            };
            // Persist the new id and capability before submitting it. Replaying
            // this record after a crash reconciles that exact submission.
            state.run_recovery.replace(&key, Some(next.clone())).await?;
            return launch_recovery(state.clone(), next).await;
        }
    }
    drop(reservation);
    launch_recovery(state.clone(), record).await
}

pub(crate) fn spawn(state: AppState) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut ticks = interval(Duration::from_millis(RETRY_DELAY_MS));
        ticks.set_missed_tick_behavior(MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                biased;
                _ = state.lifetime.shutdown.cancelled() => return,
                _ = ticks.tick() => {}
            }
            let records = state
                .run_recovery
                .records
                .lock()
                .await
                .values()
                .cloned()
                .collect::<Vec<_>>();
            let mut recoveries = futures::stream::iter(records)
                .map(|record| recover_one(&state, record))
                .buffer_unordered(4);
            loop {
                tokio::select! {
                    biased;
                    _ = state.lifetime.shutdown.cancelled() => return,
                    result = recoveries.next() => {
                        match result {
                            Some(Err(error)) => tracing::warn!("automatic run recovery deferred: {error:#}"),
                            Some(Ok(())) => {},
                            None => break,
                        }
                    }
                }
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record() -> RecoveryRecord {
        RecoveryRecord::new(
            serde_json::from_value(serde_json::json!({
                "userId": "alice", "submissionId": "submission", "threadId": "thread",
                "prompt": "build it", "storageIds": ["image"], "selectedModel": "model",
                "reasoningEffort": "high", "fastMode": true, "workspacePath": "/work",
                "executionSecret": "secret"
            }))
            .unwrap(),
            WorkspaceAccess::Attached,
            true,
        )
    }

    #[tokio::test]
    async fn reload_preserves_capability_and_budget_but_releases_live_reservations() {
        let directory = tempfile::tempdir().unwrap();
        let store = RunRecovery::load(directory.path()).unwrap();
        let next = record()
            .continuation("failed".into(), "thread".into())
            .unwrap();
        let guard = store.begin(next.clone()).await.unwrap();
        let duplicate = store.begin(next.clone()).await.unwrap();
        assert!(store.track(next.key(), true).is_none());
        drop(guard);
        assert!(store.track(next.key(), true).is_none());
        drop(duplicate);
        assert!(store.track(next.key(), true).is_some());
        let reloaded = RunRecovery::load(directory.path()).unwrap();
        let saved = reloaded
            .saved("alice", &next.request.submission_id)
            .await
            .unwrap();
        assert_eq!(saved.recoveries, 1);
        assert_eq!(
            saved.request.execution_secret,
            next.request.execution_secret
        );
        assert_eq!(
            saved.request.continuation_of_run_id.as_deref(),
            Some("failed")
        );
        assert!(saved.request.prompt.is_empty());
        assert!(saved.request.storage_ids.is_empty());
        assert_eq!(saved.request.workspace_path, "/work");
        assert_eq!(saved.request.reasoning_effort, "high");
        assert!(saved.request.fast_mode);
        assert!(reloaded.begin(saved).await.is_ok());
    }

    #[tokio::test]
    async fn dropping_a_caller_does_not_interrupt_the_disk_and_memory_commit() {
        let directory = tempfile::tempdir().unwrap();
        let store = RunRecovery::load(directory.path()).unwrap();
        let held = store.records.lock().await;
        let writer = tokio::spawn({
            let store = Arc::clone(&store);
            async move { store.begin(record()).await }
        });
        // Let begin reserve its submission and enqueue the detached update
        // behind our held lock before cancelling the requesting task.
        tokio::task::yield_now().await;
        tokio::task::yield_now().await;
        assert!(store.active.lock().unwrap().contains_key(&record().key()));
        writer.abort();
        let _ = writer.await;
        drop(held);
        assert!(store.saved("alice", "submission").await.is_some());
        assert!(
            RunRecovery::load(directory.path())
                .unwrap()
                .saved("alice", "submission")
                .await
                .is_some()
        );
        assert!(!store.active.lock().unwrap().contains_key(&record().key()));
    }

    #[tokio::test]
    async fn replacement_is_durable_and_recovery_is_bounded() {
        let directory = tempfile::tempdir().unwrap();
        let store = RunRecovery::load(directory.path()).unwrap();
        let original = record();
        drop(store.begin(original.clone()).await.unwrap());
        let mut next = original.clone();
        for _ in 0..MAX_RECOVERIES {
            next = next.continuation("failed".into(), "thread".into()).unwrap();
        }
        assert!(
            next.continuation("failed".into(), "thread".into())
                .is_none()
        );
        store
            .replace(&original.key(), Some(next.clone()))
            .await
            .unwrap();
        let reloaded = RunRecovery::load(directory.path()).unwrap();
        assert!(reloaded.saved("alice", "submission").await.is_none());
        assert!(
            reloaded
                .saved("alice", &next.request.submission_id)
                .await
                .is_some()
        );
        reloaded.replace(&next.key(), None).await.unwrap();
        assert!(
            RunRecovery::load(directory.path())
                .unwrap()
                .records
                .lock()
                .await
                .is_empty()
        );
    }
}
