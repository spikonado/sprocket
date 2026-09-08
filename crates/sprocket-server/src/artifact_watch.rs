use std::collections::{BTreeMap, HashMap, HashSet};
use std::future::{self, Future};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use convex::{FunctionResult, QuerySubscription};
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use sprocket_convex::deserialize_convex_u64;
use sprocket_workspace::{ArtifactContentType, ArtifactFile, read_artifact_file};
use tokio::sync::broadcast;
use tokio::task::JoinHandle;
use tokio::time::{Instant, MissedTickBehavior, interval, sleep, timeout};

use crate::native_auth::NativeAuthManager;
use crate::transcript_client::UserConvexClient;

const LOCAL_POLL_INTERVAL: Duration = Duration::from_millis(500);
const AUTH_CHECK_INTERVAL: Duration = Duration::from_secs(15);
const NETWORK_TIMEOUT: Duration = Duration::from_secs(10);
const RECONNECT_INTERVAL: Duration = Duration::from_secs(2);
const SYNC_RETRY_INTERVAL: Duration = Duration::from_secs(2);
const ATOMIC_SAVE_RETRY_DELAY: Duration = Duration::from_millis(50);
const ATOMIC_SAVE_RETRIES: u32 = 4;

type ConnectFuture = Pin<
    Box<
        dyn Future<Output = anyhow::Result<(UserConvexClient, QuerySubscription)>> + Send + 'static,
    >,
>;
type SyncFuture =
    Pin<Box<dyn Future<Output = (ArtifactSyncRequest, Result<bool, String>)> + Send + 'static>>;
type AuthFuture = Pin<Box<dyn Future<Output = anyhow::Result<()>> + Send + 'static>>;
type RegistryFuture =
    Pin<Box<dyn Future<Output = anyhow::Result<Vec<RemoteArtifact>>> + Send + 'static>>;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ArtifactScope {
    Thread,
    Project,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalArtifact {
    #[serde(rename = "_id")]
    pub id: String,
    pub user_id: String,
    pub scope: ArtifactScope,
    pub repository_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    pub local_path: String,
    pub content: String,
    #[serde(rename = "type")]
    pub content_type: ArtifactContentType,
    pub title: String,
    pub revision: u64,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_error: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteArtifact {
    #[serde(rename = "_id")]
    pub id: String,
    pub user_id: String,
    pub scope: ArtifactScope,
    pub repository_key: String,
    #[serde(default)]
    pub thread_id: Option<String>,
    pub local_path: String,
    pub content: String,
    #[serde(rename = "type")]
    pub content_type: ArtifactContentType,
    pub title: String,
    #[serde(deserialize_with = "deserialize_convex_u64")]
    pub revision: u64,
    #[serde(deserialize_with = "deserialize_convex_u64")]
    pub created_at: u64,
    #[serde(deserialize_with = "deserialize_convex_u64")]
    pub updated_at: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactWatchEvent {
    pub artifacts: Vec<LocalArtifact>,
    pub stale: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, PartialEq, Eq, Hash)]
struct WatchKey {
    user_id: String,
    repository_key: String,
    workspace_path: String,
    thread_id: Option<String>,
}

struct WatchSlot {
    refs: usize,
    events: broadcast::Sender<ArtifactWatchEvent>,
    latest: Arc<Mutex<Option<ArtifactWatchEvent>>>,
    task: JoinHandle<()>,
}

type WatchStarter = Arc<dyn Fn(WatchStart) -> JoinHandle<()> + Send + Sync>;

struct WatchStart {
    deployment_url: String,
    native_auth: Arc<NativeAuthManager>,
    user_id: String,
    repository_key: String,
    workspace_path: String,
    thread_id: Option<String>,
    events: broadcast::Sender<ArtifactWatchEvent>,
    latest: Arc<Mutex<Option<ArtifactWatchEvent>>>,
}

pub struct ArtifactWatchers {
    deployment_url: String,
    native_auth: Arc<NativeAuthManager>,
    inner: Mutex<HashMap<WatchKey, WatchSlot>>,
    start: WatchStarter,
}

pub struct ArtifactWatchSession {
    watchers: Arc<ArtifactWatchers>,
    key: WatchKey,
    rx: broadcast::Receiver<ArtifactWatchEvent>,
    latest: Arc<Mutex<Option<ArtifactWatchEvent>>>,
}

impl ArtifactWatchers {
    pub(crate) fn new(deployment_url: String, native_auth: Arc<NativeAuthManager>) -> Arc<Self> {
        Self::with_starter(deployment_url, native_auth, Arc::new(spawn_convex_watch))
    }

    fn with_starter(
        deployment_url: String,
        native_auth: Arc<NativeAuthManager>,
        start: WatchStarter,
    ) -> Arc<Self> {
        Arc::new(Self {
            deployment_url,
            native_auth,
            inner: Mutex::new(HashMap::new()),
            start,
        })
    }

    pub async fn open(
        self: &Arc<Self>,
        user_id: &str,
        repository_key: &str,
        workspace_path: &str,
        thread_id: Option<&str>,
    ) -> ArtifactWatchSession {
        let key = WatchKey {
            user_id: user_id.to_string(),
            repository_key: repository_key.to_string(),
            workspace_path: workspace_path.to_string(),
            thread_id: thread_id.map(str::to_string),
        };
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(slot) = inner.get_mut(&key) {
            slot.refs += 1;
            return ArtifactWatchSession {
                watchers: Arc::clone(self),
                key,
                rx: slot.events.subscribe(),
                latest: Arc::clone(&slot.latest),
            };
        }
        let (events, rx) = broadcast::channel(1);
        let latest = Arc::new(Mutex::new(None));
        let task = (self.start)(WatchStart {
            deployment_url: self.deployment_url.clone(),
            native_auth: Arc::clone(&self.native_auth),
            user_id: user_id.to_string(),
            repository_key: repository_key.to_string(),
            workspace_path: workspace_path.to_string(),
            thread_id: thread_id.map(str::to_string),
            events: events.clone(),
            latest: Arc::clone(&latest),
        });
        inner.insert(
            key.clone(),
            WatchSlot {
                refs: 1,
                events,
                latest: Arc::clone(&latest),
                task,
            },
        );
        ArtifactWatchSession {
            watchers: Arc::clone(self),
            key,
            rx,
            latest,
        }
    }

    fn close(&self, key: &WatchKey) {
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
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
    pub fn active_count(&self) -> usize {
        self.inner
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .len()
    }
}

impl ArtifactWatchSession {
    pub async fn flush(&self) -> anyhow::Result<()> {
        timeout(Duration::from_secs(30), async {
            self.watchers
                .native_auth
                .require_user(&self.key.user_id)
                .await?;
            let client = UserConvexClient::connect_with_fetcher(
                &self.watchers.deployment_url,
                self.watchers
                    .native_auth
                    .auth_token_fetcher_for_user(self.key.user_id.clone()),
            )
            .await?;
            let mut feed = ArtifactFeed::new(
                self.key.user_id.clone(),
                self.key.repository_key.clone(),
                PathBuf::from(&self.key.workspace_path),
                self.key.thread_id.clone(),
            );
            flush_feed(
                &mut feed,
                || client.list_artifacts(&self.key.repository_key, self.key.thread_id.as_deref()),
                |request| sync_with_timeout(client.clone(), request),
            )
            .await
        })
        .await
        .map_err(|_| anyhow::anyhow!("Artifact flush timed out; local files remain unsynced"))?
    }

    pub fn receiver(&mut self) -> &mut broadcast::Receiver<ArtifactWatchEvent> {
        &mut self.rx
    }

    pub fn latest_event(&self) -> Option<ArtifactWatchEvent> {
        self.latest
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }
}

impl Drop for ArtifactWatchSession {
    fn drop(&mut self) {
        self.watchers.close(&self.key);
    }
}

async fn flush_feed<L, LF, S, SF>(
    feed: &mut ArtifactFeed,
    mut load: L,
    mut sync: S,
) -> anyhow::Result<()>
where
    L: FnMut() -> LF,
    LF: Future<Output = anyhow::Result<Vec<RemoteArtifact>>>,
    S: FnMut(ArtifactSyncRequest) -> SF,
    SF: Future<Output = (ArtifactSyncRequest, Result<bool, String>)>,
{
    loop {
        feed.apply_remote_registry(load().await?);
        feed.refresh_local_files().await;
        let requests = feed.sync_requests();
        if requests.is_empty() {
            if let Some(error) = feed
                .artifacts
                .values()
                .find_map(|tracked| tracked.artifact.local_error.as_ref())
            {
                anyhow::bail!("Artifact flush could not read a registered file: {error}");
            }
            return Ok(());
        }
        for request in requests {
            let (request, outcome) = sync(request).await;
            if let Err(error) = &outcome {
                anyhow::bail!("Artifact flush failed: {error}");
            }
            feed.apply_sync_outcome(&request, outcome);
        }
    }
}

fn spawn_convex_watch(start: WatchStart) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut feed = ArtifactFeed::new(
            start.user_id.clone(),
            start.repository_key.clone(),
            PathBuf::from(&start.workspace_path),
            start.thread_id.clone(),
        );
        run_watch_loop(&start, &mut feed).await;
    })
}

