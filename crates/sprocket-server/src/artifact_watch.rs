use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::{StreamExt, stream};
use serde::{Deserialize, Serialize};
use sprocket_agent::artifact_bindings::{ArtifactBindings, content_hash};
use sprocket_convex::deserialize_convex_u64;
use sprocket_workspace::{ArtifactContentType, read_artifact_file};
use tokio::sync::broadcast;
use tokio::task::JoinHandle;
use tokio::time::{MissedTickBehavior, interval, timeout};

use crate::native_auth::NativeAuthManager;
use crate::transcript_client::UserConvexClient;

const NETWORK_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ArtifactScope {
    Thread,
    Project,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteArtifact {
    #[serde(rename = "_id")]
    pub id: String,
    pub user_id: String,
    pub scope: ArtifactScope,
    pub repository_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
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
pub struct LocalArtifact {
    #[serde(flatten)]
    remote: RemoteArtifact,
    #[serde(skip_serializing_if = "Option::is_none")]
    local_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    local_error: Option<String>,
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

pub struct ArtifactWatchers {
    deployment_url: String,
    native_auth: Arc<NativeAuthManager>,
    bindings_root: PathBuf,
    inner: Mutex<HashMap<WatchKey, WatchSlot>>,
}

pub struct ArtifactWatchSession {
    watchers: Arc<ArtifactWatchers>,
    key: WatchKey,
    rx: broadcast::Receiver<ArtifactWatchEvent>,
    latest: Arc<Mutex<Option<ArtifactWatchEvent>>>,
}

impl ArtifactWatchers {
    pub(crate) fn new(
        deployment_url: String,
        native_auth: Arc<NativeAuthManager>,
        bindings_root: PathBuf,
    ) -> Arc<Self> {
        Arc::new(Self {
            deployment_url,
            native_auth,
            bindings_root,
            inner: Mutex::new(HashMap::new()),
        })
    }

    fn bindings(&self, key: &WatchKey) -> ArtifactBindings {
        ArtifactBindings::new(
            &self.bindings_root,
            &self.deployment_url,
            &key.user_id,
            Path::new(&key.workspace_path),
        )
    }

    pub async fn open(
        self: &Arc<Self>,
        user_id: &str,
        repository_key: &str,
        workspace_path: &str,
        thread_id: Option<&str>,
    ) -> ArtifactWatchSession {
        let key = WatchKey {
            user_id: user_id.into(),
            repository_key: repository_key.into(),
            workspace_path: workspace_path.into(),
            thread_id: thread_id.map(str::to_string),
        };
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        let slot = inner.entry(key.clone()).or_insert_with(|| {
            let (events, _) = broadcast::channel(1);
            let latest = Arc::new(Mutex::new(None));
            // The task must not own the registry: the last session drop aborts it.
            let task = tokio::spawn(watch(
                self.deployment_url.clone(),
                Arc::clone(&self.native_auth),
                key.clone(),
                self.bindings(&key),
                events.clone(),
                Arc::clone(&latest),
            ));
            WatchSlot {
                refs: 0,
                events,
                latest,
                task,
            }
        });
        slot.refs += 1;
        ArtifactWatchSession {
            watchers: Arc::clone(self),
            key,
            rx: slot.events.subscribe(),
            latest: Arc::clone(&slot.latest),
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
    pub fn receiver(&mut self) -> &mut broadcast::Receiver<ArtifactWatchEvent> {
        &mut self.rx
    }
    pub fn latest_event(&self) -> Option<ArtifactWatchEvent> {
        self.latest
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    pub async fn flush(&self) -> anyhow::Result<()> {
        timeout(Duration::from_secs(30), async {
            let client = connect(
                &self.watchers.deployment_url,
                &self.watchers.native_auth,
                &self.key,
            )
            .await?;
            let bindings = self.watchers.bindings(&self.key);
            let mut feed = ArtifactFeed::new(self.key.clone(), bindings.clone());
            flush_feed(
                &mut feed,
                || client.list_artifacts(&self.key.repository_key, self.key.thread_id.as_deref()),
                |request| {
                    let client = &client;
                    let bindings = &bindings;
                    async move { sync(client, bindings, &request).await }
                },
            )
            .await
        })
        .await
        .map_err(|_| anyhow::anyhow!("Artifact flush timed out; local files remain unsynced"))?
    }
}

async fn flush_feed<L, LF, S, SF>(
    feed: &mut ArtifactFeed,
    mut load: L,
    mut synchronize: S,
) -> anyhow::Result<()>
where
    L: FnMut() -> LF,
    LF: std::future::Future<Output = anyhow::Result<Vec<RemoteArtifact>>>,
    S: FnMut(SyncRequest) -> SF,
    SF: std::future::Future<Output = anyhow::Result<()>>,
{
    loop {
        feed.apply_registry(load().await?);
        feed.refresh().await?;
        if feed.pending.is_empty() {
            if let Some(error) = feed
                .local
                .values()
                .find_map(|artifact| artifact.local_error.as_ref())
                .cloned()
            {
                let previous = feed.remote.clone();
                feed.apply_registry(load().await?);
                if feed.remote != previous {
                    continue;
                }
                anyhow::bail!("Artifact flush failed: {error}");
            }
            return Ok(());
        }
        for request in std::mem::take(&mut feed.pending) {
            synchronize(request).await?;
        }
    }
}

impl Drop for ArtifactWatchSession {
    fn drop(&mut self) {
        let mut inner = self
            .watchers
            .inner
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(slot) = inner.get_mut(&self.key) {
            slot.refs -= 1;
            if slot.refs == 0 {
                if let Some(slot) = inner.remove(&self.key) {
                    slot.task.abort();
                }
            }
        }
    }
}

async fn connect(
    url: &str,
    auth: &Arc<NativeAuthManager>,
    key: &WatchKey,
) -> anyhow::Result<UserConvexClient> {
    auth.require_user(&key.user_id).await?;
    UserConvexClient::connect_with_fetcher(
        url,
        auth.auth_token_fetcher_for_user(key.user_id.clone()),
    )
    .await
}

struct CloudSnapshot {
    artifacts: Vec<RemoteArtifact>,
    revision: u64,
}

async fn cloud_snapshot(
    client: &UserConvexClient,
    key: &WatchKey,
    known_revision: Option<u64>,
    bindings: &ArtifactBindings,
    pending: Vec<SyncRequest>,
) -> anyhow::Result<Option<CloudSnapshot>> {
    for request in pending {
        timeout(NETWORK_TIMEOUT, sync(client, bindings, &request)).await??;
    }
    let revision = client
        .artifact_revision(&key.repository_key, key.thread_id.as_deref())
        .await?;
    if known_revision == Some(revision) {
        return Ok(None);
    }
    let artifacts = client
        .list_artifacts(&key.repository_key, key.thread_id.as_deref())
        .await?;
    // A later revision requires another read rather than labeling an older body as current.
    let after = client
        .artifact_revision(&key.repository_key, key.thread_id.as_deref())
        .await?;
    if revision != after {
        anyhow::bail!("Artifact registry changed during refresh; retrying");
    }
    Ok(Some(CloudSnapshot {
        artifacts,
        revision,
    }))
}

async fn watch(
    url: String,
    auth: Arc<NativeAuthManager>,
    key: WatchKey,
    bindings: ArtifactBindings,
    events: broadcast::Sender<ArtifactWatchEvent>,
    latest: Arc<Mutex<Option<ArtifactWatchEvent>>>,
) {
    let mut feed = ArtifactFeed::new(key.clone(), bindings.clone());
    let mut stale = true;
    let mut error = None;
    let (pending_tx, pending_rx) = tokio::sync::watch::channel(Vec::new());
    let (cloud_tx, mut cloud_rx) = tokio::sync::mpsc::channel(1);
    let mut tasks = tokio::task::JoinSet::new();
    tasks.spawn(check_auth(
        Arc::clone(&auth),
        key.user_id.clone(),
        cloud_tx.clone(),
    ));
    tasks.spawn(cloud_worker(url, auth, key, bindings, pending_rx, cloud_tx));
    let mut poll = interval(Duration::from_millis(500));
    poll.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            result = cloud_rx.recv() => {
                match result {
                    Some(Ok(snapshot)) => {
                        if let Some(snapshot) = snapshot { feed.apply_registry(snapshot.artifacts); }
                        stale = false;
                        error = None;
                    }
                    Some(Err(failure)) if is_native_account_revoked(&failure) => {
                        publish(&events, &latest, ArtifactWatchEvent { artifacts: vec![], stale: true, error: Some(failure.to_string()) });
                        return;
                    }
                    Some(Err(failure)) => { stale = true; error = Some(failure.to_string()); }
                    None => return,
                }
            }
            _ = poll.tick() => {}
        }
        if let Err(failure) = feed.refresh().await {
            stale = true;
            error = Some(failure.to_string());
        }
        pending_tx.send_replace(feed.pending.clone());
        publish(&events, &latest, feed.snapshot(stale, error.clone()));
    }
}

async fn cloud_worker(
    url: String,
    auth: Arc<NativeAuthManager>,
    key: WatchKey,
    bindings: ArtifactBindings,
    pending: tokio::sync::watch::Receiver<Vec<SyncRequest>>,
    output: tokio::sync::mpsc::Sender<anyhow::Result<Option<CloudSnapshot>>>,
) {
    let mut client = None;
    let mut revision = None;
    let mut poll = interval(Duration::from_secs(1));
    poll.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        poll.tick().await;
        let requests = pending.borrow().clone();
        let outcome = async {
            timeout(NETWORK_TIMEOUT, auth.require_user(&key.user_id)).await??;
            let connection = match &client {
                Some(client) => client,
                None => client.insert(timeout(NETWORK_TIMEOUT, connect(&url, &auth, &key)).await??),
            };
            cloud_snapshot(connection, &key, revision, &bindings, requests).await
        }
        .await;
        if let Ok(Some(snapshot)) = &outcome {
            revision = Some(snapshot.revision);
        }
        if outcome.is_err() {
            client = None;
        }
        if output.send(outcome).await.is_err() {
            return;
        }
    }
}

async fn check_auth(
    auth: Arc<NativeAuthManager>,
    user_id: String,
    output: tokio::sync::mpsc::Sender<anyhow::Result<Option<CloudSnapshot>>>,
) {
    loop {
        tokio::time::sleep(Duration::from_secs(15)).await;
        if let Ok(Err(error)) = timeout(NETWORK_TIMEOUT, auth.require_user(&user_id)).await {
            if is_native_account_revoked(&error) {
                let _ = output.send(Err(error)).await;
                return;
            }
        }
    }
}

fn publish(
    events: &broadcast::Sender<ArtifactWatchEvent>,
    latest: &Mutex<Option<ArtifactWatchEvent>>,
    event: ArtifactWatchEvent,
) {
    let mut current = latest.lock().unwrap_or_else(|error| error.into_inner());
    if current.as_ref() != Some(&event) {
        *current = Some(event.clone());
        let _ = events.send(event);
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

#[derive(Clone)]
struct SyncRequest {
    artifact: RemoteArtifact,
    path: String,
    baseline: String,
    content: String,
}

async fn sync(
    client: &UserConvexClient,
    bindings: &ArtifactBindings,
    request: &SyncRequest,
) -> anyhow::Result<()> {
    let mut guard = bindings.lock().await?;
    let Some(binding) = guard.get(&request.artifact.id) else {
        return Ok(());
    };
    if binding.local_path != request.path || binding.content_hash != request.baseline {
        return Ok(());
    }
    if client
        .sync_artifact(
            &request.artifact.id,
            &request.artifact.repository_key,
            request.artifact.thread_id.as_deref(),
            request.artifact.revision,
            &request.content,
        )
        .await?
    {
        let mut binding = binding.clone();
        binding.content_hash = content_hash(&request.content);
        guard.bind(binding)?;
        guard.persist().await?;
    }
    Ok(())
}

struct ArtifactFeed {
    key: WatchKey,
    bindings: ArtifactBindings,
    remote: BTreeMap<String, RemoteArtifact>,
    local: BTreeMap<String, LocalArtifact>,
    pending: Vec<SyncRequest>,
}

impl ArtifactFeed {
    fn new(key: WatchKey, bindings: ArtifactBindings) -> Self {
        Self {
            key,
            bindings,
            remote: BTreeMap::new(),
            local: BTreeMap::new(),
            pending: Vec::new(),
        }
    }

    fn apply_registry(&mut self, artifacts: Vec<RemoteArtifact>) {
        self.remote = artifacts
            .into_iter()
            .filter(|artifact| {
                artifact.user_id == self.key.user_id
                    && artifact.repository_key == self.key.repository_key
                    && (artifact.scope == ArtifactScope::Project
                        || (self.key.thread_id.is_some()
                            && artifact.thread_id == self.key.thread_id))
            })
            .map(|artifact| (artifact.id.clone(), artifact))
            .collect();
        self.local.retain(|id, _| self.remote.contains_key(id));
        self.pending.clear();
    }

    fn snapshot(&self, stale: bool, error: Option<String>) -> ArtifactWatchEvent {
        ArtifactWatchEvent {
            artifacts: self.local.values().cloned().collect(),
            stale,
            error,
        }
    }

    async fn refresh(&mut self) -> anyhow::Result<()> {
        let bindings: HashMap<_, _> = self
            .bindings
            .snapshot()
            .await?
            .into_iter()
            .filter_map(|binding| binding.artifact_id.clone().map(|id| (id, binding)))
            .collect();
        let mut pending = Vec::new();
        let mut local = BTreeMap::new();
        let mut baseline_updates = Vec::new();
        let workspace = PathBuf::from(&self.key.workspace_path);
        let reads: Vec<_> = self
            .remote
            .keys()
            .filter_map(|id| {
                bindings
                    .get(id)
                    .map(|binding| (id.clone(), binding.local_path.clone()))
            })
            .collect();
        let mut files = stream::iter(reads)
            .map(move |(id, path)| {
                let workspace = workspace.clone();
                async move { (id, read_artifact_file(&workspace, &path).await) }
            })
            .buffer_unordered(16)
            .collect::<HashMap<_, _>>()
            .await;
        for artifact in self.remote.values() {
            let mut view = LocalArtifact {
                remote: artifact.clone(),
                local_path: None,
                local_error: None,
            };
            if let Some(binding) = bindings.get(&artifact.id).cloned() {
                view.local_path = Some(binding.local_path.clone());
                match files
                    .remove(&artifact.id)
                    .expect("every bound artifact was read")
                {
                    Ok(file) => {
                        let disk = content_hash(&file.content);
                        let cloud = content_hash(&artifact.content);
                        if disk == cloud {
                            if binding.content_hash != cloud {
                                baseline_updates.push((artifact.id.clone(), binding, cloud));
                            }
                        } else if disk == binding.content_hash {
                            view.local_error = Some("The cloud artifact is newer than this local file. Showing the cloud version; save to a new path to bind it.".into());
                        } else {
                            view.remote.content = file.content.clone();
                            if cloud == binding.content_hash {
                                pending.push(SyncRequest {
                                    artifact: artifact.clone(),
                                    path: binding.local_path,
                                    baseline: binding.content_hash,
                                    content: file.content,
                                });
                            } else {
                                view.local_error = Some("Both the local file and cloud artifact changed. Local preview retained; sync paused until you explicitly resolve the conflict.".into());
                            }
                        }
                    }
                    Err(error) => {
                        if let Some(previous) = self
                            .local
                            .get(&artifact.id)
                            .filter(|previous| previous.local_path == view.local_path)
                        {
                            view.remote.content = previous.remote.content.clone();
                        }
                        view.local_error = Some(error.to_string());
                    }
                }
            }
            local.insert(artifact.id.clone(), view);
        }
        self.pending = pending;
        self.local = local;
        if !baseline_updates.is_empty() {
            let Ok(guard) = timeout(Duration::from_millis(50), self.bindings.lock()).await else {
                return Ok(());
            };
            let mut guard = guard?;
            let mut changed = false;
            for (id, previous, hash) in baseline_updates {
                if let Some(current) = guard.get(&id) {
                    if current.local_path == previous.local_path
                        && current.content_hash == previous.content_hash
                        && current.registration_id == previous.registration_id
                    {
                        let mut binding = current.clone();
                        binding.content_hash = hash;
                        guard.bind(binding)?;
                        changed = true;
                    }
                }
            }
            if changed {
                guard.persist().await?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sprocket_agent::artifact_bindings::ArtifactBinding;

    #[tokio::test]
    async fn last_consumer_releases_shared_watch() {
        let dir = tempfile::tempdir().unwrap();
        let auth = NativeAuthManager::configured_for_test(
            crate::native_auth::NativeAuthConfig {
                workos_client_id: "client_test".into(),
            },
            "http://127.0.0.1/callback".into(),
        );
        let watchers = ArtifactWatchers::new(
            "https://example.convex.cloud".into(),
            auth,
            dir.path().into(),
        );
        let first = watchers.open("alice", "repo", "/workspace", None).await;
        let second = watchers.open("alice", "repo", "/workspace", None).await;
        let other = watchers.open("bob", "repo", "/workspace", None).await;
        let task = watchers
            .inner
            .lock()
            .unwrap()
            .get(&first.key)
            .unwrap()
            .task
            .abort_handle();
        assert_eq!(watchers.active_count(), 2);
        drop(first);
        assert_eq!(watchers.active_count(), 2);
        drop(second);
        assert_eq!(watchers.active_count(), 1);
        drop(other);
        assert_eq!(watchers.active_count(), 0);
        tokio::task::yield_now().await;
        assert!(task.is_finished());
    }

    #[test]
    fn duplicate_snapshots_do_not_fill_the_event_channel() {
        let (events, mut rx) = broadcast::channel(1);
        let latest = Mutex::new(None);
        let event = ArtifactWatchEvent {
            artifacts: vec![],
            stale: false,
            error: None,
        };
        publish(&events, &latest, event.clone());
        publish(&events, &latest, event);
        assert!(rx.try_recv().is_ok());
        assert!(matches!(
            rx.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ));
    }

    fn remote() -> RemoteArtifact {
        RemoteArtifact {
            id: "artifact".into(),
            user_id: "alice".into(),
            scope: ArtifactScope::Project,
            repository_key: "repo".into(),
            thread_id: None,
            content: "initial".into(),
            content_type: ArtifactContentType::Markdown,
            title: "Notes".into(),
            revision: 1,
            created_at: 1,
            updated_at: 1,
        }
    }

    async fn setup() -> (tempfile::TempDir, ArtifactFeed) {
        let dir = tempfile::tempdir().unwrap();
        let key = WatchKey {
            user_id: "alice".into(),
            repository_key: "repo".into(),
            workspace_path: dir.path().to_str().unwrap().into(),
            thread_id: None,
        };
        let bindings =
            ArtifactBindings::new(&dir.path().join("data"), "deployment", "alice", dir.path());
        let mut feed = ArtifactFeed::new(key, bindings);
        feed.apply_registry(vec![remote()]);
        (dir, feed)
    }

    async fn bind(feed: &ArtifactFeed) {
        let mut guard = feed.bindings.lock().await.unwrap();
        guard
            .bind(ArtifactBinding {
                registration_id: "registration".into(),
                artifact_id: Some("artifact".into()),
                scope: "project".into(),
                thread_id: None,
                local_path: "notes.md".into(),
                content_hash: content_hash("initial"),
            })
            .unwrap();
        guard.persist().await.unwrap();
    }

    #[tokio::test]
    async fn unbound_artifacts_use_cloud_without_creating_files() {
        let (dir, mut feed) = setup().await;
        feed.refresh().await.unwrap();
        let view = &feed.local["artifact"];
        assert_eq!(view.remote.content, "initial");
        assert_eq!(view.local_path, None);
        assert!(feed.pending.is_empty());
        assert!(!dir.path().join("notes.md").exists());
    }

    #[tokio::test]
    async fn baseline_survives_restart_and_detects_conflicts() {
        let (dir, mut feed) = setup().await;
        bind(&feed).await;
        tokio::fs::write(dir.path().join("notes.md"), "initial")
            .await
            .unwrap();
        let mut newer = remote();
        newer.content = "cloud edit".into();
        newer.revision = 2;
        feed.apply_registry(vec![newer]);
        feed.refresh().await.unwrap();
        assert_eq!(feed.local["artifact"].remote.content, "cloud edit");
        assert!(feed.pending.is_empty());
        tokio::fs::write(dir.path().join("notes.md"), "local edit")
            .await
            .unwrap();
        feed.refresh().await.unwrap();
        assert_eq!(feed.local["artifact"].remote.content, "local edit");
        assert!(
            feed.local["artifact"]
                .local_error
                .as_ref()
                .unwrap()
                .contains("Both")
        );
        assert!(feed.pending.is_empty());
    }

    #[tokio::test]
    async fn local_edits_sync_but_missing_files_are_not_recreated() {
        let (dir, mut feed) = setup().await;
        bind(&feed).await;
        let path = dir.path().join("notes.md");
        tokio::fs::write(&path, "local edit").await.unwrap();
        feed.refresh().await.unwrap();
        assert_eq!(feed.pending.len(), 1);
        assert_eq!(feed.pending[0].artifact.revision, 1);
        tokio::fs::remove_file(&path).await.unwrap();
        feed.refresh().await.unwrap();
        assert!(feed.pending.is_empty());
        assert_eq!(feed.local["artifact"].remote.content, "local edit");
        assert!(feed.local["artifact"].local_error.is_some());
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn interrupted_sync_ack_reconciles_baseline() {
        let (dir, mut feed) = setup().await;
        bind(&feed).await;
        tokio::fs::write(dir.path().join("notes.md"), "synced")
            .await
            .unwrap();
        let mut synced = remote();
        synced.content = "synced".into();
        feed.apply_registry(vec![synced]);
        feed.refresh().await.unwrap();
        assert_eq!(
            feed.bindings
                .lock()
                .await
                .unwrap()
                .get("artifact")
                .unwrap()
                .content_hash,
            content_hash("synced")
        );
        tokio::fs::write(dir.path().join("notes.md"), "next")
            .await
            .unwrap();
        feed.refresh().await.unwrap();
        assert_eq!(feed.pending.len(), 1);
    }

    #[tokio::test]
    async fn previews_continue_while_a_sync_holds_the_binding_lock() {
        let (dir, mut feed) = setup().await;
        bind(&feed).await;
        let _in_flight = feed.bindings.lock().await.unwrap();
        for content in ["first edit", "second edit"] {
            tokio::fs::write(dir.path().join("notes.md"), content)
                .await
                .unwrap();
            timeout(Duration::from_millis(500), feed.refresh())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(feed.local["artifact"].remote.content, content);
            assert_eq!(feed.pending[0].content, content);
        }
    }

    #[tokio::test]
    async fn flush_saves_readable_files_before_reporting_missing_ones() {
        let (dir, mut feed) = setup().await;
        bind(&feed).await;
        tokio::fs::write(dir.path().join("notes.md"), "final edit")
            .await
            .unwrap();
        let missing = RemoteArtifact {
            id: "missing".into(),
            ..remote()
        };
        let mut guard = feed.bindings.lock().await.unwrap();
        guard
            .bind(ArtifactBinding {
                registration_id: "missing".into(),
                artifact_id: Some("missing".into()),
                scope: "project".into(),
                thread_id: None,
                local_path: "missing.md".into(),
                content_hash: content_hash("initial"),
            })
            .unwrap();
        guard.persist().await.unwrap();
        drop(guard);
        let registry = Mutex::new(vec![remote(), missing]);
        let result = flush_feed(
            &mut feed,
            || std::future::ready(Ok(registry.lock().unwrap().clone())),
            |request| {
                let mut registry = registry.lock().unwrap();
                registry[0].content = request.content;
                registry[0].revision += 1;
                std::future::ready(Ok(()))
            },
        )
        .await;
        assert!(result.is_err());
        assert_eq!(registry.lock().unwrap()[0].content, "final edit");
        assert!(!dir.path().join("missing.md").exists());
    }

    #[tokio::test]
    async fn flush_reloads_if_another_watcher_advanced_the_baseline() {
        let (dir, mut feed) = setup().await;
        bind(&feed).await;
        tokio::fs::write(dir.path().join("notes.md"), "synced")
            .await
            .unwrap();
        let mut guard = feed.bindings.lock().await.unwrap();
        let mut binding = guard.get("artifact").unwrap().clone();
        binding.content_hash = content_hash("synced");
        guard.bind(binding).unwrap();
        guard.persist().await.unwrap();
        drop(guard);
        let mut loads = 0;
        flush_feed(
            &mut feed,
            || {
                loads += 1;
                let artifact = if loads == 1 {
                    remote()
                } else {
                    RemoteArtifact {
                        content: "synced".into(),
                        revision: 2,
                        ..remote()
                    }
                };
                std::future::ready(Ok(vec![artifact]))
            },
            |_| {
                std::future::ready(Err(anyhow::anyhow!(
                    "Already synced; no write should be needed"
                )))
            },
        )
        .await
        .unwrap();
        assert!(loads >= 2);
    }

    #[tokio::test]
    async fn registry_filters_account_repository_and_thread() {
        let (_dir, mut feed) = setup().await;
        for artifact in [
            RemoteArtifact {
                user_id: "bob".into(),
                ..remote()
            },
            RemoteArtifact {
                repository_key: "other".into(),
                ..remote()
            },
            RemoteArtifact {
                scope: ArtifactScope::Thread,
                thread_id: Some("private".into()),
                ..remote()
            },
        ] {
            feed.apply_registry(vec![artifact]);
            feed.refresh().await.unwrap();
            assert!(feed.local.is_empty());
        }
    }
}
