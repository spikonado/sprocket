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
const MAX_USAGE_LIMIT_RESUMPTIONS: u8 = 8;
const MAX_RECORDS: usize = 256;
const MAX_AGE_MS: u64 = 24 * 60 * 60 * 1000;
const MAX_USAGE_LIMIT_AGE_MS: u64 = 8 * MAX_AGE_MS;
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
    #[serde(default)]
    usage_limit_started_at: Option<u64>,
    #[serde(default)]
    usage_limit_resumptions: u8,
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
            usage_limit_started_at: None,
            usage_limit_resumptions: 0,
        }
    }

    fn key(&self) -> String {
        format!("{}:{}", self.request.user_id, self.request.submission_id)
    }

    fn continuation(&self, run_id: String, thread_id: String, usage_limit: bool) -> Option<Self> {
        if (usage_limit && self.usage_limit_resumptions >= MAX_USAGE_LIMIT_RESUMPTIONS)
            || (!usage_limit && self.recoveries >= MAX_RECOVERIES)
        {
            return None;
        }
        let mut next = self.clone();
        if usage_limit {
            next.usage_limit_resumptions += 1;
            next.usage_limit_started_at
                .get_or_insert_with(crate::now_ms);
        } else {
            next.recoveries += 1;
        }
        next.request.submission_id = format!("{SUBMISSION_PREFIX}{}", Uuid::new_v4());
        next.request.execution_secret = Some(new_execution_secret());
        next.request.thread_id = Some(thread_id);
        next.request.repository_key = None;
        next.request.continuation_of_run_id = Some(run_id);
        next.request.prompt.clear();
        next.request.storage_ids.clear();
        Some(next)
    }

    fn expired(&self, now: u64) -> bool {
        let (started_at, max_age) = self
            .usage_limit_started_at
            .map(|started_at| (started_at, MAX_USAGE_LIMIT_AGE_MS))
            .unwrap_or((self.created_at, MAX_AGE_MS));
        now.saturating_sub(started_at) >= max_age
    }
}