struct RemoteSession {
    client: UserConvexClient,
    subscription: QuerySubscription,
}

async fn run_watch_loop(start: &WatchStart, feed: &mut ArtifactFeed) {
    let mut remote: Option<RemoteSession> = None;
    let mut connect_op: Option<ConnectFuture> = None;
    let mut sync_op: Option<SyncFuture> = None;
    let mut auth_op: Option<AuthFuture> = None;
    let mut registry_op: Option<RegistryFuture> = None;
    let mut registry_retry_at: Option<Instant> = None;
    let mut reconnect_at = Instant::now();
    let mut next_sync_at = Instant::now();
    let mut last_auth = Instant::now();
    let mut poll = interval(LOCAL_POLL_INTERVAL);
    poll.set_missed_tick_behavior(MissedTickBehavior::Skip);

    loop {
        if remote.is_none() && connect_op.is_none() && Instant::now() >= reconnect_at {
            connect_op = Some(Box::pin(connect_remote(
                start.deployment_url.clone(),
                Arc::clone(&start.native_auth),
                start.user_id.clone(),
                start.repository_key.clone(),
                start.thread_id.clone(),
            )));
        }
        if auth_op.is_none() && last_auth.elapsed() >= AUTH_CHECK_INTERVAL {
            auth_op = Some(Box::pin(check_native_auth(
                Arc::clone(&start.native_auth),
                start.user_id.clone(),
            )));
        }

        tokio::select! {
            update = recv_subscription(&mut remote) => {
                let Some(update) = update else {
                    remote = None;
                    feed.note_transport_error("artifact subscription ended".to_string());
                    publish(start, feed);
                    reconnect_at = Instant::now();
                    continue;
                };
                match sprocket_convex::decode_labeled_function_result::<serde_json::Value>(update, "artifacts:getArtifactState") {
                    Ok(_) => {},
                    Err(error) => {
                        feed.note_transport_error(error.to_string());
                        publish(start, feed);
                        continue;
                    }
                }
                if let Some(session) = remote.as_ref() {
                    registry_op = Some(load_registry(session.client.clone(), start));
                    registry_retry_at = None;
                }
            }
            result = poll_optional(&mut registry_op) => {
                registry_op = None;
                let remotes = match result {
                    Ok(remotes) => remotes,
                    Err(error) => {
                        feed.note_transport_error(error.to_string());
                        publish(start, feed);
                        registry_retry_at = Some(Instant::now() + RECONNECT_INTERVAL);
                        continue;
                    }
                };
                let had_transport_error = feed.error.is_some() || feed.stale;
                feed.clear_transport_error();
                let registry_changed = feed.apply_remote_registry(remotes);
                let local_changed = feed.refresh_local_files().await;
                if had_transport_error || registry_changed || local_changed {
                    publish(start, feed);
                }
                if let Some(session) = remote.as_ref() {
                    maybe_start_sync(session, feed, &mut sync_op, next_sync_at);
                }
            }
            result = poll_optional(&mut connect_op) => {
                connect_op = None;
                match result {
                    Ok((client, subscription)) => {
                        last_auth = Instant::now();
                        remote = Some(RemoteSession { client, subscription });
                        if let Some(session) = remote.as_ref() {
                            maybe_start_sync(session, feed, &mut sync_op, next_sync_at);
                        }
                    }
                    Err(error) if is_native_account_revoked(&error) => {
                        feed.clear_revoked(error.to_string());
                        publish(start, feed);
                        return;
                    }
                    Err(error) => {
                        tracing::warn!(
                            "artifact watch for {} {} failed; retrying: {error:#}",
                            start.repository_key,
                            start.thread_id.as_deref().unwrap_or("-")
                        );
                        feed.note_transport_error(error.to_string());
                        publish(start, feed);
                        reconnect_at = Instant::now() + RECONNECT_INTERVAL;
                    }
                }
            }
            (request, outcome) = poll_optional(&mut sync_op) => {
                sync_op = None;
                let failed = outcome.is_err();
                let applied = feed.apply_sync_outcome(&request, outcome);
                if applied {
                    if failed {
                        next_sync_at = Instant::now() + SYNC_RETRY_INTERVAL;
                    }
                    publish(start, feed);
                }
                if let Some(session) = remote.as_ref() {
                    maybe_start_sync(session, feed, &mut sync_op, next_sync_at);
                }
            }
            result = poll_optional(&mut auth_op) => {
                auth_op = None;
                last_auth = Instant::now();
                match result {
                    Ok(()) => {}
                    Err(error) if is_native_account_revoked(&error) => {
                        feed.clear_revoked(error.to_string());
                        publish(start, feed);
                        return;
                    }
                    Err(error) => {
                        feed.note_transport_error(error.to_string());
                        publish(start, feed);
                    }
                }
            }
            _ = poll.tick() => {
                if registry_op.is_none() && registry_retry_at.is_some_and(|at| Instant::now() >= at) {
                    if let Some(session) = remote.as_ref() {
                        registry_op = Some(load_registry(session.client.clone(), start));
                        registry_retry_at = None;
                    }
                }
                let local_changed = feed.refresh_local_files().await;
                if local_changed {
                    publish(start, feed);
                }
                if let Some(session) = remote.as_ref() {
                    maybe_start_sync(session, feed, &mut sync_op, next_sync_at);
                }
            }
        }
    }
}

