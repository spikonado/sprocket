use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use anyhow::anyhow;
use futures::StreamExt;
use tokio::sync::{Mutex, broadcast};
use tokio::task::JoinHandle;
use tokio::time::sleep;

use crate::now_ms;
use crate::project_attachments::{ProjectAttachmentStore, WorkspaceAvailability};
use crate::thread_cache::{
    THREAD_SNAPSHOT_VERSION, ThreadSnapshotCategory, ThreadSnapshotFile, ThreadSnapshotStore,
};
use crate::transcript_client::{UserConvexClient, decode_revision_update, retry_after_failure};

const SNAPSHOT_PAGE_SIZE: f64 = 64.0;
const SNAPSHOT_REVISION_RETRIES: usize = 8;
const MAX_SNAPSHOT_THREADS: usize = 50_000;

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

#[derive(Clone, PartialEq, Eq, Hash)]
struct WatchKey {
    user_id: String,
    repository_key: String,
    category: ThreadSnapshotCategory,
}

struct CacheInner {
    user_id: Option<String>,
    auth_token: Option<String>,
    status: ThreadCacheStatus,
    last_synced_at: Option<u64>,
    tasks: HashMap<WatchKey, JoinHandle<()>>,
}

pub struct ThreadCacheSync {
    deployment_url: String,
    store: Arc<ThreadSnapshotStore>,
    attachments: Arc<ProjectAttachmentStore>,
    inner: Mutex<CacheInner>,
    events: broadcast::Sender<ThreadCacheEvent>,
}

pub struct ThreadCacheWatchSession {
    rx: broadcast::Receiver<ThreadCacheEvent>,
}

impl ThreadCacheSync {
    pub fn new(
        deployment_url: String,
        store: Arc<ThreadSnapshotStore>,
        attachments: Arc<ProjectAttachmentStore>,
    ) -> Arc<Self> {
        let (events, _) = broadcast::channel(32);
        Arc::new(Self {
            deployment_url,
            store,
            attachments,
            inner: Mutex::new(CacheInner {
                user_id: None,
                auth_token: None,
                status: ThreadCacheStatus::Loading,
                last_synced_at: None,
                tasks: HashMap::new(),
            }),
            events,
        })
    }

    pub fn store(&self) -> &Arc<ThreadSnapshotStore> {
        &self.store
    }

    pub async fn snapshot(
        &self,
        user_id: &str,
    ) -> anyhow::Result<(
        Vec<crate::thread_cache::CachedThreadSummary>,
        ThreadCacheEvent,
    )> {
        let threads = self.store.list_user_threads(user_id).await?;
        let event = self.event_for_user(user_id).await?;
        Ok((threads, event))
    }

