use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::{Stream, StreamExt, stream};
use serde::{Deserialize, Serialize};
use sprocket_convex::{decode_labeled_function_result, deserialize_convex_u64};
use sprocket_workspace::artifact_bindings::{
    ArtifactBindings, conflicting_binding_ids, content_hash,
};
use sprocket_workspace::{ArtifactContentType, read_artifact_file};
use tokio::sync::broadcast;
use tokio::time::{MissedTickBehavior, interval, timeout};

use crate::native_auth::NativeAuthManager;
use crate::transcript_client::{ArtifactSnapshot, UserConvexClient};
use crate::watch_registry::{WatchRegistry, WatchSession};

const NETWORK_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteArtifact {
    #[serde(rename = "_id")]
    pub id: String,
    pub user_id: String,
    pub repository_key: String,
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
}

pub struct ArtifactWatchers {
    deployment_url: String,
    native_auth: Arc<NativeAuthManager>,
    bindings_root: PathBuf,
    registry: Arc<ArtifactRegistry>,
}

pub struct ArtifactWatchSession {
    watchers: Arc<ArtifactWatchers>,
    key: WatchKey,
    session: ArtifactSession,
    latest: LatestEvent,
}

type LatestEvent = Arc<Mutex<Option<ArtifactWatchEvent>>>;

type ArtifactRegistry = WatchRegistry<WatchKey, ArtifactWatchEvent, LatestEvent>;

type ArtifactSession = WatchSession<WatchKey, ArtifactWatchEvent, LatestEvent>;

impl ArtifactWatchers {
    pub fn new(
        deployment_url: String,
        native_auth: Arc<NativeAuthManager>,
        bindings_root: PathBuf,
    ) -> Arc<Self> {
        Arc::new(Self {
            deployment_url,
            native_auth,
            bindings_root,
            registry: WatchRegistry::new(),
        })
    }

    pub fn bindings(&self, user_id: &str, workspace: &Path) -> ArtifactBindings {
        ArtifactBindings::new(
            &self.bindings_root,
            &self.deployment_url,
            user_id,
            workspace,
        )
    }

    pub async fn open(
        self: &Arc<Self>,
        user_id: &str,
        repository_key: &str,
        workspace_path: &str,
    ) -> ArtifactWatchSession {
        let key = WatchKey {
            user_id: user_id.into(),
            repository_key: repository_key.into(),
            workspace_path: workspace_path.into(),
        };
        // The task must not own the registry: the last session drop aborts it.
        let (session, latest) =
            self.registry
                .open_with(key.clone(), 1, || Arc::new(Mutex::new(None)), {
                    |events, latest| {
                        tokio::spawn(watch(
                            self.deployment_url.clone(),
                            Arc::clone(&self.native_auth),
                            key.clone(),
                            self.bindings(&key.user_id, Path::new(&key.workspace_path)),
                            events,
                            latest,
                        ))
                    }
                });
        ArtifactWatchSession {
            watchers: Arc::clone(self),
            key,
            session,
            latest,
        }
    }
}

