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

use crate::Host;
use crate::agent_launch::{AgentLaunchRequest, WorkspaceAccess, launch_recovery};

const MAX_RECOVERIES: u8 = 3;
const MAX_RECORDS: usize = 256;
const MAX_AGE_MS: u64 = 24 * 60 * 60 * 1000;
const RETRY_DELAY_MS: u64 = 30_000;
const RPC_TIMEOUT: Duration = Duration::from_secs(15);
// Must match apps/web/convex/lib/runRecovery.ts.
const SUBMISSION_PREFIX: &str = "automatic-recovery:";

#[derive(Clone, Serialize, Deserialize)]
pub struct RecoveryRecord {
    pub request: AgentLaunchRequest,
    pub workspace_access: WorkspaceAccess,
    pub allow_interaction: bool,
    recoveries: u8,
    created_at: u64,
}

impl RecoveryRecord {
    pub fn new(
        mut request: AgentLaunchRequest,
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

fn new_execution_secret() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

pub struct RunRecovery {
    path: std::path::PathBuf,
    records: AsyncMutex<BTreeMap<String, RecoveryRecord>>,
    active: Arc<Mutex<HashMap<String, usize>>>,
}

pub struct ActiveRun {
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

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum RunOwner {
    /// The CLI awaits the run's result and controls its cancellation, so a
    /// recovered continuation could not stand in for it.
    Client,
    Host,
}

impl RunRecovery {
    pub fn load(data_dir: &Path) -> anyhow::Result<Arc<Self>> {
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

    pub async fn begin(
        self: &Arc<Self>,
        mut record: RecoveryRecord,
        owner: RunOwner,
    ) -> anyhow::Result<(Option<ActiveRun>, RecoveryRecord)> {
        if owner == RunOwner::Client {
            record
                .request
                .execution_secret
                .get_or_insert_with(new_execution_secret);
            return Ok((None, record));
        }
        let guard = self.share(record.key());
        let saved = self.insert_if_absent(record).await?;
        Ok((Some(guard), saved))
    }

    fn share(&self, key: String) -> ActiveRun {
        *self.active.lock().unwrap().entry(key.clone()).or_default() += 1;
        ActiveRun {
            key,
            active: Arc::clone(&self.active),
        }
    }

    fn reserve_exclusive(&self, key: String) -> Option<ActiveRun> {
        let mut active = self.active.lock().unwrap();
        if active.contains_key(&key) {
            return None;
        }
        active.insert(key.clone(), 1);
        Some(ActiveRun {
            key,
            active: Arc::clone(&self.active),
        })
    }

    async fn insert_if_absent(
        self: &Arc<Self>,
        record: RecoveryRecord,
    ) -> anyhow::Result<RecoveryRecord> {
        let store = Arc::clone(self);
        crate::run_to_completion(async move {
            let mut records = store.records.lock().await;
            if let Some(saved) = records.get(&record.key()) {
                return anyhow::Ok(saved.clone());
            }
            let mut next = records.clone();
            let saved = insert_with_capability(&mut next, record)?;
            store.persist(&next).await?;
            *records = next;
            anyhow::Ok(saved)
        })
        .await?
    }

    async fn replace(
        self: &Arc<Self>,
        key: &str,
        replacement: Option<RecoveryRecord>,
    ) -> anyhow::Result<()> {
        let store = Arc::clone(self);
        let key = key.to_string();
        crate::run_to_completion(async move {
            let mut records = store.records.lock().await;
            let mut next = records.clone();
            next.remove(&key);
            if let Some(record) = replacement {
                insert_with_capability(&mut next, record)?;
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

fn insert_with_capability(
    records: &mut BTreeMap<String, RecoveryRecord>,
    mut record: RecoveryRecord,
) -> anyhow::Result<RecoveryRecord> {
    if !records.contains_key(&record.key()) && records.len() >= MAX_RECORDS {
        anyhow::bail!("Too many runs awaiting recovery.");
    }
    record
        .request
        .execution_secret
        .get_or_insert_with(new_execution_secret);
    Ok(records.entry(record.key()).or_insert(record).clone())
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

async fn recover_one(host: &Host, record: RecoveryRecord) -> anyhow::Result<()> {
    let key = record.key();
    let Some(reservation) = host.run_recovery.reserve_exclusive(key.clone()) else {
        return Ok(());
    };
    if crate::now_ms().saturating_sub(record.created_at) >= MAX_AGE_MS {
        return host.run_recovery.replace(&key, None).await;
    }
    let recovery: RecoveryState = timeout(RPC_TIMEOUT, async {
        let client = host.convex_client_for(&record.request.user_id).await?;
        let mut args = BTreeMap::from([
            (
                "submissionId".into(),
                record.request.submission_id.clone().into(),
            ),
            (
                "machineId".into(),
                host.machine_identity.installation_id.clone().into(),
            ),
        ]);
        if let Some(parent) = &record.request.continuation_of_run_id {
            args.insert("continuationOfRunId".into(), parent.clone().into());
        }
        client.query("runRecovery:state", args).await
    })
    .await??;
    let next = match recovery {
        RecoveryState::Pending => return Ok(()),
        RecoveryState::Discard => return host.run_recovery.replace(&key, None).await,
        RecoveryState::Missing if record.recoveries > 0 => record,
        RecoveryState::Missing => return host.run_recovery.replace(&key, None).await,
        RecoveryState::Recover { run_id, thread_id } => {
            let Some(next) = record.continuation(run_id, thread_id) else {
                return host.run_recovery.replace(&key, None).await;
            };
            // Persist the new id and capability before submitting it. Replaying
            // this record after a crash reconciles that exact submission.
            host.run_recovery.replace(&key, Some(next.clone())).await?;
            next
        }
    };
    drop(reservation);
    timeout(RPC_TIMEOUT, launch_recovery(host.clone(), next)).await?
}

pub fn spawn(host: Host) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut ticks = interval(Duration::from_millis(RETRY_DELAY_MS));
        ticks.set_missed_tick_behavior(MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                biased;
                _ = host.lifetime.shutdown.cancelled() => return,
                _ = ticks.tick() => {}
            }
            let records = host
                .run_recovery
                .records
                .lock()
                .await
                .values()
                .cloned()
                .collect::<Vec<_>>();
            let mut recoveries = futures::stream::iter(records)
                .map(|record| recover_one(&host, record))
                .buffer_unordered(4);
            loop {
                tokio::select! {
                    biased;
                    _ = host.lifetime.shutdown.cancelled() => return,
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
mod tests;
