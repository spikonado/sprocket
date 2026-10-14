use std::sync::Arc;

use sprocket_agent::TranscriptStore;
use tokio::sync::broadcast;
use tokio::task::JoinHandle;

use crate::native_auth::NativeAuthManager;
use crate::transcript_client::{UserConvexClient, retry_after_failure};
use crate::watch_registry::{WatchRegistry, WatchSession};

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptWatchEvent {
    pub event_type: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_parts: Option<u32>,
    pub stale: bool,
}

#[derive(Clone, PartialEq, Eq, Hash)]
struct WatchKey {
    user_id: String,
    thread_id: String,
}

type WatchStarter = Arc<dyn Fn(WatchStart) -> JoinHandle<()> + Send + Sync>;

struct WatchStart {
    deployment_url: String,
    store: Arc<TranscriptStore>,
    native_auth: Arc<NativeAuthManager>,
    user_id: String,
    thread_id: String,
    events: broadcast::Sender<TranscriptWatchEvent>,
}

pub struct TranscriptWatchers {
    deployment_url: String,
    store: Arc<TranscriptStore>,
    native_auth: Arc<NativeAuthManager>,
    registry: Arc<WatchRegistry<WatchKey, TranscriptWatchEvent>>,
    start: WatchStarter,
}

pub struct TranscriptWatchSession {
    session: WatchSession<WatchKey, TranscriptWatchEvent>,
}

impl TranscriptWatchers {
    pub(crate) fn new(
        deployment_url: String,
        store: Arc<TranscriptStore>,
        native_auth: Arc<NativeAuthManager>,
    ) -> Arc<Self> {
        Self::with_starter(
            deployment_url,
            store,
            native_auth,
            Arc::new(spawn_convex_watch),
        )
    }

    fn with_starter(
        deployment_url: String,
        store: Arc<TranscriptStore>,
        native_auth: Arc<NativeAuthManager>,
        start: WatchStarter,
    ) -> Arc<Self> {
        Arc::new(Self {
            deployment_url,
            store,
            native_auth,
            registry: WatchRegistry::new(),
            start,
        })
    }

    pub async fn abort_thread(&self, user_id: &str, thread_id: &str) {
        self.registry.abort(&WatchKey {
            user_id: user_id.to_string(),
            thread_id: thread_id.to_string(),
        });
    }

    pub async fn notify_local_update(
        &self,
        user_id: &str,
        thread_id: &str,
        total_parts: u32,
        stale: bool,
    ) {
        self.registry.send_to(
            &WatchKey {
                user_id: user_id.to_string(),
                thread_id: thread_id.to_string(),
            },
            TranscriptWatchEvent {
                event_type: "updated",
                total_parts: Some(total_parts),
                stale,
            },
        );
    }

    pub async fn open(self: &Arc<Self>, user_id: &str, thread_id: &str) -> TranscriptWatchSession {
        let key = WatchKey {
            user_id: user_id.to_string(),
            thread_id: thread_id.to_string(),
        };
        let (session, ()) = self.registry.open_with(
            key.clone(),
            16,
            || (),
            |events, ()| {
                (self.start)(WatchStart {
                    deployment_url: self.deployment_url.clone(),
                    store: Arc::clone(&self.store),
                    native_auth: Arc::clone(&self.native_auth),
                    user_id: key.user_id.clone(),
                    thread_id: key.thread_id.clone(),
                    events,
                })
            },
        );
        TranscriptWatchSession { session }
    }
}

impl TranscriptWatchSession {
    pub fn receiver(&mut self) -> &mut broadcast::Receiver<TranscriptWatchEvent> {
        self.session.receiver()
    }
}

fn spawn_convex_watch(start: WatchStart) -> JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            match run_watch_loop(&start).await {
                Ok(()) => break,
                Err(error) => {
                    tracing::warn!(
                        "transcript watch for {} failed; retrying: {error:#}",
                        start.thread_id
                    );
                    let mut state = match start
                        .store
                        .load_state(&start.user_id, &start.thread_id)
                        .await
                    {
                        Ok(state) => state,
                        Err(_) => break,
                    };
                    state.stale = true;
                    let _ = start
                        .store
                        .save_state(&start.user_id, &start.thread_id, &state)
                        .await;
                    let _ = start.events.send(TranscriptWatchEvent {
                        event_type: "updated",
                        total_parts: Some(state.remote_total_parts),
                        stale: true,
                    });
                    retry_after_failure().await;
                }
            }
        }
    })
}

async fn run_watch_loop(start: &WatchStart) -> anyhow::Result<()> {
    let client = UserConvexClient::connect_with_fetcher(
        &start.deployment_url,
        start
            .native_auth
            .auth_token_fetcher_for_user(start.user_id.clone()),
    )
    .await?;
    crate::work_sync::synchronize(
        client,
        Arc::clone(&start.store),
        start.user_id.clone(),
        start.thread_id.clone(),
        |total| {
            let _ = start.events.send(TranscriptWatchEvent {
                event_type: "updated",
                total_parts: Some(total),
                stale: false,
            });
        },
    )
    .await
}

#[cfg(test)]
mod tests;