impl ArtifactWatchSession {
    pub fn receiver(&mut self) -> &mut broadcast::Receiver<ArtifactWatchEvent> {
        self.session.receiver()
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
            let bindings = self
                .watchers
                .bindings(&self.key.user_id, Path::new(&self.key.workspace_path));
            let mut feed = ArtifactFeed::new(self.key.clone(), bindings.clone());
            flush_feed(
                &mut feed,
                || async {
                    Ok(client
                        .list_artifacts(&self.key.repository_key)
                        .await?
                        .artifacts)
                },
                |request| {
                    let client = &client;
                    let bindings = &bindings;
                    async move {
                        sync(
                            client,
                            bindings,
                            Path::new(&self.key.workspace_path),
                            &request,
                        )
                        .await
                    }
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
                        feed.apply_registry(snapshot.artifacts);
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
    output: tokio::sync::mpsc::Sender<anyhow::Result<ArtifactSnapshot>>,
) {
    loop {
        let outcome = async {
            let client = timeout(NETWORK_TIMEOUT, connect(&url, &auth, &key)).await??;
            let updates = timeout(
                NETWORK_TIMEOUT,
                client.subscribe_artifact_state(&key.repository_key),
            )
            .await??;
            cloud_session(
                updates.map(|result| {
                    let revision: f64 =
                        decode_labeled_function_result(result, "artifacts:getArtifactState")?;
                    Ok(revision as u64)
                }),
                &pending,
                &output,
                || client.list_artifacts(&key.repository_key),
                |request| {
                    let client = &client;
                    let bindings = &bindings;
                    let workspace = Path::new(&key.workspace_path);
                    async move { sync(client, bindings, workspace, &request).await }
                },
            )
            .await
        }
        .await;
        match outcome {
            Ok(()) => return,
            Err(error) => {
                if output.send(Err(error)).await.is_err() {
                    return;
                }
            }
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

async fn cloud_session<U, L, LF, S, SF>(
    mut updates: U,
    pending: &tokio::sync::watch::Receiver<Vec<SyncRequest>>,
    output: &tokio::sync::mpsc::Sender<anyhow::Result<ArtifactSnapshot>>,
    mut load: L,
    mut synchronize: S,
) -> anyhow::Result<()>
where
    U: Stream<Item = anyhow::Result<u64>> + Unpin,
    L: FnMut() -> LF,
    LF: std::future::Future<Output = anyhow::Result<ArtifactSnapshot>>,
    S: FnMut(SyncRequest) -> SF,
    SF: std::future::Future<Output = anyhow::Result<()>>,
{
    let first = timeout(NETWORK_TIMEOUT, updates.next())
        .await?
        .ok_or_else(|| anyhow::anyhow!("Artifact subscription ended"))??;
    let mut observed_revision = Some(first);
    let mut loaded_revision = None;
    let mut requests = Vec::new();
    let mut poll = interval(Duration::from_secs(1));
    poll.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        let had_pending = !requests.is_empty();
        for request in requests.drain(..) {
            timeout(NETWORK_TIMEOUT, synchronize(request)).await??;
        }
        // A page load can read ahead of buffered subscription updates.
        if had_pending
            || observed_revision
                .is_some_and(|next| loaded_revision.is_none_or(|loaded| next > loaded))
        {
            let snapshot = load().await?;
            if observed_revision.is_some_and(|revision| snapshot.revision < revision) {
                anyhow::bail!("Artifact registry changed during refresh; retrying");
            }
            loaded_revision = Some(snapshot.revision);
            if output.send(Ok(snapshot)).await.is_err() {
                return Ok(());
            }
        }
        tokio::select! {
            update = updates.next() => {
                observed_revision = Some(update.ok_or_else(|| anyhow::anyhow!("Artifact subscription ended"))??);
            }
            _ = poll.tick() => {
                requests = pending.borrow().clone();
                observed_revision = None;
            }
            _ = output.closed() => return Ok(()),
        }
    }
}

async fn check_auth(
    auth: Arc<NativeAuthManager>,
    user_id: String,
    output: tokio::sync::mpsc::Sender<anyhow::Result<ArtifactSnapshot>>,
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

pub fn is_native_account_revoked(error: &anyhow::Error) -> bool {
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
    workspace: &Path,
    request: &SyncRequest,
) -> anyhow::Result<()> {
    let mut guard = bindings.lock().await?;
    let Some(binding) = guard.get(&request.artifact.id) else {
        return Ok(());
    };
    if binding.local_path != request.path || binding.content_hash != request.baseline {
        return Ok(());
    }
    guard.validate_destination(workspace, binding).await?;
    if client
        .sync_artifact(
            &request.artifact.id,
            &request.artifact.repository_key,
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
        let snapshot = self.bindings.snapshot().await?;
        let conflicts =
            conflicting_binding_ids(Path::new(&self.key.workspace_path), &snapshot).await;
        let bindings: HashMap<_, _> = snapshot
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
                    .filter(|binding| !conflicts.contains(&binding.registration_id))
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
                if conflicts.contains(&binding.registration_id) {
                    view.local_error = Some("Multiple artifacts are bound to this file. Sync is paused; save or rebind the artifacts to distinct paths.".into());
                    local.insert(artifact.id.clone(), view);
                    continue;
                }
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
mod tests;
