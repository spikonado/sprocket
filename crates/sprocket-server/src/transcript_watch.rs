use std::collections::HashMap;
use std::sync::Arc;

use futures::StreamExt;
use sprocket_agent::{TRANSCRIPT_PAGE_SIZE, TranscriptStore, apply_remote_state};
use tokio::sync::{Mutex, broadcast};
use tokio::task::JoinHandle;

use crate::convex_auth::ConvexTokenProvider;
use crate::transcript_client::{
    UserConvexClient, decode_state_update, retry_after_failure, sync_range,
};

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

struct WatchSlot {
    refs: usize,
    events: broadcast::Sender<TranscriptWatchEvent>,
    task: JoinHandle<()>,
}

type WatchStarter = Arc<dyn Fn(WatchStart) -> JoinHandle<()> + Send + Sync>;

struct WatchStart {
    deployment_url: String,
    store: Arc<TranscriptStore>,
    user_id: String,
    thread_id: String,
    auth_token: String,
    tokens: ConvexTokenProvider,
    session_credential: Option<sprocket_convex::SessionCredentialProvider>,
    events: broadcast::Sender<TranscriptWatchEvent>,
}

pub struct TranscriptWatchers {
    deployment_url: String,
    store: Arc<TranscriptStore>,
    tokens: ConvexTokenProvider,
    session_credentials:
        Arc<tokio::sync::Mutex<Option<sprocket_convex::SessionCredentialProvider>>>,
    inner: Mutex<HashMap<WatchKey, WatchSlot>>,
    start: WatchStarter,
}

pub struct TranscriptWatchSession {
    watchers: Arc<TranscriptWatchers>,
    key: WatchKey,
    rx: broadcast::Receiver<TranscriptWatchEvent>,
}

impl TranscriptWatchers {
    pub fn new(
        deployment_url: String,
        store: Arc<TranscriptStore>,
        tokens: ConvexTokenProvider,
        session_credentials: Arc<
            tokio::sync::Mutex<Option<sprocket_convex::SessionCredentialProvider>>,
        >,
    ) -> Arc<Self> {
        Self::with_starter(
            deployment_url,
            store,
            tokens,
            session_credentials,
            Arc::new(spawn_convex_watch),
        )
    }

    fn with_starter(
        deployment_url: String,
        store: Arc<TranscriptStore>,
        tokens: ConvexTokenProvider,
        session_credentials: Arc<
            tokio::sync::Mutex<Option<sprocket_convex::SessionCredentialProvider>>,
        >,
        start: WatchStarter,
    ) -> Arc<Self> {
        Arc::new(Self {
            deployment_url,
            store,
            tokens,
            session_credentials,
            inner: Mutex::new(HashMap::new()),
            start,
        })
    }

    pub async fn abort_thread(&self, user_id: &str, thread_id: &str) {
        let key = WatchKey {
            user_id: user_id.to_string(),
            thread_id: thread_id.to_string(),
        };
        let mut inner = self.inner.lock().await;
        if let Some(slot) = inner.remove(&key) {
            slot.task.abort();
        }
    }

    pub async fn open(
        self: &Arc<Self>,
        user_id: &str,
        thread_id: &str,
        auth_token: String,
    ) -> TranscriptWatchSession {
        let key = WatchKey {
            user_id: user_id.to_string(),
            thread_id: thread_id.to_string(),
        };
        let mut inner = self.inner.lock().await;
        if let Some(slot) = inner.get_mut(&key) {
            slot.refs += 1;
            return TranscriptWatchSession {
                watchers: Arc::clone(self),
                key,
                rx: slot.events.subscribe(),
            };
        }
        let (events, rx) = broadcast::channel(16);
        let session_credential = crate::matching_session_credential(
            self.session_credentials.lock().await.clone(),
            &auth_token,
        )
        .await;
        let task = (self.start)(WatchStart {
            deployment_url: self.deployment_url.clone(),
            store: Arc::clone(&self.store),
            user_id: user_id.to_string(),
            thread_id: thread_id.to_string(),
            auth_token,
            tokens: self.tokens.clone(),
            session_credential,
            events: events.clone(),
        });
        inner.insert(
            key.clone(),
            WatchSlot {
                refs: 1,
                events,
                task,
            },
        );
        TranscriptWatchSession {
            watchers: Arc::clone(self),
            key,
            rx,
        }
    }

