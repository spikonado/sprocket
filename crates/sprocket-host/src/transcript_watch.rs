use std::sync::{Arc, Mutex};
use std::time::Duration;

use sprocket_transcript::TranscriptStore;
use tokio::sync::broadcast::{self, error::RecvError};
use tokio::sync::{OnceCell, watch};
use tokio::task::JoinHandle;

use crate::convex_clients::ConvexClients;
use crate::transcript_client::retry_after_failure;
use crate::watch_registry::{WatchRegistry, WatchSession};
use crate::work_sync::{RunStart, SyncMode};

const RECONCILE_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptWatchEvent {
    pub event_type: &'static str,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum TranscriptSyncStatus {
    Connecting,
    Ready,
    Unavailable,
}

impl TranscriptWatchEvent {
    pub const UPDATED: Self = Self {
        event_type: "updated",
    };
}

#[derive(Clone, PartialEq, Eq, Hash)]
struct WatchKey {
    user_id: String,
    thread_id: String,
}

type WatchStarter = Arc<dyn Fn(WatchStart) -> JoinHandle<()> + Send + Sync>;

struct WatchStart {
    convex: Arc<ConvexClients>,
    store: Arc<TranscriptStore>,
    user_id: String,
    thread_id: String,
    events: broadcast::Sender<TranscriptWatchEvent>,
    modes: watch::Receiver<SyncMode>,
    status: watch::Sender<TranscriptSyncStatus>,
}

struct SessionState {
    runs: Mutex<usize>,
    modes: watch::Sender<SyncMode>,
    status: watch::Sender<TranscriptSyncStatus>,
}

impl SessionState {
    fn acquire_run(&self) -> Arc<RunStart> {
        let mut runs = self.runs.lock().unwrap_or_else(|error| error.into_inner());
        let mode = self.modes.borrow().clone();
        let start = match mode {
            SyncMode::Local(start) => start,
            SyncMode::Remote => {
                let start = Arc::new(RunStart::default());
                self.modes.send_replace(SyncMode::Local(Arc::clone(&start)));
                start
            }
        };
        *runs += 1;
        start
    }

    fn release_run(&self) {
        let mut runs = self.runs.lock().unwrap_or_else(|error| error.into_inner());
        *runs -= 1;
        if *runs == 0 {
            self.modes.send_replace(SyncMode::Remote);
        }
    }
}

type Registry = WatchRegistry<WatchKey, TranscriptWatchEvent, Arc<SessionState>>;
type Session = WatchSession<WatchKey, TranscriptWatchEvent, Arc<SessionState>>;

pub struct TranscriptWatchers {
    convex: Arc<ConvexClients>,
    store: Arc<TranscriptStore>,
    registry: Arc<Registry>,
    start: WatchStarter,
}

pub struct TranscriptWatchSession {
    session: Session,
    state: Arc<SessionState>,
}

pub struct TranscriptRunSession {
    watchers: Arc<TranscriptWatchers>,
    key: WatchKey,
    state: Arc<SessionState>,
    start: Arc<RunStart>,
    _session: Session,
}

impl TranscriptWatchers {
    pub fn new(convex: Arc<ConvexClients>, store: Arc<TranscriptStore>) -> Arc<Self> {
        Self::with_starter(convex, store, Arc::new(spawn_convex_watch))
    }

    fn with_starter(
        convex: Arc<ConvexClients>,
        store: Arc<TranscriptStore>,
        start: WatchStarter,
    ) -> Arc<Self> {
        Arc::new(Self {
            convex,
            store,
            registry: WatchRegistry::new(),
            start,
        })
    }

    pub async fn open(self: &Arc<Self>, user_id: &str, thread_id: &str) -> TranscriptWatchSession {
        let (session, state) = self.open_session(key(user_id, thread_id), SyncMode::Remote);
        TranscriptWatchSession { session, state }
    }

    fn open_session(
        self: &Arc<Self>,
        key: WatchKey,
        mode: SyncMode,
    ) -> (Session, Arc<SessionState>) {
        self.registry.open_with(
            key.clone(),
            16,
            || {
                Arc::new(SessionState {
                    runs: Mutex::new(0),
                    modes: watch::channel(mode).0,
                    status: watch::channel(TranscriptSyncStatus::Connecting).0,
                })
            },
            |events, state| {
                (self.start)(WatchStart {
                    convex: Arc::clone(&self.convex),
                    store: Arc::clone(&self.store),
                    user_id: key.user_id.clone(),
                    thread_id: key.thread_id.clone(),
                    events,
                    modes: state.modes.subscribe(),
                    status: state.status.clone(),
                })
            },
        )
    }