    pub async fn event_for_user(&self, user_id: &str) -> anyhow::Result<ThreadCacheEvent> {
        let inner = self.inner.lock().await;
        if inner.user_id.as_deref() == Some(user_id) {
            return Ok(ThreadCacheEvent {
                status: inner.status,
                last_synced_at: inner.last_synced_at,
            });
        }
        Ok(ThreadCacheEvent {
            status: ThreadCacheStatus::Loading,
            last_synced_at: self.store.latest_synced_at(user_id).await?,
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
        auth_token: String,
    ) -> anyhow::Result<()> {
        let user_id = user_id.trim();
        let auth_token = auth_token.trim();
        if user_id.is_empty() {
            anyhow::bail!("user id is required");
        }
        if auth_token.is_empty() {
            anyhow::bail!("auth token is required");
        }
        let last_synced_at = self.store.latest_synced_at(user_id).await?;
        let mut emit_loading = false;
        {
            let mut inner = self.inner.lock().await;
            if inner.user_id.as_deref() != Some(user_id) {
                abort_tasks(&mut inner);
                inner.status = ThreadCacheStatus::Loading;
                emit_loading = true;
            }
            inner.user_id = Some(user_id.to_string());
            inner.auth_token = Some(auth_token.to_string());
            inner.last_synced_at = last_synced_at.or(inner.last_synced_at);
        }
        if emit_loading {
            self.emit().await;
        }
        self.reconcile_watches(ThreadSnapshotCategory::Active)
            .await?;
        Ok(())
    }

    pub async fn sync_archived(self: &Arc<Self>, user_id: &str) -> anyhow::Result<()> {
        let user_id = user_id.trim();
        if user_id.is_empty() {
            anyhow::bail!("user id is required");
        }
        {
            let inner = self.inner.lock().await;
            if inner.user_id.as_deref() != Some(user_id) {
                anyhow::bail!("thread cache is registered to a different account");
            }
            if inner.auth_token.as_deref().unwrap_or("").is_empty() {
                anyhow::bail!("thread cache is not registered");
            }
        }
        self.reconcile_watches(ThreadSnapshotCategory::Archived)
            .await?;
        Ok(())
    }

    pub async fn refresh_repository(
        self: &Arc<Self>,
        user_id: &str,
        auth_token: String,
        repository_key: &str,
        categories: &[ThreadSnapshotCategory],
    ) -> anyhow::Result<()> {
        self.register(user_id, auth_token.clone()).await?;
        if repository_key.is_empty() {
            return Ok(());
        }
        self.ensure_repository_watches(user_id, repository_key, categories, &auth_token)
            .await;
        let client = UserConvexClient::connect(&self.deployment_url, auth_token).await?;
        for &category in categories {
            let start = WatchStart {
                deployment_url: self.deployment_url.clone(),
                store: Arc::clone(&self.store),
                sync: Arc::clone(self),
                user_id: user_id.to_string(),
                repository_key: repository_key.to_string(),
                category,
                auth_token: String::new(),
            };
            download_consistent_snapshot(&start, &client).await?;
        }
        Ok(())
    }

    async fn ensure_repository_watches(
        self: &Arc<Self>,
        user_id: &str,
        repository_key: &str,
        categories: &[ThreadSnapshotCategory],
        auth_token: &str,
    ) {
        let mut inner = self.inner.lock().await;
        if inner.user_id.as_deref() != Some(user_id) {
            return;
        }
        for &category in categories {
            let key = WatchKey {
                user_id: user_id.to_string(),
                repository_key: repository_key.to_string(),
                category,
            };
            if inner.tasks.contains_key(&key) {
                continue;
            }
            let task = tokio::spawn(watch_snapshot(WatchStart {
                deployment_url: self.deployment_url.clone(),
                store: Arc::clone(&self.store),
                sync: Arc::clone(self),
                user_id: key.user_id.clone(),
                repository_key: key.repository_key.clone(),
                category: key.category,
                auth_token: auth_token.to_string(),
            }));
            inner.tasks.insert(key, task);
        }
    }

    async fn reconcile_watches(
        self: &Arc<Self>,
        category: ThreadSnapshotCategory,
    ) -> anyhow::Result<()> {
        let (user_id, auth_token) = {
            let inner = self.inner.lock().await;
            (
                inner
                    .user_id
                    .clone()
                    .ok_or_else(|| anyhow!("thread cache is not registered"))?,
                inner
                    .auth_token
                    .clone()
                    .ok_or_else(|| anyhow!("thread cache is not registered"))?,
            )
        };
        let repository_keys = attached_repository_keys(&self.attachments).await?;
        let wanted: HashSet<WatchKey> = repository_keys
            .into_iter()
            .map(|repository_key| WatchKey {
                user_id: user_id.clone(),
                repository_key,
                category,
            })
            .collect();
        let mut inner = self.inner.lock().await;
        if inner.user_id.as_deref() != Some(user_id.as_str()) {
            return Ok(());
        }
        inner.tasks.retain(|key, task| {
            if key.user_id == user_id && key.category == category && !wanted.contains(key) {
                task.abort();
                false
            } else {
                true
            }
        });
        for key in wanted {
            if inner.tasks.contains_key(&key) {
                continue;
            }
            let task = tokio::spawn(watch_snapshot(WatchStart {
                deployment_url: self.deployment_url.clone(),
                store: Arc::clone(&self.store),
                sync: Arc::clone(self),
                user_id: key.user_id.clone(),
                repository_key: key.repository_key.clone(),
                category: key.category,
                auth_token: auth_token.clone(),
            }));
            inner.tasks.insert(key, task);
        }
        if inner.tasks.is_empty() {
            inner.status = ThreadCacheStatus::Live;
            drop(inner);
            self.emit().await;
        }
        Ok(())
    }

    async fn note_success(&self, user_id: &str, synced_at: u64) {
        let mut inner = self.inner.lock().await;
        if inner.user_id.as_deref() != Some(user_id) {
            return;
        }
        inner.status = ThreadCacheStatus::Live;
        inner.last_synced_at = Some(synced_at);
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
        let event = self.current_event().await;
        let _ = self.events.send(event);
    }
}

impl ThreadCacheWatchSession {
    pub fn receiver(&mut self) -> &mut broadcast::Receiver<ThreadCacheEvent> {
        &mut self.rx
    }
}

struct WatchStart {
    deployment_url: String,
    store: Arc<ThreadSnapshotStore>,
    sync: Arc<ThreadCacheSync>,
    user_id: String,
    repository_key: String,
    category: ThreadSnapshotCategory,
    auth_token: String,
}

fn abort_tasks(inner: &mut CacheInner) {
    for (_, task) in inner.tasks.drain() {
        task.abort();
    }
}

async fn attached_repository_keys(
    attachments: &ProjectAttachmentStore,
) -> anyhow::Result<Vec<String>> {
    let mut keys = HashSet::new();
    for attachment in attachments.list().await? {
        if attachment.availability != WorkspaceAvailability::Available {
            continue;
        }
        let key = attachment.repository_key.trim();
        if !key.is_empty() {
            keys.insert(key.to_string());
        }
    }
    Ok(keys.into_iter().collect())
}

async fn watch_snapshot(start: WatchStart) {
    loop {
        match run_watch(&start).await {
            Ok(()) => {
                start
                    .sync
                    .note_failure(&start.user_id, ThreadCacheStatus::Reconnecting)
                    .await;
            }
            Err(error) => {
                let status = classify_watch_error(&error);
                tracing::warn!(
                    "thread snapshot watch for {} {} failed: {error:#}",
                    start.repository_key,
                    start.category.as_str()
                );
                start.sync.note_failure(&start.user_id, status).await;
            }
        }
        retry_after_failure().await;
    }
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

async fn run_watch(start: &WatchStart) -> anyhow::Result<()> {
    let client = UserConvexClient::connect(&start.deployment_url, start.auth_token.clone()).await?;
    let mut subscription = client
        .subscribe_snapshot_revision(&start.repository_key, start.category.as_str())
        .await?;
    let mut seen = download_consistent_snapshot(start, &client).await?;
    while let Some(update) = subscription.next().await {
        let revision = decode_revision_update(update)?;
        if revision == seen {
            continue;
        }
        seen = download_consistent_snapshot(start, &client).await?;
    }
    anyhow::bail!("thread snapshot subscription ended")
}

async fn download_consistent_snapshot(
    start: &WatchStart,
    client: &UserConvexClient,
) -> anyhow::Result<u64> {
    let (revision, threads) = fetch_consistent_snapshot(
        client,
        &start.repository_key,
        start.category.as_str(),
        SNAPSHOT_REVISION_RETRIES,
    )
    .await?;
    let synced_at = now_ms();
    start
        .store
        .write(&ThreadSnapshotFile {
            version: THREAD_SNAPSHOT_VERSION,
            user_id: start.user_id.clone(),
            repository_key: start.repository_key.clone(),
            category: start.category,
            revision,
            synced_at,
            threads,
        })
        .await?;
    start.sync.note_success(&start.user_id, synced_at).await;
    Ok(revision)
}

pub async fn fetch_consistent_snapshot(
    client: &UserConvexClient,
    repository_key: &str,
    category: &str,
    retries: usize,
) -> anyhow::Result<(u64, Vec<crate::thread_cache::CachedThreadSummary>)> {
    let mut last_error = None;
    for _ in 0..retries.max(1) {
        let before = client.snapshot_revision(repository_key, category).await?;
        match download_pages(client, repository_key, category).await {
            Ok(threads) => {
                let after = client.snapshot_revision(repository_key, category).await?;
                if before == after {
                    return Ok((after, threads));
                }
                last_error = Some(anyhow!(
                    "snapshot revision changed during download ({before} -> {after})"
                ));
            }
            Err(error) => last_error = Some(error),
        }
        sleep(Duration::from_millis(50)).await;
    }
    Err(last_error.unwrap_or_else(|| anyhow!("snapshot revision changed during download")))
}

async fn download_pages(
    client: &UserConvexClient,
    repository_key: &str,
    category: &str,
) -> anyhow::Result<Vec<crate::thread_cache::CachedThreadSummary>> {
    let mut threads = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let page = client
            .list_snapshot_page(
                repository_key,
                category,
                cursor.as_deref(),
                SNAPSHOT_PAGE_SIZE,
            )
            .await?;
        threads.extend(page.page);
        if threads.len() > MAX_SNAPSHOT_THREADS {
            anyhow::bail!("thread snapshot exceeded {MAX_SNAPSHOT_THREADS} rows");
        }
        if page.is_done {
            break;
        }
        if page.continue_cursor.is_empty() {
            anyhow::bail!("thread snapshot page was incomplete");
        }
        cursor = Some(page.continue_cursor);
    }
    threads.sort_by(
        |left, right| match right.has_active_run.cmp(&left.has_active_run) {
            std::cmp::Ordering::Equal => right
                .last_message_at
                .partial_cmp(&left.last_message_at)
                .unwrap_or(std::cmp::Ordering::Equal),
            order => order,
        },
    );
    Ok(threads)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_failures_surface_as_error_status() {
        assert_eq!(
            classify_watch_error(&anyhow!(
                "threads:getSnapshotRevision: Authentication required."
            )),
            ThreadCacheStatus::Error
        );
        assert_eq!(
            classify_watch_error(&anyhow!("connection timed out")),
            ThreadCacheStatus::Offline
        );
        assert_eq!(
            classify_watch_error(&anyhow!("temporary failure")),
            ThreadCacheStatus::Reconnecting
        );
    }
}