fn load_registry(client: UserConvexClient, start: &WatchStart) -> RegistryFuture {
    let repository_key = start.repository_key.clone();
    let thread_id = start.thread_id.clone();
    Box::pin(async move {
        client
            .list_artifacts(&repository_key, thread_id.as_deref())
            .await
    })
}

fn maybe_start_sync(
    remote: &RemoteSession,
    feed: &ArtifactFeed,
    sync_op: &mut Option<SyncFuture>,
    next_sync_at: Instant,
) {
    if sync_op.is_some() || Instant::now() < next_sync_at {
        return;
    }
    let Some(request) = feed.sync_requests().into_iter().next() else {
        return;
    };
    let client = remote.client.clone();
    *sync_op = Some(Box::pin(sync_with_timeout(client, request)));
}

async fn recv_subscription(remote: &mut Option<RemoteSession>) -> Option<FunctionResult> {
    match remote.as_mut() {
        Some(session) => session.subscription.next().await,
        None => future::pending().await,
    }
}

async fn poll_optional<T>(
    fut: &mut Option<Pin<Box<dyn Future<Output = T> + Send + 'static>>>,
) -> T {
    match fut.as_mut() {
        Some(fut) => fut.await,
        None => future::pending().await,
    }
}

async fn connect_remote(
    deployment_url: String,
    native_auth: Arc<NativeAuthManager>,
    user_id: String,
    repository_key: String,
    thread_id: Option<String>,
) -> anyhow::Result<(UserConvexClient, QuerySubscription)> {
    timeout(NETWORK_TIMEOUT, async {
        native_auth.require_user(&user_id).await?;
        let client = UserConvexClient::connect_with_fetcher(
            &deployment_url,
            native_auth.auth_token_fetcher_for_user(user_id),
        )
        .await?;
        let subscription = client
            .subscribe_artifacts(&repository_key, thread_id.as_deref())
            .await?;
        Ok((client, subscription))
    })
    .await
    .map_err(|_| anyhow::anyhow!("artifact watch connect timed out"))?
}

async fn check_native_auth(
    native_auth: Arc<NativeAuthManager>,
    user_id: String,
) -> anyhow::Result<()> {
    timeout(NETWORK_TIMEOUT, native_auth.require_user(&user_id))
        .await
        .map_err(|_| anyhow::anyhow!("artifact watch auth check timed out"))?
}

async fn sync_with_timeout(
    client: UserConvexClient,
    request: ArtifactSyncRequest,
) -> (ArtifactSyncRequest, Result<bool, String>) {
    let result = timeout(
        NETWORK_TIMEOUT,
        client.sync_artifact(
            &request.id,
            &request.repository_key,
            request.thread_id.as_deref(),
            request.expected_revision,
            &request.local_path,
            &request.content,
        ),
    )
    .await;
    let outcome = match result {
        Ok(Ok(applied)) => Ok(applied),
        Ok(Err(error)) => Err(error.to_string()),
        Err(_) => Err("artifact sync timed out".to_string()),
    };
    (request, outcome)
}

