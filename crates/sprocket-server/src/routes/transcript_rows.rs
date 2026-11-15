use std::collections::HashSet;
use std::ops::Range;
use std::time::Duration;

use futures::StreamExt;
use futures::stream::{self, BoxStream, unfold};
use serde::{Deserialize, Serialize};
use sprocket_host::transcript_watch::TranscriptWatchSession;
use sprocket_transcript::rows::{
    ProjectionScope, TranscriptRow, TranscriptSnapshot, completion_source_key, project_rows,
};
use sprocket_transcript::{LiveCompletionOverlay, LiveCompletionWatchEvent, TranscriptPart};
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
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum TranscriptRowsEvent {
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
) -> anyhow::Result<SavedWindow> {
    let store = &state.host.transcript;
    let metadata = store.load_state(user, thread).await?;
    if let Some(run) = scope.run_id() {
        let range = store
            .read_run_range(user, thread, run)
            .await?
            .unwrap_or(0..0);
        return Ok(SavedWindow {
            parts: store
                .read_parts_range(user, thread, range.start, range.end)
                .await?,
            window: range,
            next_before: None,
            stale: metadata.stale,
        });
    }
    let end = before
        .unwrap_or(metadata.remote_total_parts)
        .min(metadata.remote_total_parts);
    let tail_start = fixed_start
        .unwrap_or(end.saturating_sub(PAGE_PARTS))
        .min(end);
    let tail = store
        .read_parts_range(user, thread, tail_start, end)
        .await?;
    let mut start = tail_start;
    if fixed_start.is_none()
        && let Some(last) = tail.iter().rev().find(|part| {
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
        && let Some(range) = store.read_run_range(user, thread, &last.run_id).await?
    {
        start = start.max(range.start);
    }
    let context_start = if let Some(first) = tail.iter().find(|part| part.number >= start) {
        store
            .read_run_range(user, thread, &first.run_id)
            .await?
            .map_or(start, |range| range.start)
    } else {
        start
    };
    let parts = if context_start == tail_start {
        tail
    } else {
        store
            .read_parts_range(user, thread, context_start, end)
            .await?
    };
    Ok(SavedWindow {
        parts,
        window: start..end,
        next_before: (start > 0).then_some(start),
        stale: metadata.stale,
    })
}

async fn project_window(
    state: &AppState,
    user: &str,
    thread: &str,
    scope: &ProjectionScope,
    saved: &SavedWindow,
    live: &[LiveCompletionOverlay],
) -> TranscriptSnapshot {
    let mut snapshot = project_rows(
        &saved.parts,
        live,
        scope,
        saved.window.clone(),
        saved.stale,
        &state.host.transcript.thread_dir(user, thread),
    )
    .await;
    snapshot.next_before = saved.next_before;
    snapshot
}

pub(crate) async fn project(
    state: &AppState,
    user: &str,
    thread: &str,
    scope: ProjectionScope,
    before: Option<u32>,
) -> Result<TranscriptSnapshot, ApiError> {
    let saved = load_window(state, user, thread, &scope, before, None)
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

async fn watch(
    state: &AppState,
    user: String,
    thread: String,
    scope: ProjectionScope,
    boundary: Option<u32>,
) -> Result<BoxStream<'static, TranscriptRowsEvent>, ApiError> {
    let session = state.host.transcript_watchers.open(&user, &thread).await;
    let subscription = state.host.live_completions.subscribe(&thread);
    let saved = load_window(state, &user, &thread, &scope, None, boundary)
        .await
        .map_err(ApiError::internal)?;
    let window_start = boundary.or_else(|| (saved.window.end > 0).then_some(saved.window.start));
    let live = LiveWindow {
        overlays: subscription.snapshot.into_iter().collect(),
        ..LiveWindow::default()
    };
    let snapshot = project_window(state, &user, &thread, &scope, &saved, &live.overlays).await;
    let events = unfold(
        Watch {
            state: state.clone(),
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
        },
        next_event,
    );
    Ok(stream::iter([TranscriptRowsEvent::Snapshot { snapshot }])
        .chain(events)
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
                        watch.window_start).await {
                        Ok(saved) => {
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