    async fn close(&self, key: &WatchKey) {
        let mut inner = self.inner.lock().await;
        let Some(slot) = inner.get_mut(key) else {
            return;
        };
        slot.refs = slot.refs.saturating_sub(1);
        if slot.refs == 0 {
            if let Some(slot) = inner.remove(key) {
                slot.task.abort();
            }
        }
    }

    #[cfg(test)]
    pub async fn active_count(&self) -> usize {
        self.inner.lock().await.len()
    }
}

impl TranscriptWatchSession {
    pub fn receiver(&mut self) -> &mut broadcast::Receiver<TranscriptWatchEvent> {
        &mut self.rx
    }
}

impl Drop for TranscriptWatchSession {
    fn drop(&mut self) {
        let watchers = Arc::clone(&self.watchers);
        let key = self.key.clone();
        tokio::spawn(async move {
            watchers.close(&key).await;
        });
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
    let client = UserConvexClient::connect(
        &start.deployment_url,
        start.auth_token.clone(),
        start.tokens.clone(),
        start.session_credential.clone(),
    )
    .await?;
    let remote = client.ensure_migrated(&start.thread_id).await?;
    apply_remote_state(
        &start.store,
        &start.user_id,
        &start.thread_id,
        &remote,
        false,
    )
    .await?;
    let newest_start = remote.total_parts.saturating_sub(TRANSCRIPT_PAGE_SIZE);
    sync_range(
        &start.store,
        &client,
        &start.user_id,
        &start.thread_id,
        newest_start,
        remote.total_parts,
    )
    .await?;
    let _ = start.events.send(TranscriptWatchEvent {
        event_type: "updated",
        total_parts: Some(remote.total_parts),
        stale: false,
    });

    let mut seen_total = remote.total_parts;
    let mut subscription = client.subscribe_state(&start.thread_id).await?;
    while let Some(update) = subscription.next().await {
        let remote = decode_state_update(update)?;
        apply_remote_state(
            &start.store,
            &start.user_id,
            &start.thread_id,
            &remote,
            false,
        )
        .await?;
        if remote.total_parts > seen_total {
            sync_range(
                &start.store,
                &client,
                &start.user_id,
                &start.thread_id,
                seen_total,
                remote.total_parts,
            )
            .await?;
        }
        seen_total = remote.total_parts;
        let _ = start.events.send(TranscriptWatchEvent {
            event_type: "updated",
            total_parts: Some(remote.total_parts),
            stale: false,
        });
    }
    anyhow::bail!("transcript subscription ended")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn last_close_cancels_the_watch_task() {
        let dir = std::env::temp_dir().join(format!("sprocket-watch-{}", uuid::Uuid::new_v4()));
        let store = TranscriptStore::new(dir.clone());
        let live = Arc::new(AtomicUsize::new(0));
        let live_task = live.clone();
        let watchers = TranscriptWatchers::with_starter(
            "https://example.convex.cloud".into(),
            store,
            ConvexTokenProvider::new(),
            Arc::new(tokio::sync::Mutex::new(
                None::<sprocket_convex::SessionCredentialProvider>,
            )),
            Arc::new(move |_start| {
                let live_task = live_task.clone();
                live_task.fetch_add(1, Ordering::SeqCst);
                tokio::spawn(async move {
                    struct DropLive(Arc<AtomicUsize>);
                    impl Drop for DropLive {
                        fn drop(&mut self) {
                            self.0.fetch_sub(1, Ordering::SeqCst);
                        }
                    }
                    let _live = DropLive(live_task);
                    std::future::pending::<()>().await;
                })
            }),
        );

        let first = watchers.open("user", "thread", "token".into()).await;
        let second = watchers.open("user", "thread", "token".into()).await;
        assert_eq!(watchers.active_count().await, 1);
        assert_eq!(live.load(Ordering::SeqCst), 1);
        drop(first);
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert_eq!(watchers.active_count().await, 1);
        drop(second);
        tokio::time::sleep(std::time::Duration::from_millis(40)).await;
        assert_eq!(watchers.active_count().await, 0);
        assert_eq!(live.load(Ordering::SeqCst), 0);
        let _ = tokio::fs::remove_dir_all(dir).await;
    }
}