fn publish(start: &WatchStart, feed: &ArtifactFeed) -> bool {
    let event = feed.snapshot();
    let mut latest = start
        .latest
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if latest.as_ref() == Some(&event) {
        return false;
    }
    *latest = Some(event.clone());
    let _ = start.events.send(event);
    true
}

pub(crate) fn artifact_in_scope(
    artifact: &RemoteArtifact,
    user_id: &str,
    repository_key: &str,
    thread_id: Option<&str>,
) -> bool {
    if artifact.user_id != user_id || artifact.repository_key != repository_key {
        return false;
    }
    match artifact.scope {
        ArtifactScope::Project => true,
        ArtifactScope::Thread => {
            let Some(selected) = thread_id else {
                return false;
            };
            artifact.thread_id.as_deref() == Some(selected)
        }
    }
}

pub(crate) fn is_native_account_revoked(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause.is::<sprocket_convex::AuthSignedOut>()
            || matches!(
                cause.to_string().as_str(),
                "native WorkOS session is signed out"
                    | "native WorkOS session expired"
                    | "authentication session is signed out"
            )
    })
}

struct TrackedArtifact {
    artifact: LocalArtifact,
    registry_content: String,
    has_local: bool,
    dirty: bool,
    awaiting_cas: bool,
    last_synced_content: Option<String>,
}

impl TrackedArtifact {
    fn recompute_dirty(&mut self) {
        self.dirty = self.has_local
            && match &self.last_synced_content {
                Some(synced) => synced != &self.artifact.content,
                None => self.artifact.content != self.registry_content,
            };
    }

    fn reset_from_remote(&mut self, remote: RemoteArtifact) {
        self.registry_content = remote.content.clone();
        self.artifact = local_from_remote(remote);
        self.has_local = false;
        self.dirty = false;
        self.awaiting_cas = false;
        self.last_synced_content = None;
    }
}

struct ArtifactFeed {
    user_id: String,
    repository_key: String,
    workspace_root: PathBuf,
    thread_id: Option<String>,
    artifacts: BTreeMap<String, TrackedArtifact>,
    stale: bool,
    error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ArtifactSyncRequest {
    id: String,
    repository_key: String,
    thread_id: Option<String>,
    expected_revision: u64,
    local_path: String,
    content: String,
}

impl ArtifactFeed {
    fn new(
        user_id: String,
        repository_key: String,
        workspace_root: PathBuf,
        thread_id: Option<String>,
    ) -> Self {
        Self {
            user_id,
            repository_key,
            workspace_root,
            thread_id,
            artifacts: BTreeMap::new(),
            stale: true,
            error: None,
        }
    }

    fn snapshot(&self) -> ArtifactWatchEvent {
        ArtifactWatchEvent {
            artifacts: self
                .artifacts
                .values()
                .map(|tracked| tracked.artifact.clone())
                .collect(),
            stale: self.stale,
            error: self.error.clone(),
        }
    }

    fn note_transport_error(&mut self, error: String) {
        self.stale = true;
        self.error = Some(error);
    }

    fn clear_transport_error(&mut self) {
        self.error = None;
        self.stale = false;
    }

    fn clear_revoked(&mut self, error: String) {
        self.artifacts.clear();
        self.stale = true;
        self.error = Some(error);
    }

    fn apply_remote_registry(&mut self, remotes: Vec<RemoteArtifact>) -> bool {
        let scoped: Vec<RemoteArtifact> = remotes
            .into_iter()
            .filter(|artifact| {
                artifact_in_scope(
                    artifact,
                    &self.user_id,
                    &self.repository_key,
                    self.thread_id.as_deref(),
                )
            })
            .collect();
        let live_ids: HashSet<String> = scoped.iter().map(|artifact| artifact.id.clone()).collect();
        let mut changed = self.artifacts.len() != live_ids.len()
            || self
                .artifacts
                .keys()
                .any(|id| !live_ids.contains(id.as_str()));
        self.artifacts.retain(|id, _| live_ids.contains(id));
        for remote in scoped {
            match self.artifacts.get_mut(&remote.id) {
                Some(tracked) => {
                    if tracked.artifact.local_path != remote.local_path {
                        tracked.reset_from_remote(remote);
                        changed = true;
                        continue;
                    }
                    let revision_changed = tracked.artifact.revision != remote.revision;
                    changed |= assign(&mut tracked.registry_content, remote.content.clone());
                    changed |= assign(&mut tracked.artifact.user_id, remote.user_id);
                    changed |= tracked.artifact.scope != remote.scope;
                    tracked.artifact.scope = remote.scope;
                    changed |= assign(&mut tracked.artifact.repository_key, remote.repository_key);
                    let thread_id = thread_id_for_scope(remote.scope, remote.thread_id);
                    changed |= tracked.artifact.thread_id != thread_id;
                    tracked.artifact.thread_id = thread_id;
                    if !tracked.has_local {
                        changed |= assign(&mut tracked.artifact.title, remote.title);
                        changed |= tracked.artifact.content_type != remote.content_type;
                        tracked.artifact.content_type = remote.content_type;
                    }
                    changed |= tracked.artifact.revision != remote.revision;
                    tracked.artifact.revision = remote.revision;
                    changed |= tracked.artifact.created_at != remote.created_at;
                    tracked.artifact.created_at = remote.created_at;
                    changed |= tracked.artifact.updated_at != remote.updated_at;
                    tracked.artifact.updated_at = remote.updated_at;
                    if !tracked.dirty && !tracked.has_local {
                        changed |= assign(&mut tracked.artifact.content, remote.content);
                    }
                    if revision_changed {
                        tracked.awaiting_cas = false;
                    }
                    let was_dirty = tracked.dirty;
                    tracked.recompute_dirty();
                    changed |= was_dirty != tracked.dirty;
                }
                None => {
                    let id = remote.id.clone();
                    self.artifacts.insert(
                        id,
                        TrackedArtifact {
                            artifact: local_from_remote(remote.clone()),
                            registry_content: remote.content,
                            has_local: false,
                            dirty: false,
                            awaiting_cas: false,
                            last_synced_content: None,
                        },
                    );
                    changed = true;
                }
            }
        }
        changed
    }

