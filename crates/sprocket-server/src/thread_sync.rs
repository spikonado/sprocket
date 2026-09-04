use std::sync::Arc;

use futures::StreamExt;
use tokio::sync::{Mutex, broadcast};
use tokio::task::JoinHandle;

use crate::native_auth::NativeAuthManager;
use crate::now_ms;
use crate::thread_cache::{CachedThreadRecord, ThreadCacheStore};
use crate::transcript_client::{
    UserConvexClient, decode_thread_records_update, retry_after_failure,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ThreadCacheStatus {
    Loading,
    Live,
    Reconnecting,
    Offline,
    Error,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadCacheEvent {
    pub status: ThreadCacheStatus,
    pub last_synced_at: Option<u64>,
}

struct CacheInner {
    user_id: Option<String>,
    selected_thread_id: Option<String>,
    status: ThreadCacheStatus,
    last_synced_at: Option<u64>,
    task: Option<JoinHandle<()>>,
}

pub struct ThreadCacheSync {
    deployment_url: String,
    store: Arc<ThreadCacheStore>,
    native_auth: Arc<NativeAuthManager>,
    inner: Mutex<CacheInner>,
    events: broadcast::Sender<ThreadCacheEvent>,
}

pub struct ThreadCacheWatchSession {
    rx: broadcast::Receiver<ThreadCacheEvent>,
}

impl ThreadCacheSync {
    pub(crate) fn new(
        deployment_url: String,
        store: Arc<ThreadCacheStore>,
        native_auth: Arc<NativeAuthManager>,
    ) -> Arc<Self> {
        let (events, _) = broadcast::channel(32);
        Arc::new(Self {
            deployment_url,
            store,
            native_auth,
            inner: Mutex::new(CacheInner {
                user_id: None,
                selected_thread_id: None,
                status: ThreadCacheStatus::Loading,
                last_synced_at: None,
                task: None,
            }),
            events,
        })
    }

    pub async fn snapshot(
        &self,
        user_id: &str,
    ) -> anyhow::Result<(Vec<CachedThreadRecord>, ThreadCacheEvent)> {
        let threads = self
            .store
            .load()
            .await?
            .filter(|cache| cache.user_id == user_id)
            .map_or_else(Vec::new, |cache| cache.threads);
        Ok((threads, self.event_for_user(user_id).await?))
    }

    pub async fn event_for_user(&self, user_id: &str) -> anyhow::Result<ThreadCacheEvent> {
        let inner = self.inner.lock().await;
        Ok(if inner.user_id.as_deref() == Some(user_id) {
            ThreadCacheEvent {
                status: inner.status,
                last_synced_at: inner.last_synced_at,
            }
        } else {
            ThreadCacheEvent {
                status: ThreadCacheStatus::Loading,
                last_synced_at: None,
            }
        })
    }

    pub async fn subscribe(&self) -> ThreadCacheWatchSession {
        ThreadCacheWatchSession {
            rx: self.events.subscribe(),
        }
    }

    pub async fn current_event(&self) -> ThreadCacheEvent {
        let inner = self.inner.lock().await;
        ThreadCacheEvent {
            status: inner.status,
            last_synced_at: inner.last_synced_at,
        }
    }

    pub async fn register(
        self: &Arc<Self>,
        user_id: &str,
        selected_thread_id: Option<&str>,
    ) -> anyhow::Result<()> {
        let user_id = user_id.trim();
        if user_id.is_empty() {
            anyhow::bail!("user id is required");
        }
        let selected_thread_id = selected_thread_id
            .map(str::trim)
            .filter(|id| !id.is_empty());
        let mut inner = self.inner.lock().await;
        if inner.user_id.as_deref() == Some(user_id)
            && inner.selected_thread_id.as_deref() == selected_thread_id
            && inner.task.is_some()
        {
            return Ok(());
        }
        if let Some(task) = inner.task.take() {
            task.abort();
        }
        inner.user_id = Some(user_id.to_string());
        inner.selected_thread_id = selected_thread_id.map(str::to_string);
        inner.status = ThreadCacheStatus::Loading;
        inner.last_synced_at = None;
        inner.task = Some(tokio::spawn(watch_records(WatchStart {
            deployment_url: self.deployment_url.clone(),
            store: Arc::clone(&self.store),
            sync: Arc::clone(self),
            user_id: user_id.to_string(),
            selected_thread_id: selected_thread_id.map(str::to_string),
            native_auth: Arc::clone(&self.native_auth),
        })));
        drop(inner);
        self.emit().await;
        Ok(())
    }

    async fn note_success(&self, user_id: &str) {
        let mut inner = self.inner.lock().await;
        if inner.user_id.as_deref() != Some(user_id) {
            return;
        }
        inner.status = ThreadCacheStatus::Live;
        inner.last_synced_at = Some(now_ms());
        drop(inner);
        self.emit().await;
    }

    async fn note_failure(&self, user_id: &str, status: ThreadCacheStatus) {
        let mut inner = self.inner.lock().await;
        if inner.user_id.as_deref() != Some(user_id) {
            return;
        }
        inner.status = status;
        drop(inner);
        self.emit().await;
    }

    async fn emit(&self) {
        let _ = self.events.send(self.current_event().await);
    }
}

impl ThreadCacheWatchSession {
    pub fn receiver(&mut self) -> &mut broadcast::Receiver<ThreadCacheEvent> {
        &mut self.rx
    }
}

struct WatchStart {
    deployment_url: String,
    store: Arc<ThreadCacheStore>,
    sync: Arc<ThreadCacheSync>,
    user_id: String,
    selected_thread_id: Option<String>,
    native_auth: Arc<NativeAuthManager>,
}

async fn watch_records(start: WatchStart) {
    loop {
        if let Err(error) = run_watch(&start).await {
            tracing::warn!("thread cache watch failed: {error:#}");
            start
                .sync
                .note_failure(&start.user_id, classify_watch_error(&error))
                .await;
        } else {
            start
                .sync
                .note_failure(&start.user_id, ThreadCacheStatus::Reconnecting)
                .await;
        }
        retry_after_failure().await;
    }
}

async fn run_watch(start: &WatchStart) -> anyhow::Result<()> {
    let client = UserConvexClient::connect_with_fetcher(
        &start.deployment_url,
        start
            .native_auth
            .auth_token_fetcher_for_user(start.user_id.clone()),
    )
    .await?;
    let mut subscription = client
        .subscribe_recent_threads(start.selected_thread_id.as_deref())
        .await?;
    while let Some(update) = subscription.next().await {
        let records = decode_thread_records_update(update)?;
        start.store.write(&start.user_id, &records).await?;
        start.sync.note_success(&start.user_id).await;
    }
    anyhow::bail!("thread cache subscription ended")
}

fn classify_watch_error(error: &anyhow::Error) -> ThreadCacheStatus {
    let message = error.to_string().to_lowercase();
    if message.contains("auth") || message.contains("unauthor") || message.contains("identity") {
        ThreadCacheStatus::Error
    } else if message.contains("timed out")
        || message.contains("connection")
        || message.contains("dns")
        || message.contains("offline")
    {
        ThreadCacheStatus::Offline
    } else {
        ThreadCacheStatus::Reconnecting
    }
}