    /// Open before the run starts saving parts, and call [`TranscriptRunSession::finish`]
    /// when it ends.
    pub async fn open_run(
        self: &Arc<Self>,
        user_id: &str,
        thread_id: &str,
    ) -> TranscriptRunSession {
        let key = key(user_id, thread_id);
        let (session, state) =
            self.open_session(key.clone(), SyncMode::Local(Arc::new(RunStart::default())));
        let start = state.acquire_run();
        let run = TranscriptRunSession {
            watchers: Arc::clone(self),
            key,
            state,
            start,
            _session: session,
        };
        if let Err(error) = run.start.wait_until_paused().await {
            tracing::warn!("could not pause transcript subscription for {thread_id}: {error:#}");
        }
        run.start
            .initialize(thread_id, || async {
                self.convex
                    .client_for(user_id)
                    .await?
                    .transcript_total_parts(thread_id)
                    .await
            })
            .await;
        run
    }
}

fn key(user_id: &str, thread_id: &str) -> WatchKey {
    WatchKey {
        user_id: user_id.to_owned(),
        thread_id: thread_id.to_owned(),
    }
}

impl TranscriptRunSession {
    /// Downloads the parts Convex saved during the run without this machine, such as
    /// cancellations.
    pub async fn finish(self) {
        let from = self.start.total.get().copied().flatten().unwrap_or(0);
        let WatchKey { user_id, thread_id } = &self.key;
        let reconcile = async {
            let client = self.watchers.convex.client_for(user_id).await?;
            crate::work_sync::reconcile(&client, &self.watchers.store, user_id, thread_id, from)
                .await
        };
        match tokio::time::timeout(RECONCILE_TIMEOUT, reconcile).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                tracing::warn!("could not download the end of the run in {thread_id}: {error:#}");
            }
            Err(_) => tracing::warn!("timed out downloading the end of the run in {thread_id}"),
        }
    }
}

impl Drop for TranscriptRunSession {
    fn drop(&mut self) {
        self.state.release_run();
    }
}

impl TranscriptWatchSession {
    pub fn stale(&self) -> bool {
        *self.state.status.borrow() == TranscriptSyncStatus::Unavailable
    }

    pub fn receiver(&mut self) -> &mut broadcast::Receiver<TranscriptWatchEvent> {
        self.session.receiver()
    }
}

fn spawn_convex_watch(start: WatchStart) -> JoinHandle<()> {
    let changes = start.store.watch_changes();
    tokio::spawn(async move {
        let lease = OnceCell::new();
        let synchronize = crate::work_sync::follow_modes(start.modes.clone(), |mode| {
            let start = &start;
            let lease = &lease;
            async move {
                loop {
                    let result = async {
                        lease
                            .get_or_try_init(|| {
                                start.store.open_thread(&start.user_id, &start.thread_id)
                            })
                            .await?;
                        run_watch_loop(start, &mode).await
                    }
                    .await;
                    if let Err(error) = result {
                        start.status.send_replace(TranscriptSyncStatus::Unavailable);
                        tracing::warn!(
                            "transcript watch for {} failed; retrying: {error:#}",
                            start.thread_id
                        );
                        retry_after_failure().await;
                    }
                }
            }
        });
        let _ = tokio::join!(synchronize, forward_changes(&start, changes));
    })
}

async fn forward_changes(start: &WatchStart, mut changes: broadcast::Receiver<(String, String)>) {
    let mut status = start.status.subscribe();
    loop {
        tokio::select! {
            result = status.changed() => {
                if result.is_err() { return; }
                let _ = start.events.send(TranscriptWatchEvent::UPDATED);
            }
            change = changes.recv() => match change {
                Ok((user, thread)) if user != start.user_id || thread != start.thread_id => {}
                Err(RecvError::Closed) => return,
                Ok(_) | Err(RecvError::Lagged(_)) => {
                    let _ = start.events.send(TranscriptWatchEvent::UPDATED);
                }
            }
        }
    }
}

async fn run_watch_loop(start: &WatchStart, mode: &SyncMode) -> anyhow::Result<()> {
    let client = start.convex.client_for(&start.user_id).await?;
    crate::work_sync::synchronize(
        &client,
        &start.store,
        &start.user_id,
        &start.thread_id,
        mode,
        &start.status,
    )
    .await
}

#[cfg(test)]
mod tests;