    async fn refresh_local_files(&mut self) -> bool {
        let mut changed = false;
        let workspace_root = self.workspace_root.clone();
        for tracked in self.artifacts.values_mut() {
            let path = tracked.artifact.local_path.clone();
            match read_with_atomic_retry(&workspace_root, &path).await {
                Ok(file) => {
                    changed |= apply_local_file(tracked, file);
                }
                Err(error) => {
                    changed |= apply_local_read_error(tracked, error.to_string());
                }
            }
        }
        changed
    }

    fn has_pending_sync(&self) -> bool {
        self.artifacts
            .values()
            .any(|tracked| tracked.dirty && !tracked.awaiting_cas)
    }

    fn sync_requests(&self) -> Vec<ArtifactSyncRequest> {
        self.artifacts
            .values()
            .filter(|tracked| tracked.dirty && !tracked.awaiting_cas)
            .map(|tracked| ArtifactSyncRequest {
                id: tracked.artifact.id.clone(),
                repository_key: tracked.artifact.repository_key.clone(),
                thread_id: tracked.artifact.thread_id.clone(),
                expected_revision: tracked.artifact.revision,
                local_path: tracked.artifact.local_path.clone(),
                content: tracked.artifact.content.clone(),
            })
            .collect()
    }

    fn apply_sync_outcome(
        &mut self,
        request: &ArtifactSyncRequest,
        outcome: Result<bool, String>,
    ) -> bool {
        let Some(tracked) = self.artifacts.get_mut(&request.id) else {
            return false;
        };
        if tracked.artifact.local_path != request.local_path
            || tracked.artifact.revision != request.expected_revision
        {
            return false;
        }
        match &outcome {
            Ok(true) => {
                tracked.last_synced_content = Some(request.content.clone());
                tracked.recompute_dirty();
            }
            Ok(false) => {
                tracked.awaiting_cas = true;
            }
            Err(_) => {
                tracked.recompute_dirty();
            }
        }
        match outcome {
            Ok(true) => {
                if !self.has_pending_sync()
                    && !self.artifacts.values().any(|tracked| tracked.awaiting_cas)
                {
                    self.stale = false;
                    self.error = None;
                }
            }
            Ok(false) => {
                self.stale = true;
            }
            Err(error) => {
                self.stale = true;
                self.error = Some(error);
            }
        }
        true
    }
}

fn assign<T: PartialEq>(slot: &mut T, value: T) -> bool {
    if *slot == value {
        false
    } else {
        *slot = value;
        true
    }
}

fn local_from_remote(remote: RemoteArtifact) -> LocalArtifact {
    LocalArtifact {
        id: remote.id,
        user_id: remote.user_id,
        scope: remote.scope,
        repository_key: remote.repository_key,
        thread_id: thread_id_for_scope(remote.scope, remote.thread_id),
        local_path: remote.local_path,
        content: remote.content,
        content_type: remote.content_type,
        title: remote.title,
        revision: remote.revision,
        created_at: remote.created_at,
        updated_at: remote.updated_at,
        local_error: None,
    }
}

fn thread_id_for_scope(scope: ArtifactScope, thread_id: Option<String>) -> Option<String> {
    match scope {
        ArtifactScope::Thread => thread_id,
        ArtifactScope::Project => None,
    }
}

fn apply_local_file(tracked: &mut TrackedArtifact, file: ArtifactFile) -> bool {
    let mut changed = tracked.artifact.local_error.take().is_some();
    if tracked.artifact.title != file.title {
        tracked.artifact.title = file.title;
        changed = true;
    }
    if tracked.artifact.content_type != file.content_type {
        tracked.artifact.content_type = file.content_type;
        changed = true;
    }
    tracked.has_local = true;
    if tracked.artifact.content != file.content {
        tracked.artifact.content = file.content;
        changed = true;
    }
    let was_dirty = tracked.dirty;
    tracked.recompute_dirty();
    changed || was_dirty != tracked.dirty
}

fn apply_local_read_error(tracked: &mut TrackedArtifact, error: String) -> bool {
    let changed = tracked.artifact.local_error.as_deref() != Some(error.as_str());
    tracked.artifact.local_error = Some(error);
    changed
}

async fn read_with_atomic_retry(
    workspace_root: &Path,
    local_path: &str,
) -> anyhow::Result<ArtifactFile> {
    let mut last_error = None;
    for attempt in 0..=ATOMIC_SAVE_RETRIES {
        match read_artifact_file(workspace_root, local_path).await {
            Ok(file) => return Ok(file),
            Err(error) => {
                let retry = attempt < ATOMIC_SAVE_RETRIES && is_transient_read_error(&error);
                last_error = Some(error);
                if !retry {
                    break;
                }
                sleep(ATOMIC_SAVE_RETRY_DELAY).await;
            }
        }
    }
    Err(last_error.unwrap_or_else(|| anyhow::anyhow!("failed to read artifact {local_path}")))
}

fn is_transient_read_error(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause.downcast_ref::<std::io::Error>().is_some_and(|io| {
            matches!(
                io.kind(),
                ErrorKind::NotFound
                    | ErrorKind::Interrupted
                    | ErrorKind::WouldBlock
                    | ErrorKind::TimedOut
            )
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn native_auth() -> Arc<NativeAuthManager> {
        NativeAuthManager::configured_for_test(
            crate::native_auth::NativeAuthConfig {
                workos_client_id: "client_test".to_string(),
            },
            "http://127.0.0.1/callback".to_string(),
        )
    }

    fn remote(
        id: &str,
        scope: ArtifactScope,
        thread_id: Option<&str>,
        path: &str,
        content: &str,
        revision: u64,
    ) -> RemoteArtifact {
        RemoteArtifact {
            id: id.into(),
            user_id: "user".into(),
            scope,
            repository_key: "repo".into(),
            thread_id: thread_id.map(str::to_string),
            local_path: path.into(),
            content: content.into(),
            content_type: ArtifactContentType::Markdown,
            title: Path::new(path)
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or(path)
                .into(),
            revision,
            created_at: 1,
            updated_at: revision,
        }
    }

    fn watch_start() -> (WatchStart, broadcast::Receiver<ArtifactWatchEvent>) {
        let (events, rx) = broadcast::channel(8);
        (
            WatchStart {
                deployment_url: "https://example.convex.cloud".into(),
                native_auth: native_auth(),
                user_id: "user".into(),
                repository_key: "repo".into(),
                workspace_path: "/workspace".into(),
                thread_id: None,
                events,
                latest: Arc::new(Mutex::new(None)),
            },
            rx,
        )
    }

    fn mark_local(feed: &mut ArtifactFeed, id: &str, path: &str, content: &str) {
        apply_local_file(
            feed.artifacts.get_mut(id).unwrap(),
            ArtifactFile {
                local_path: path.into(),
                content: content.into(),
                title: Path::new(path)
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or(path)
                    .into(),
                content_type: ArtifactContentType::Markdown,
            },
        );
    }

    #[test]
    fn filter_keeps_project_and_selected_thread_artifacts() {
        let project = remote("p", ArtifactScope::Project, None, "docs.md", "p", 1);
        let selected = remote("t", ArtifactScope::Thread, Some("thread-a"), "a.md", "a", 1);
        let other = remote("o", ArtifactScope::Thread, Some("thread-b"), "b.md", "b", 1);
        let foreign = RemoteArtifact {
            repository_key: "other".into(),
            ..remote("x", ArtifactScope::Project, None, "x.md", "x", 1)
        };
        assert!(artifact_in_scope(
            &project,
            "user",
            "repo",
            Some("thread-a")
        ));
        assert!(artifact_in_scope(
            &selected,
            "user",
            "repo",
            Some("thread-a")
        ));
        assert!(!artifact_in_scope(&other, "user", "repo", Some("thread-a")));
        assert!(!artifact_in_scope(&selected, "user", "repo", None));
        assert!(artifact_in_scope(&project, "user", "repo", None));
        assert!(!artifact_in_scope(&foreign, "user", "repo", None));
        assert!(!artifact_in_scope(&project, "other-user", "repo", None));
    }

    #[tokio::test]
    async fn missing_and_atomic_saves_keep_cached_content() {
        let dir = std::env::temp_dir().join(format!("sprocket-artifacts-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let path = dir.join("note.md");
        tokio::fs::write(&path, "one").await.unwrap();

        let mut feed = ArtifactFeed::new(
            "user".into(),
            "repo".into(),
            dir.clone(),
            Some("thread-a".into()),
        );
        feed.apply_remote_registry(vec![
            remote(
                "a",
                ArtifactScope::Thread,
                Some("thread-a"),
                "note.md",
                "cloud",
                1,
            ),
            remote(
                "missing",
                ArtifactScope::Project,
                None,
                "gone.md",
                "remote-only",
                1,
            ),
        ]);
        assert!(feed.refresh_local_files().await);
        let snapshot = feed.snapshot();
        let note = snapshot
            .artifacts
            .iter()
            .find(|artifact| artifact.id == "a")
            .unwrap();
        assert_eq!(note.content, "one");
        assert!(note.local_error.is_none());
        let missing = snapshot
            .artifacts
            .iter()
            .find(|artifact| artifact.id == "missing")
            .unwrap();
        assert_eq!(missing.content, "remote-only");
        assert!(missing.local_error.is_some());
        assert!(feed.has_pending_sync());
        assert!(!feed.refresh_local_files().await);

        let staging = dir.join("note.md.tmp");
        tokio::fs::write(&staging, "two").await.unwrap();
        tokio::fs::rename(&staging, &path).await.unwrap();
        assert!(feed.refresh_local_files().await);
        let note = feed
            .snapshot()
            .artifacts
            .into_iter()
            .find(|artifact| artifact.id == "a")
            .unwrap();
        assert_eq!(note.content, "two");

        tokio::fs::remove_file(&path).await.unwrap();
        assert!(feed.refresh_local_files().await);
        let note = feed
            .snapshot()
            .artifacts
            .into_iter()
            .find(|artifact| artifact.id == "a")
            .unwrap();
        assert_eq!(note.content, "two");
        assert!(note.local_error.is_some());
        assert!(!feed.refresh_local_files().await);

        let _ = tokio::fs::remove_dir_all(dir).await;
    }

    #[tokio::test]
    async fn retarget_to_missing_path_does_not_sync_previous_file() {
        let dir = std::env::temp_dir().join(format!(
            "sprocket-artifacts-retarget-{}",
            uuid::Uuid::new_v4()
        ));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        tokio::fs::write(dir.join("note.md"), "dirty-local")
            .await
            .unwrap();

        let mut feed = ArtifactFeed::new(
            "user".into(),
            "repo".into(),
            dir.clone(),
            Some("thread-a".into()),
        );
        feed.apply_remote_registry(vec![remote(
            "a",
            ArtifactScope::Thread,
            Some("thread-a"),
            "note.md",
            "cloud",
            1,
        )]);
        assert!(feed.refresh_local_files().await);
        assert_eq!(feed.snapshot().artifacts[0].content, "dirty-local");
        assert!(feed.has_pending_sync());
        let in_flight = feed.sync_requests()[0].clone();
        assert_eq!(in_flight.local_path, "note.md");
        assert_eq!(in_flight.content, "dirty-local");

        assert!(feed.apply_remote_registry(vec![remote(
            "a",
            ArtifactScope::Thread,
            Some("thread-a"),
            "moved.md",
            "cloud-new",
            2,
        )]));
        let snapshot = feed.snapshot();
        assert_eq!(snapshot.artifacts[0].local_path, "moved.md");
        assert_eq!(snapshot.artifacts[0].content, "cloud-new");
        assert!(snapshot.artifacts[0].local_error.is_none());
        assert!(!feed.has_pending_sync());
        assert!(feed.sync_requests().is_empty());

        assert!(feed.refresh_local_files().await);
        let snapshot = feed.snapshot();
        assert_eq!(snapshot.artifacts[0].content, "cloud-new");
        assert!(snapshot.artifacts[0].local_error.is_some());
        assert!(!feed.has_pending_sync());

        assert!(!feed.apply_sync_outcome(&in_flight, Ok(true)));
        assert_eq!(feed.snapshot().artifacts[0].content, "cloud-new");
        assert!(!feed.has_pending_sync());

        tokio::fs::write(dir.join("moved.md"), "from-disk")
            .await
            .unwrap();
        assert!(feed.refresh_local_files().await);
        assert_eq!(feed.snapshot().artifacts[0].content, "from-disk");
        assert!(feed.has_pending_sync());
        assert_eq!(feed.sync_requests()[0].local_path, "moved.md");
        assert_eq!(feed.sync_requests()[0].content, "from-disk");

        let _ = tokio::fs::remove_dir_all(dir).await;
    }

    #[test]
    fn failed_sync_retries_without_losing_local_updates() {
        let mut feed = ArtifactFeed::new(
            "user".into(),
            "repo".into(),
            PathBuf::from("/tmp"),
            Some("thread-a".into()),
        );
        feed.apply_remote_registry(vec![remote(
            "a",
            ArtifactScope::Thread,
            Some("thread-a"),
            "note.md",
            "cloud",
            1,
        )]);
        mark_local(&mut feed, "a", "note.md", "local");
        assert_eq!(feed.sync_requests().len(), 1);
        let request = feed.sync_requests()[0].clone();
        assert!(feed.apply_sync_outcome(&request, Err("offline".into())));
        assert_eq!(feed.snapshot().artifacts[0].content, "local");
        assert!(feed.snapshot().stale);
        assert_eq!(feed.snapshot().error.as_deref(), Some("offline"));
        assert_eq!(feed.sync_requests().len(), 1);

        assert!(feed.apply_sync_outcome(&request, Ok(false)));
        assert!(feed.sync_requests().is_empty());
        assert_eq!(feed.snapshot().artifacts[0].content, "local");

        feed.apply_remote_registry(vec![remote(
            "a",
            ArtifactScope::Thread,
            Some("thread-a"),
            "note.md",
            "other",
            2,
        )]);
        assert_eq!(feed.snapshot().artifacts[0].content, "local");
        assert_eq!(feed.sync_requests()[0].expected_revision, 2);
        let request = feed.sync_requests()[0].clone();
        assert!(feed.apply_sync_outcome(&request, Ok(true)));
        assert!(!feed.has_pending_sync());
        assert!(!feed.snapshot().stale);
    }

    #[test]
    fn late_cas_miss_does_not_stick_after_newer_revision() {
        let mut feed = ArtifactFeed::new(
            "user".into(),
            "repo".into(),
            PathBuf::from("/tmp"),
            Some("thread-a".into()),
        );
        feed.apply_remote_registry(vec![remote(
            "a",
            ArtifactScope::Thread,
            Some("thread-a"),
            "note.md",
            "cloud",
            1,
        )]);
        mark_local(&mut feed, "a", "note.md", "local");
        let stale_request = feed.sync_requests()[0].clone();
        assert_eq!(stale_request.expected_revision, 1);

        feed.apply_remote_registry(vec![remote(
            "a",
            ArtifactScope::Thread,
            Some("thread-a"),
            "note.md",
            "other",
            2,
        )]);
        assert_eq!(feed.sync_requests()[0].expected_revision, 2);
        assert!(feed.has_pending_sync());

        assert!(!feed.apply_sync_outcome(&stale_request, Ok(false)));
        assert!(feed.has_pending_sync());
        assert_eq!(feed.sync_requests()[0].expected_revision, 2);
        assert_eq!(feed.snapshot().artifacts[0].content, "local");
    }

    #[test]
    fn transport_error_keeps_local_content_revoke_clears_it() {
        let mut feed = ArtifactFeed::new(
            "user".into(),
            "repo".into(),
            PathBuf::from("/tmp"),
            Some("thread-a".into()),
        );
        feed.apply_remote_registry(vec![remote(
            "a",
            ArtifactScope::Thread,
            Some("thread-a"),
            "note.md",
            "cloud",
            1,
        )]);
        mark_local(&mut feed, "a", "note.md", "secret");
        feed.note_transport_error("connect timed out".into());
        assert_eq!(feed.snapshot().artifacts[0].content, "secret");
        assert!(feed.snapshot().stale);

        feed.clear_revoked("native WorkOS session is signed out".into());
        let snapshot = feed.snapshot();
        assert!(snapshot.artifacts.is_empty());
        assert!(snapshot.stale);
        assert_eq!(
            snapshot.error.as_deref(),
            Some("native WorkOS session is signed out")
        );
    }

    #[test]
    fn identical_registry_snapshot_is_noop() {
        let mut feed = ArtifactFeed::new(
            "user".into(),
            "repo".into(),
            PathBuf::from("/tmp"),
            Some("thread-a".into()),
        );
        assert!(feed.apply_remote_registry(vec![remote(
            "a",
            ArtifactScope::Thread,
            Some("thread-a"),
            "note.md",
            "cloud",
            1,
        )]));
        let snapshot = feed.snapshot();
        assert!(!feed.apply_remote_registry(vec![remote(
            "a",
            ArtifactScope::Thread,
            Some("thread-a"),
            "note.md",
            "cloud",
            1,
        )]));
        assert_eq!(feed.snapshot(), snapshot);
    }

    #[test]
    fn publish_skips_duplicate_snapshots() {
        let (start, mut rx) = watch_start();
        let feed = ArtifactFeed::new("user".into(), "repo".into(), PathBuf::from("/tmp"), None);
        assert!(publish(&start, &feed));
        assert!(!publish(&start, &feed));
        assert!(rx.try_recv().is_ok());
        assert!(matches!(
            rx.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ));
    }

    #[test]
    fn detects_revoked_native_account() {
        assert!(is_native_account_revoked(&anyhow::anyhow!(
            sprocket_convex::AuthSignedOut
        )));
        assert!(is_native_account_revoked(&anyhow::anyhow!(
            "native WorkOS session is signed out"
        )));
        assert!(is_native_account_revoked(&anyhow::anyhow!(
            "native WorkOS session expired"
        )));
        assert!(!is_native_account_revoked(&anyhow::anyhow!(
            "Native sign-in is temporarily unavailable. Try again."
        )));
        assert!(!is_native_account_revoked(&anyhow::anyhow!(
            "artifact watch connect timed out"
        )));
    }

    #[tokio::test]
    async fn final_flush_loads_new_registrations_and_retries_a_conflicting_sync() {
        let dir = tempfile::tempdir().unwrap();
        tokio::fs::write(dir.path().join("final.md"), "final edit")
            .await
            .unwrap();
        let registry = Mutex::new(vec![remote(
            "a",
            ArtifactScope::Project,
            None,
            "final.md",
            "initial",
            1,
        )]);
        let mut feed = ArtifactFeed::new("user".into(), "repo".into(), dir.path().into(), None);
        let mut writes = 0;
        flush_feed(
            &mut feed,
            || future::ready(Ok(registry.lock().unwrap().clone())),
            |request| {
                writes += 1;
                let mut registry = registry.lock().unwrap();
                registry[0].revision += 1;
                if writes == 1 {
                    future::ready((request, Ok(false)))
                } else {
                    registry[0].content = request.content.clone();
                    future::ready((request, Ok(true)))
                }
            },
        )
        .await
        .unwrap();
        assert_eq!(writes, 2);
        assert_eq!(registry.lock().unwrap()[0].content, "final edit");
        assert!(!feed.has_pending_sync());
    }

    #[tokio::test]
    async fn final_flush_syncs_readable_files_before_reporting_missing_ones() {
        let dir = tempfile::tempdir().unwrap();
        tokio::fs::write(dir.path().join("present.md"), "saved")
            .await
            .unwrap();
        let registry = Mutex::new(vec![
            remote("a", ArtifactScope::Project, None, "missing.md", "cloud", 1),
            remote("b", ArtifactScope::Project, None, "present.md", "old", 1),
        ]);
        let mut feed = ArtifactFeed::new("user".into(), "repo".into(), dir.path().into(), None);
        let result = flush_feed(
            &mut feed,
            || future::ready(Ok(registry.lock().unwrap().clone())),
            |request| {
                let mut registry = registry.lock().unwrap();
                registry[1].content = request.content.clone();
                registry[1].revision += 1;
                future::ready((request, Ok(true)))
            },
        )
        .await;
        assert!(result.unwrap_err().to_string().contains("could not read"));
        assert_eq!(registry.lock().unwrap()[1].content, "saved");
        assert!(!dir.path().join("missing.md").exists());
    }

    #[tokio::test]
    async fn final_flush_can_be_cancelled_while_the_registry_is_offline() {
        let mut feed = ArtifactFeed::new(
            "user".into(),
            "repo".into(),
            PathBuf::from("/workspace"),
            None,
        );
        let result = timeout(
            Duration::from_millis(20),
            flush_feed(
                &mut feed,
                || future::pending::<anyhow::Result<Vec<RemoteArtifact>>>(),
                |request| future::ready((request, Ok(true))),
            ),
        )
        .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn last_close_cancels_the_watch_task() {
        let live = Arc::new(AtomicUsize::new(0));
        let live_task = live.clone();
        let watchers = ArtifactWatchers::with_starter(
            "https://example.convex.cloud".into(),
            native_auth(),
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

        let first = watchers
            .open("user", "repo", "/workspace", Some("thread"))
            .await;
        let second = watchers
            .open("user", "repo", "/workspace", Some("thread"))
            .await;
        let other = watchers.open("user", "repo", "/workspace", None).await;
        assert_eq!(watchers.active_count(), 2);
        assert_eq!(live.load(Ordering::SeqCst), 2);
        drop(first);
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert_eq!(watchers.active_count(), 2);
        drop(second);
        tokio::time::sleep(Duration::from_millis(40)).await;
        assert_eq!(watchers.active_count(), 1);
        assert_eq!(live.load(Ordering::SeqCst), 1);
        drop(other);
        tokio::time::sleep(Duration::from_millis(40)).await;
        assert_eq!(watchers.active_count(), 0);
        assert_eq!(live.load(Ordering::SeqCst), 0);
    }
}
