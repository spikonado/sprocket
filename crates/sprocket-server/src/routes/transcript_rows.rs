use std::collections::HashSet;
use std::future::Future;
use std::ops::Range;
use std::time::Duration;

use futures::future::BoxFuture;
use futures::stream::{BoxStream, unfold};
use futures::{FutureExt, StreamExt};
use serde::{Deserialize, Serialize};
use sprocket_host::transcript_watch::TranscriptWatchSession;
use sprocket_transcript::rows::{
    ProjectionScope, ToolResults, TranscriptRow, completion_source_key, project_rows,
    saved_work_blocks,
};
use sprocket_transcript::{
    LiveCompletionOverlay, LiveCompletionWatchEvent, TranscriptPart, TranscriptStore,
};
use tokio::sync::broadcast;
use tokio::time::Instant;

use crate::AppState;
use crate::routes::api_error::ApiError;
use crate::routes::events::Authorized;
use crate::routes::session::UserScoped;
use crate::routes::transcript::{deserialize_path_safe_id, deserialize_row_id};

const PAGE_PARTS: u32 = 200;
const UPDATE_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TranscriptRowsScope {
    pub(crate) user_id: String,
    #[serde(deserialize_with = "deserialize_path_safe_id")]
    pub(crate) thread_id: String,
    pub(crate) before: Option<u32>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TranscriptRowScope {
    pub(crate) user_id: String,
    #[serde(deserialize_with = "deserialize_path_safe_id")]
    pub(crate) thread_id: String,
    #[serde(deserialize_with = "deserialize_row_id")]
    pub(crate) row_id: String,
}

impl UserScoped for TranscriptRowsScope {
    fn user_id(&self) -> &str {
        &self.user_id
    }
}

impl UserScoped for TranscriptRowScope {
    fn user_id(&self) -> &str {
        &self.user_id
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TranscriptSnapshot {
    pub(crate) rows: Vec<TranscriptRow>,
    next_before: Option<u32>,
    stale: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum TranscriptRowsEvent {
    /// Sent before the first snapshot when it waits on parts from Convex.
    Downloading,
    Snapshot {
        #[serde(flatten)]
        snapshot: TranscriptSnapshot,
    },
    Batch {
        updates: Vec<TranscriptRowUpdate>,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum TranscriptRowUpdate {
    Row {
        row: TranscriptRow,
    },
    Append {
        row_id: String,
        offset: usize,
        text: String,
    },
}

struct SavedWindow {
    parts: Vec<TranscriptPart>,
    window: Range<u32>,
    next_before: Option<u32>,
    stale: bool,
}

async fn load_window(
    state: &AppState,
    user: &str,
    thread: &str,
    scope: &ProjectionScope,
    before: Option<u32>,
    fixed_start: Option<u32>,
    on_download: &(dyn Fn() + Sync),
) -> anyhow::Result<SavedWindow> {
    load_store_window(
        &state.host.transcript,
        user,
        thread,
        scope,
        before,
        fixed_start,
        |start, end| async move {
            on_download();
            state
                .host
                .convex_client_for(user)
                .await?
                .transcript_parts_page(thread, start, end)
                .await
        },
    )
    .await
}

/// An empty cache has no highwater to page back from, so its newest page starts at Convex's total.
async fn download_newest_page_if_uncached(
    state: &AppState,
    user: &str,
    thread: &str,
    on_download: &(dyn Fn() + Sync),
) -> anyhow::Result<()> {
    let store = &state.host.transcript;
    if !store.part_numbers(user, thread).await?.is_empty() {
        return Ok(());
    }
    let client = state.host.convex_client_for(user).await?;
    let total = client.transcript_total_parts(thread).await?;
    store
        .ensure_parts(
            user,
            thread,
            total.saturating_sub(PAGE_PARTS),
            total,
            |start, end| {
                on_download();
                client.transcript_parts_page(thread, start, end)
            },
        )
        .await
}

async fn load_store_window<F, Fut>(
    store: &TranscriptStore,
    user: &str,
    thread: &str,
    scope: &ProjectionScope,
    before: Option<u32>,
    fixed_start: Option<u32>,
    mut fetch: F,
) -> anyhow::Result<SavedWindow>
where
    F: FnMut(u32, u32) -> Fut,
    Fut: Future<Output = anyhow::Result<Vec<TranscriptPart>>>,
{
    let _lease = store.open_thread(user, thread).await?;
    let numbers = store.part_numbers(user, thread).await?;
    let highwater = numbers.last().map_or(0, |number| number.saturating_add(1));
    if scope.run_id().is_some() {
        let parts = load_detail(store, user, thread, scope, highwater, &mut fetch).await?;
        let window = parts.first().map_or(0, |part| part.number)
            ..parts.last().map_or(0, |part| part.number.saturating_add(1));
        return Ok(SavedWindow {
            parts,
            window,
            next_before: None,
            stale: false,
        });
    }
    let end = before.unwrap_or(highwater);
    // A tail page that lands past a wide gap moves the window instead of downloading the gap first.
    let fixed_start = fixed_start.filter(|start| {
        let cached = numbers.len() - numbers.partition_point(|number| number < start);
        (end.saturating_sub(*start) as usize).saturating_sub(cached) <= PAGE_PARTS as usize
    });
    let mut start = fixed_start
        .unwrap_or(end.saturating_sub(PAGE_PARTS))
        .min(end);
    store
        .ensure_parts(user, thread, start, end, &mut fetch)
        .await?;
    let mut parts = store.read_parts_range(user, thread, start, end).await?;
    if fixed_start.is_none()
        && let Some(last) = parts.iter().rev().find(|part| {
            part.prompt
                .as_ref()
                .is_some_and(|prompt| prompt.hidden.is_none())
                || part
                    .tool
                    .as_ref()
                    .is_some_and(|tool| tool.status != "started")
                || part.content_items().iter().any(|item| {
                    item["type"] == "tool-call"
                        || matches!(item["type"].as_str(), Some("text" | "reasoning"))
                            && item["text"]
                                .as_str()
                                .is_some_and(|text| !text.trim().is_empty())
                })
        })
        && let Some(boundary) = parts
            .iter()
            .position(|part| part.run_id == last.run_id && is_run_origin(part))
    {
        start = parts[boundary].number;
        parts.drain(..boundary);
    }
    let parts = complete_prefix(store, user, thread, parts, scope, &mut fetch).await?;
    Ok(SavedWindow {
        parts,
        window: start..end,
        next_before: (start > 0).then_some(start),
        stale: false,
    })
}

async fn load_detail<F, Fut>(
    store: &TranscriptStore,
    user: &str,
    thread: &str,
    scope: &ProjectionScope,
    highwater: u32,
    fetch: &mut F,
) -> anyhow::Result<Vec<TranscriptPart>>
where
    F: FnMut(u32, u32) -> Fut,
    Fut: Future<Output = anyhow::Result<Vec<TranscriptPart>>>,
{
    let source = scope
        .source_key()
        .ok_or_else(|| anyhow::anyhow!("invalid transcript row ID"))?;
    let run = scope.run_id().unwrap();
    let target = scope.row_id().unwrap();
    // Row IDs come from cached parts or the live completion, so an uncached source is unsaved.
    let Some(number) = store.source_number(user, thread, source).await? else {
        return Ok(Vec::new());
    };
    let mut parts = store.read_parts(user, thread, &[number]).await?;
    if target.starts_with("work:") {
        let mut start = number.saturating_add(1);
        while start < highwater
            && !saved_work_blocks(&parts)
                .iter()
                .any(|block| block.id == target && block.closed)
        {
            let end = start.saturating_add(PAGE_PARTS).min(highwater);
            let cached = store.read_parts_range(user, thread, start, end).await?;
            let mut contiguous_end = start;
            for part in cached {
                if part.number != contiguous_end {
                    break;
                }
                contiguous_end += 1;
                if part.run_id == run {
                    parts.push(part);
                }
            }
            if saved_work_blocks(&parts)
                .iter()
                .any(|block| block.id == target && block.closed)
            {
                break;
            }
            store
                .ensure_parts(user, thread, contiguous_end, end, &mut *fetch)
                .await?;
            parts.extend(
                store
                    .read_parts_range(user, thread, contiguous_end, end)
                    .await?
                    .into_iter()
                    .filter(|part| part.run_id == run),
            );
            start = end;
        }
        let blocks = saved_work_blocks(&parts);
        let Some(block) = blocks.iter().find(|block| block.id == target) else {
            return Ok(parts);
        };
        let mut wanted: HashSet<_> = block.items.iter().map(|position| position.part).collect();
        if block.closed
            && let Some(last) = block.items.last()
            && let Some(closing) = parts.iter().find(|part| {
                part.number >= last.part
                    && starts_with_closing_text(part, last.part, last.item as usize)
            })
        {
            wanted.insert(closing.number);
        }
        let results = ToolResults::new(&parts);
        for position in &block.items {
            let part = parts
                .iter()
                .find(|part| part.number == position.part)
                .unwrap();
            if let Some(item) = part.content_items().get(position.item as usize)
                && let Some(result) = results.get(part, item, true)
            {
                wanted.insert(result.number);
            }
        }
        parts.retain(|part| wanted.contains(&part.number));
    }
    let calls: Vec<_> = if target.starts_with("work:") {
        saved_work_blocks(&parts)
            .into_iter()
            .find(|block| block.id == target)
            .into_iter()
            .flat_map(|block| block.items)
            .filter_map(|position| {
                let part = parts.iter().find(|part| part.number == position.part)?;
                (part.content_items().get(position.item as usize)?["type"] == "tool-call")
                    .then_some((position.part, position.item as usize))
            })
            .collect()
    } else {
        parts
            .iter()
            .flat_map(|part| {
                part.content_items()
                    .iter()
                    .enumerate()
                    .filter(move |(offset, item)| {
                        item["type"] == "tool-call"
                            && sprocket_transcript::work_blocks::item_id("tool", part, *offset)
                                == target
                    })
                    .map(move |(offset, _)| (part.number, offset))
            })
            .collect()
    };
    let invocations: Vec<_> = calls
        .iter()
        .filter_map(|(number, offset)| {
            parts
                .iter()
                .find(|part| part.number == *number)?
                .content_items()[*offset]["toolInvocationId"]
                .as_str()
                .map(str::to_owned)
        })
        .collect();
    for invocation in invocations {
        if let Some(result) = store
            .source_number(user, thread, &format!("tool:{invocation}:finished"))
            .await?
            && !parts.iter().any(|part| part.number == result)
        {
            parts.extend(store.read_parts(user, thread, &[result]).await?);
        }
    }
    let unresolved = |parts: &[TranscriptPart], earlier: bool| {
        let results = ToolResults::new(parts);
        calls.iter().any(|(number, offset)| {
            let part = parts.iter().find(|part| part.number == *number).unwrap();
            let item = &part.content_items()[*offset];
            (!earlier || item["toolInvocationId"].as_str().is_none() && item["callId"].is_string())
                && results.get(part, item, true).is_none()
        })
    };
    let retained: HashSet<_> = parts.iter().map(|part| part.number).collect();
    let origin = store
        .source_number(user, thread, &format!("prompt:{run}"))
        .await?
        .unwrap_or(0);
    let mut after = number.saturating_add(1);
    let mut before = number;
    while unresolved(&parts, false)
        && (after < highwater || before > origin && unresolved(&parts, true))
    {
        let earlier = after >= highwater;
        let (start, end) = if after < highwater {
            let start = after;
            after = start.saturating_add(PAGE_PARTS).min(highwater);
            (start, after)
        } else {
            let end = before;
            before = end.saturating_sub(PAGE_PARTS).max(origin);
            (before, end)
        };
        store
            .ensure_parts(user, thread, start, end, &mut *fetch)
            .await?;
        let mut page = store.read_parts_range(user, thread, start, end).await?;
        if earlier
            && let Some(boundary) = page
                .iter()
                .rposition(|part| part.run_id == run && is_run_origin(part))
        {
            page.drain(..boundary);
            before = origin;
        }
        let page = page
            .into_iter()
            .filter(|part| {
                part.run_id == run
                    && part
                        .tool
                        .as_ref()
                        .is_some_and(|tool| tool.status != "started")
                    && !parts.iter().any(|saved| saved.number == part.number)
            })
            .collect::<Vec<_>>();
        parts.extend(page);
        let results = ToolResults::new(&parts);
        let wanted: HashSet<_> = calls
            .iter()
            .filter_map(|(number, offset)| {
                let part = parts.iter().find(|part| part.number == *number).unwrap();
                results
                    .get(part, &part.content_items()[*offset], true)
                    .map(|result| result.number)
            })
            .collect();
        parts.retain(|part| retained.contains(&part.number) || wanted.contains(&part.number));
    }
    parts.sort_by_key(|part| part.number);
    Ok(parts)
}

fn starts_with_closing_text(part: &TranscriptPart, last_part: u32, last_item: usize) -> bool {
    part.content_items()
        .iter()
        .enumerate()
        .any(|(offset, item)| {
            (part.number > last_part || offset > last_item)
                && item["type"] == "text"
                && item["text"]
                    .as_str()
                    .is_some_and(|text| !text.trim().is_empty())
        })
}

fn is_run_origin(part: &TranscriptPart) -> bool {
    part.prompt
        .as_ref()
        .is_some_and(|prompt| prompt.hidden.is_none())
}

fn is_hidden_prompt(part: &TranscriptPart) -> bool {
    part.prompt
        .as_ref()
        .is_some_and(|prompt| prompt.hidden.is_some())
}

/// Tracks runs whose earliest loaded prompt or completion is a hidden prompt.
fn note_turn(hidden_starts: &mut HashSet<String>, part: &TranscriptPart) {
    if part.tool.is_some() {
        return;
    }
    if is_hidden_prompt(part) {
        hidden_starts.insert(part.run_id.clone());
    } else {
        hidden_starts.remove(&part.run_id);
    }
}

fn starts_with_text(part: &TranscriptPart) -> bool {
    for item in part.content_items() {
        match item["type"].as_str() {
            Some("text" | "reasoning")
                if item["text"]
                    .as_str()
                    .is_some_and(|text| !text.trim().is_empty()) =>
            {
                return item["type"] == "text";
            }
            Some("tool-call") => return false,
            _ => {}
        }
    }
    false
}

async fn complete_prefix<F, Fut>(
    store: &TranscriptStore,
    user: &str,
    thread: &str,
    parts: Vec<TranscriptPart>,
    scope: &ProjectionScope,
    fetch: &mut F,
) -> anyhow::Result<Vec<TranscriptPart>>
where
    F: FnMut(u32, u32) -> Fut,
    Fut: Future<Output = anyhow::Result<Vec<TranscriptPart>>>,
{
    let result_runs: HashSet<_> = parts
        .iter()
        .filter(|part| {
            part.tool
                .as_ref()
                .is_some_and(|tool| tool.status != "started")
        })
        .map(|part| part.run_id.clone())
        .collect();
    let boundary = |part: &TranscriptPart| {
        is_run_origin(part)
            || matches!(scope, ProjectionScope::Thread)
                && !result_runs.contains(&part.run_id)
                && starts_with_text(part)
    };
    let mut seen = HashSet::new();
    let mut pending = HashSet::new();
    let mut after_turn = false;
    for part in &parts {
        if seen.insert(&part.run_id) && !boundary(part) && !(after_turn && is_hidden_prompt(part)) {
            pending.insert(part.run_id.clone());
        }
        after_turn |= part.tool.is_none();
    }
    if pending.is_empty() {
        return Ok(parts);
    }
    // Runs in a thread never overlap; only late tool results land after the next run starts.
    // So a hidden prompt right after another run's prompt or completion begins a continuation run.
    let mut hidden_starts = HashSet::new();
    for part in parts.iter().rev() {
        note_turn(&mut hidden_starts, part);
    }
    let mut prefix = Vec::new();
    let mut end = parts.first().map_or(0, |part| part.number);
    while !pending.is_empty() && end > 0 {
        let start = end.saturating_sub(PAGE_PARTS);
        store
            .ensure_parts(user, thread, start, end, &mut *fetch)
            .await?;
        for part in store
            .read_parts_range(user, thread, start, end)
            .await?
            .into_iter()
            .rev()
        {
            if part.tool.is_none() {
                pending.retain(|run| *run == part.run_id || !hidden_starts.contains(run));
            }
            if !pending.contains(&part.run_id) {
                continue;
            }
            if boundary(&part) {
                pending.remove(&part.run_id);
            }
            note_turn(&mut hidden_starts, &part);
            prefix.push(part);
        }
        end = start;
    }
    prefix.reverse();
    prefix.extend(parts);
    Ok(prefix)
}

async fn project_window(
    state: &AppState,
    user: &str,
    thread: &str,
    scope: &ProjectionScope,
    saved: &SavedWindow,
    live: &[LiveCompletionOverlay],
) -> TranscriptSnapshot {
    TranscriptSnapshot {
        rows: project_rows(
            &saved.parts,
            live,
            scope,
            saved.window.clone(),
            &state.host.transcript.thread_dir(user, thread),
        )
        .await,
        next_before: saved.next_before,
        stale: saved.stale,
    }
}

pub(crate) async fn project(
    state: &AppState,
    user: &str,
    thread: &str,
    scope: ProjectionScope,
    before: Option<u32>,
) -> Result<TranscriptSnapshot, ApiError> {
    let saved = load_window(state, user, thread, &scope, before, None, &|| {})
        .await
        .map_err(ApiError::internal)?;
    let live = if before.is_none() {
        state
            .host
            .live_completions
            .snapshot(thread)
            .into_iter()
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    Ok(project_window(state, user, thread, &scope, &saved, &live).await)
}

pub(crate) async fn watch_rows(
    state: &AppState,
    scope: Authorized<TranscriptRowsScope>,
) -> Result<BoxStream<'static, TranscriptRowsEvent>, ApiError> {
    let scope = scope.into_inner();
    watch(
        state,
        scope.user_id,
        scope.thread_id,
        ProjectionScope::Thread,
        scope.before,
    )
    .await
}

pub(crate) async fn watch_work(
    state: &AppState,
    scope: Authorized<TranscriptRowScope>,
) -> Result<BoxStream<'static, TranscriptRowsEvent>, ApiError> {
    let scope = scope.into_inner();
    watch(
        state,
        scope.user_id,
        scope.thread_id,
        ProjectionScope::Work(scope.row_id),
        None,
    )
    .await
}

pub(crate) async fn watch_item(
    state: &AppState,
    scope: Authorized<TranscriptRowScope>,
) -> Result<BoxStream<'static, TranscriptRowsEvent>, ApiError> {
    let scope = scope.into_inner();
    watch(
        state,
        scope.user_id,
        scope.thread_id,
        ProjectionScope::Item(scope.row_id),
        None,
    )
    .await
}

#[derive(Default)]
struct LiveWindow {
    overlays: Vec<LiveCompletionOverlay>,
    phase: LivePhase,
}

#[derive(Default)]
enum LivePhase {
    #[default]
    Streaming,
    Cleared,
}

impl LiveWindow {
    fn update(&mut self, event: LiveCompletionWatchEvent) {
        match event {
            LiveCompletionWatchEvent::Updated { live } => {
                if matches!(self.phase, LivePhase::Cleared)
                    && self
                        .overlays
                        .last()
                        .is_some_and(|previous| previous.run_id == live.run_id)
                {
                    self.overlays.pop();
                }
                self.phase = LivePhase::Streaming;
                if let Some(previous) = self
                    .overlays
                    .iter_mut()
                    .find(|previous| previous.stream_id == live.stream_id)
                {
                    *previous = live;
                } else {
                    for previous in &mut self.overlays {
                        previous.run_status = sprocket_convex::RunStatus::Completed;
                    }
                    self.overlays.push(live);
                }
            }
            LiveCompletionWatchEvent::Cleared => {
                self.phase = LivePhase::Cleared;
                for previous in &mut self.overlays {
                    previous.run_status = sprocket_convex::RunStatus::Completed;
                }
            }
        }
    }

    fn remove_saved(&mut self, parts: &[TranscriptPart]) {
        let sources: HashSet<_> = parts.iter().map(|part| part.source_key.as_str()).collect();
        self.overlays.retain(|live| {
            !live.run_status.is_final() || !sources.contains(completion_source_key(live).as_str())
        });
    }
}

struct Watch {
    state: AppState,
    user: String,
    thread: String,
    scope: ProjectionScope,
    session: TranscriptWatchSession,
    live_events: broadcast::Receiver<LiveCompletionWatchEvent>,
    saved: SavedWindow,
    window_start: Option<u32>,
    live: LiveWindow,
    previous: TranscriptSnapshot,
    next_send: Instant,
}

enum Refresh {
    Idle,
    Project,
    Reload,
}

enum Phase {
    Loading {
        load: BoxFuture<'static, anyhow::Result<(TranscriptSnapshot, Watch)>>,
        downloading: tokio::sync::watch::Receiver<bool>,
    },
    Watching(Box<Watch>),
}

async fn watch(
    state: &AppState,
    user: String,
    thread: String,
    scope: ProjectionScope,
    boundary: Option<u32>,
) -> Result<BoxStream<'static, TranscriptRowsEvent>, ApiError> {
    let (downloads, downloading) = tokio::sync::watch::channel(false);
    let state = state.clone();
    let load = async move {
        let on_download = || {
            downloads.send_if_modified(|downloading| !std::mem::replace(downloading, true));
        };
        let _lease = state.host.transcript.open_thread(&user, &thread).await?;
        let session = state.host.transcript_watchers.open(&user, &thread).await;
        let subscription = state.host.live_completions.subscribe(&thread);
        if matches!(scope, ProjectionScope::Thread) {
            download_newest_page_if_uncached(&state, &user, &thread, &on_download).await?;
        }
        let mut saved =
            load_window(&state, &user, &thread, &scope, None, boundary, &on_download).await?;
        saved.stale = session.stale();
        let window_start =
            boundary.or_else(|| (saved.window.end > 0).then_some(saved.window.start));
        let live = LiveWindow {
            overlays: subscription.snapshot.into_iter().collect(),
            ..LiveWindow::default()
        };
        let snapshot = project_window(&state, &user, &thread, &scope, &saved, &live.overlays).await;
        let watch = Watch {
            state,
            user,
            thread,
            scope,
            session,
            live_events: subscription.receiver,
            saved,
            window_start,
            live,
            previous: snapshot.clone(),
            next_send: Instant::now() + UPDATE_INTERVAL,
        };
        Ok((snapshot, watch))
    };
    let phase = Phase::Loading {
        load: load.boxed(),
        downloading,
    };
    Ok(unfold(phase, |phase| async move {
        match phase {
            Phase::Loading {
                mut load,
                mut downloading,
            } => tokio::select! {
                biased;
                result = &mut load => match result {
                    Ok((snapshot, watch)) => Some((
                        TranscriptRowsEvent::Snapshot { snapshot },
                        Phase::Watching(Box::new(watch)),
                    )),
                    Err(error) => {
                        tracing::warn!("could not load transcript rows: {error:#}");
                        None
                    }
                },
                Ok(()) = downloading.changed() => Some((
                    TranscriptRowsEvent::Downloading,
                    Phase::Loading { load, downloading },
                )),
            },
            Phase::Watching(watch) => next_event(*watch)
                .await
                .map(|(event, watch)| (event, Phase::Watching(Box::new(watch)))),
        }
    })
    .boxed())
}

async fn next_event(mut watch: Watch) -> Option<(TranscriptRowsEvent, Watch)> {
    let mut refresh = Refresh::Idle;
    loop {
        tokio::select! {
            event = watch.session.receiver().recv() => {
                if matches!(event, Err(broadcast::error::RecvError::Closed)) { return None; }
                refresh = Refresh::Reload;
            }
            event = watch.live_events.recv() => {
                let event = match event {
                    Ok(event) => event,
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        let subscription = watch.state.host.live_completions.subscribe(&watch.thread);
                        watch.live_events = subscription.receiver;
                        refresh = Refresh::Reload;
                        subscription.snapshot.map_or(LiveCompletionWatchEvent::Cleared,
                            |live| LiveCompletionWatchEvent::Updated { live })
                    }
                    Err(broadcast::error::RecvError::Closed) => return None,
                };
                if matches!(&event, LiveCompletionWatchEvent::Updated { live }
                    if watch.live.overlays.last().is_none_or(|previous| previous.stream_id != live.stream_id)) {
                    refresh = Refresh::Reload;
                } else if matches!(refresh, Refresh::Idle) {
                    refresh = Refresh::Project;
                }
                watch.live.update(event);
            }
            _ = tokio::time::sleep_until(watch.next_send), if !matches!(refresh, Refresh::Idle) => {
                if matches!(refresh, Refresh::Reload) {
                    match load_window(&watch.state, &watch.user, &watch.thread, &watch.scope, None,
                        watch.window_start, &|| {}).await {
                        Ok(mut saved) => {
                            saved.stale = watch.session.stale();
                            if saved.window.end > 0 {
                                watch.window_start = Some(saved.window.start);
                            }
                            watch.saved = saved;
                        },
                        Err(error) => {
                            tracing::warn!(thread = %watch.thread, "could not project transcript rows: {error:#}");
                            watch.previous.stale = true;
                            watch.saved.stale = true;
                            watch.next_send = Instant::now() + UPDATE_INTERVAL;
                            let snapshot = watch.previous.clone();
                            return Some((TranscriptRowsEvent::Snapshot { snapshot }, watch));
                        }
                    }
                }
                watch.live.remove_saved(&watch.saved.parts);
                let snapshot = project_window(&watch.state, &watch.user, &watch.thread, &watch.scope,
                    &watch.saved, &watch.live.overlays).await;
                let event = diff(&watch.previous, &snapshot);
                watch.previous = snapshot;
                watch.next_send = Instant::now() + UPDATE_INTERVAL;
                if let Some(event) = event { return Some((event, watch)); }
                refresh = Refresh::Idle;
            }
        }
    }
}

fn diff(previous: &TranscriptSnapshot, next: &TranscriptSnapshot) -> Option<TranscriptRowsEvent> {
    if previous.stale != next.stale
        || previous.next_before != next.next_before
        || previous.rows.len() > next.rows.len()
        || previous
            .rows
            .iter()
            .zip(&next.rows)
            .any(|(previous, next)| previous.id != next.id)
    {
        return Some(TranscriptRowsEvent::Snapshot {
            snapshot: next.clone(),
        });
    }
    let mut updates = Vec::new();
    for (index, row) in next.rows.iter().enumerate() {
        if let Some(previous) = previous.rows.get(index) {
            if previous == row {
                continue;
            }
            if let (Some(before), Some(after)) = (previous.text(), row.text())
                && let Some(text) = after.strip_prefix(before)
            {
                let mut metadata = row.clone();
                metadata.set_text(before.to_owned());
                if metadata == *previous {
                    updates.push(TranscriptRowUpdate::Append {
                        row_id: row.id.clone(),
                        offset: before.encode_utf16().count(),
                        text: text.to_owned(),
                    });
                    continue;
                }
            }
        }
        updates.push(TranscriptRowUpdate::Row { row: row.clone() });
    }
    (!updates.is_empty()).then_some(TranscriptRowsEvent::Batch { updates })
}

#[cfg(test)]
mod tests;