fn new_execution_secret() -> String {
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
        mut record: RecoveryRecord,
        client_bound: bool,
    ) -> anyhow::Result<(Option<ActiveRun>, RecoveryRecord)> {
        // CLI runs report a final result to their client and use that client's
        // cancellation token. A detached continuation would lose both, so
        // these runs must never enter the persistent recovery journal.
        if client_bound {
            record
                .request
                .execution_secret
                .get_or_insert_with(new_execution_secret);
            return Ok((None, record));
        }
        let key = record.key();
        let guard = self
            .track(key.clone(), false)
            .expect("shared run reservation");
        // A caller retry must retain the original capability and retry budget.
        let saved = self
            .update(key, Some(record), true)
            .await?
            .expect("begin saves a recovery record");
        Ok((Some(guard), saved))
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

    #[cfg(test)]
    async fn saved(&self, user_id: &str, submission_id: &str) -> Option<RecoveryRecord> {
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
        self.update(key.to_string(), replacement, false)
            .await
            .map(|_| ())
    }

    async fn update(
        self: &Arc<Self>,
        key: String,
        replacement: Option<RecoveryRecord>,
        only_if_absent: bool,
    ) -> anyhow::Result<Option<RecoveryRecord>> {
        let store = Arc::clone(self);
        // Keep the lock through both the disk write and memory commit even if
        // the requesting HTTP handler or recovery worker is dropped.
        tokio::spawn(async move {
            let mut records = store.records.lock().await;
            if only_if_absent && let Some(saved) = records.get(&key) {
                return anyhow::Ok(Some(saved.clone()));
            }
            let mut next = records.clone();
            if !only_if_absent {
                next.remove(&key);
            }
            let saved = if let Some(mut record) = replacement {
                if !next.contains_key(&record.key()) && next.len() >= MAX_RECORDS {
                    anyhow::bail!("Too many runs awaiting recovery.");
                }
                // Select the capability while holding the journal lock, and
                // return this same persisted value to every overlapping launch.
                record
                    .request
                    .execution_secret
                    .get_or_insert_with(new_execution_secret);
                Some(next.entry(record.key()).or_insert(record).clone())
            } else {
                None
            };
            store.persist(&next).await?;
            *records = next;
            anyhow::Ok(saved)
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
    Waiting,
    Missing,
    Recover {
        #[serde(rename = "runId")]
        run_id: String,
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "providerUsageLimit", default)]
        provider_usage_limit: bool,
    },
}

async fn recover_one(state: &AppState, record: RecoveryRecord) -> anyhow::Result<()> {
    let key = record.key();
    let Some(reservation) = state.run_recovery.track(key.clone(), true) else {
        return Ok(());
    };
    if crate::now_ms().saturating_sub(record.created_at) >= MAX_USAGE_LIMIT_AGE_MS
        && record.usage_limit_started_at.is_none()
    {
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
            ("supportsUsageLimitResume".into(), true.into()),
        ]);
        if let Some(parent) = &record.request.continuation_of_run_id {
            args.insert("continuationOfRunId".into(), parent.clone().into());
        }
        client.query("runRecovery:state", args).await
    })
    .await??;
    let mut record = record;
    if matches!(
        recovery,
        RecoveryState::Waiting
            | RecoveryState::Recover {
                provider_usage_limit: true,
                ..
            }
    ) && record.usage_limit_started_at.is_none()
    {
        record.usage_limit_started_at = Some(crate::now_ms());
        state
            .run_recovery
            .replace(&key, Some(record.clone()))
            .await?;
    }
    if record.expired(crate::now_ms()) {
        return state.run_recovery.replace(&key, None).await;
    }
    let next = match recovery {
        RecoveryState::Pending | RecoveryState::Waiting => return Ok(()),
        RecoveryState::Discard => return state.run_recovery.replace(&key, None).await,
        RecoveryState::Missing if record.recoveries > 0 || record.usage_limit_resumptions > 0 => {
            record
        }
        RecoveryState::Missing => return state.run_recovery.replace(&key, None).await,
        RecoveryState::Recover {
            run_id,
            thread_id,
            provider_usage_limit,
        } => {
            let Some(next) = record.continuation(run_id, thread_id, provider_usage_limit) else {
                return state.run_recovery.replace(&key, None).await;
            };
            // Persist the new id and capability before submitting it. Replaying
            // this record after a crash reconciles that exact submission.
            state.run_recovery.replace(&key, Some(next.clone())).await?;
            next
        }
    };
    drop(reservation);
    timeout(RPC_TIMEOUT, launch_recovery(state.clone(), next)).await?
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
            .continuation("failed".into(), "thread".into(), false)
            .unwrap();
        let (_guard, _) = store.begin(next.clone(), false).await.unwrap();
        assert!(store.track(next.key(), true).is_none());
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
        assert!(reloaded.track(next.key(), true).is_some());
    }

    #[tokio::test]
    async fn overlapping_submissions_launch_with_the_persisted_capability() {
        for supplied_secrets in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let store = RunRecovery::load(directory.path()).unwrap();
            let mut first = record()
                .continuation("failed".into(), "thread".into(), false)
                .unwrap();
            first.request.execution_secret = supplied_secrets.then(|| "first".into());
            let mut second = first.clone();
            second.request.execution_secret = supplied_secrets.then(|| "second".into());
            // A retry must also preserve the original retry budget.
            second.recoveries = 0;
            let (first_launch, second_launch) = tokio::join!(
                store.begin(first.clone(), false),
                store.begin(second, false)
            );
            let (first_guard, first_saved) = first_launch.unwrap();
            let (second_guard, second_saved) = second_launch.unwrap();
            let persisted = RunRecovery::load(directory.path())
                .unwrap()
                .saved("alice", &first.request.submission_id)
                .await
                .unwrap();
            assert!(persisted.request.execution_secret.is_some());
            assert_eq!(
                first_saved.request.execution_secret,
                persisted.request.execution_secret
            );
            assert_eq!(
                second_saved.request.execution_secret,
                persisted.request.execution_secret
            );
            assert_eq!(first_saved.recoveries, persisted.recoveries);
            assert_eq!(second_saved.recoveries, persisted.recoveries);
            assert!(store.track(first.key(), true).is_none());
            drop(first_guard);
            assert!(store.track(first.key(), true).is_none());
            drop(second_guard);
            assert!(store.track(first.key(), true).is_some());
        }
    }

    #[tokio::test]
    async fn client_bound_runs_never_enter_the_recovery_journal() {
        let directory = tempfile::tempdir().unwrap();
        let store = RunRecovery::load(directory.path()).unwrap();
        let mut candidate = record();
        candidate.workspace_access = WorkspaceAccess::RunDirectory;
        candidate.allow_interaction = false;
        candidate.request.execution_secret = None;
        let (guard, prepared) = store.begin(candidate.clone(), true).await.unwrap();
        assert!(guard.is_none());
        assert!(prepared.request.execution_secret.is_some());
        assert!(store.records.lock().await.is_empty());
        assert!(store.active.lock().unwrap().is_empty());
        assert!(!directory.path().join("run-recovery.json").exists());
        assert!(
            RunRecovery::load(directory.path())
                .unwrap()
                .records
                .lock()
                .await
                .is_empty()
        );
        // A native subagent uses the same workspace mode but has a durable
        // cloud result, so it remains eligible for automatic recovery.
        candidate.allow_interaction = true;
        let (guard, _) = store.begin(candidate, false).await.unwrap();
        assert!(guard.is_some());
        assert_eq!(store.records.lock().await.len(), 1);
    }

    #[tokio::test]
    async fn dropping_a_caller_does_not_interrupt_the_disk_and_memory_commit() {
        let directory = tempfile::tempdir().unwrap();
        let store = RunRecovery::load(directory.path()).unwrap();
        let held = store.records.lock().await;
        let writer = tokio::spawn({
            let store = Arc::clone(&store);
            async move { store.begin(record(), false).await }
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
    async fn usage_limit_wait_and_retry_budget_survive_restart() {
        let directory = tempfile::tempdir().unwrap();
        let store = RunRecovery::load(directory.path()).unwrap();
        let mut waiting = record();
        waiting.created_at = 10;
        waiting.usage_limit_started_at = Some(20);
        assert!(!waiting.expired(MAX_AGE_MS + 20));
        assert!(waiting.expired(MAX_USAGE_LIMIT_AGE_MS + 20));
        for _ in 0..MAX_USAGE_LIMIT_RESUMPTIONS {
            waiting = waiting
                .continuation("quota-run".into(), "thread".into(), true)
                .unwrap();
        }
        assert!(
            waiting
                .continuation("quota-run".into(), "thread".into(), true)
                .is_none()
        );
        assert_eq!(waiting.recoveries, 0);
        drop(store.begin(waiting.clone(), false).await.unwrap());
        let reloaded = RunRecovery::load(directory.path()).unwrap();
        let saved = reloaded
            .saved("alice", &waiting.request.submission_id)
            .await
            .unwrap();
        assert_eq!(saved.usage_limit_started_at, waiting.usage_limit_started_at);
        assert_eq!(saved.usage_limit_resumptions, MAX_USAGE_LIMIT_RESUMPTIONS);
        assert!(
            saved
                .continuation("abandoned".into(), "thread".into(), false)
                .is_some()
        );
    }

    #[test]
    fn old_recovery_records_keep_their_original_deadline() {
        let mut value = serde_json::to_value(record()).unwrap();
        value
            .as_object_mut()
            .unwrap()
            .remove("usage_limit_started_at");
        value
            .as_object_mut()
            .unwrap()
            .remove("usage_limit_resumptions");
        let saved: RecoveryRecord = serde_json::from_value(value).unwrap();
        assert_eq!(saved.usage_limit_resumptions, 0);
        assert_eq!(saved.usage_limit_started_at, None);
        assert!(saved.expired(saved.created_at + MAX_AGE_MS));
    }

    #[tokio::test]
    async fn replacement_is_durable_and_recovery_is_bounded() {
        let directory = tempfile::tempdir().unwrap();
        let store = RunRecovery::load(directory.path()).unwrap();
        let original = record();
        drop(store.begin(original.clone(), false).await.unwrap());
        let mut next = original.clone();
        for _ in 0..MAX_RECOVERIES {
            next = next
                .continuation("failed".into(), "thread".into(), false)
                .unwrap();
        }
        assert!(
            next.continuation("failed".into(), "thread".into(), false)
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
