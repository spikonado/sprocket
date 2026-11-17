use std::collections::HashSet;
use std::sync::Arc;

use futures::future::BoxFuture;
use futures::stream::{BoxStream, unfold};
use futures::{FutureExt, StreamExt};
use serde::{Deserialize, Serialize};
use sprocket_transcript::rows::{Row, RowBody, RowScope, TranscriptRow, row_source};
use tokio::sync::broadcast;
use tokio::sync::broadcast::error::RecvError;

use crate::AppState;
use crate::routes::api_error::ApiError;
use crate::routes::events::Authorized;
use crate::routes::session::UserScoped;
use crate::routes::transcript::{deserialize_path_safe_id, deserialize_row_id};

mod thread_rows;

pub(crate) use thread_rows::ThreadRowsRegistry;
use thread_rows::{Change, Shared, ThreadRowsLease, Update};

/// Work blocks list their newest items first, then older pages on request.
const WORK_PAGE_ITEMS: usize = 200;

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
    pub(crate) before: Option<u32>,
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

/// What a watch shows. `before` keeps the start of rows a browser already loaded.
#[derive(Clone, Debug)]
enum Request {
    Thread { before: Option<u32> },
    Work { id: String, before: Option<u32> },
    Item { id: String },
}

impl Request {
    fn scope(&self) -> RowScope {
        match self {
            Self::Thread { .. } => RowScope::Thread,
            Self::Work { .. } => RowScope::Work,
            Self::Item { .. } => RowScope::Item,
        }
    }

    /// Whether a row added after the snapshot belongs to this watch.
    fn adds(&self, row: &Row) -> bool {
        match self {
            Self::Thread { .. } => true,
            Self::Work { id, .. } => row.work() == Some(id.as_str()),
            Self::Item { id } => row.id == *id,
        }
    }
}

/// The rows a watch sent, so later changes reach only those and rows added after them.
struct Filter {
    request: Request,
    known: HashSet<String>,
}

impl Filter {
    fn new(request: Request, rows: &[TranscriptRow]) -> Self {
        Self {
            request,
            known: rows.iter().map(|row| row.id.clone()).collect(),
        }
    }

    fn apply(&mut self, updates: &[Update]) -> Vec<TranscriptRowUpdate> {
        let scope = self.request.scope();
        let mut sent = Vec::new();
        for update in updates {
            match update {
                Update::Added(row) if self.request.adds(row) => {
                    if let Some(row) = row.render(scope) {
                        self.known.insert(row.id.clone());
                        sent.push(TranscriptRowUpdate::Row { row });
                    }
                }
                Update::Changed(row) if self.known.contains(&row.id) => {
                    sent.extend(
                        row.render(scope)
                            .map(|row| TranscriptRowUpdate::Row { row }),
                    );
                }
                // Work rows label reasoning without its text.
                Update::Append { id, offset, text }
                    if scope != RowScope::Work && self.known.contains(id) =>
                {
                    sent.push(TranscriptRowUpdate::Append {
                        row_id: id.clone(),
                        offset: *offset,
                        text: text.clone(),
                    });
                }
                _ => {}
            }
        }
        sent
    }
}

/// Prompts and replies from `start`, and work blocks with an item or result there.
fn thread_snapshot(shared: &Shared, start: u32, before: Option<u32>) -> TranscriptSnapshot {
    let shown = |part: u32| part >= start && before.is_none_or(|before| part < before);
    let touched: HashSet<String> = shared
        .rows()
        .filter(|row| row.parts().any(shown))
        .filter_map(|row| row.work().map(str::to_owned))
        .collect();
    let rows = shared
        .rows()
        .filter(|row| match row.body {
            RowBody::Work { .. } => touched.contains(&row.id) || shown(row.part),
            _ => shown(row.part),
        })
        .filter_map(|row| row.render(RowScope::Thread))
        .collect();
    TranscriptSnapshot {
        rows,
        next_before: (start > 0).then_some(start),
        stale: shared.stale,
    }
}

/// A work block's items from one page before `before` onward, cut where a part starts.
fn work_snapshot(shared: &Shared, work: &str, before: Option<u32>) -> TranscriptSnapshot {
    let items: Vec<_> = shared
        .rows()
        .filter(|row| row.work() == Some(work))
        .collect();
    let older = items
        .iter()
        .take_while(|row| before.is_none_or(|before| row.part < before))
        .count();
    let start = older
        .checked_sub(WORK_PAGE_ITEMS)
        .filter(|cut| *cut > 0)
        .map_or(0, |cut| items[cut].part);
    TranscriptSnapshot {
        rows: items
            .iter()
            .filter(|row| row.part >= start)
            .filter_map(|row| row.render(RowScope::Work))
            .collect(),
        next_before: items.iter().any(|row| row.part < start).then_some(start),
        stale: shared.stale,
    }
}

fn item_snapshot(shared: &Shared, id: &str) -> TranscriptSnapshot {
    TranscriptSnapshot {
        rows: shared
            .row(id)
            .and_then(|row| row.render(RowScope::Item))
            .into_iter()
            .collect(),
        next_before: None,
        stale: shared.stale,
    }
}

/// Adds the rows a request needs, then takes its snapshot and subscribes to later changes.
async fn open(
    rows: &ThreadRowsLease,
    request: &Request,
) -> anyhow::Result<(TranscriptSnapshot, Filter, broadcast::Receiver<Arc<Change>>)> {
    match request {
        Request::Thread {
            before: Some(before),
        } => rows.extend_to_boundary(*before).await?,
        Request::Thread { before: None } => {}
        Request::Work { id, .. } | Request::Item { id } => {
            if let Some(source) = row_source(id) {
                rows.extend_to_source(source).await?;
            }
        }
    }
    let (snapshot, receiver) = rows.read(|shared| match request {
        Request::Thread { before } => {
            let start = before
                .filter(|before| *before >= shared.start)
                .unwrap_or(shared.newest);
            thread_snapshot(shared, start, None)
        }
        Request::Work { id, before } => work_snapshot(shared, id, *before),
        Request::Item { id } => item_snapshot(shared, id),
    });
    let filter = Filter::new(request.clone(), &snapshot.rows);
    Ok((snapshot, filter, receiver))
}

struct Watch {
    rows: ThreadRowsLease,
    filter: Filter,
    receiver: broadcast::Receiver<Arc<Change>>,
}

enum Phase {
    Loading {
        load: BoxFuture<'static, anyhow::Result<(TranscriptSnapshot, Watch)>>,
        downloading: tokio::sync::watch::Receiver<bool>,
    },
    Watching(Box<Watch>),
}

fn watch(
    state: &AppState,
    user: &str,
    thread: &str,
    request: Request,
) -> BoxStream<'static, TranscriptRowsEvent> {
    let rows = state.thread_rows.open(state, user, thread);
    let (downloads, downloading) = tokio::sync::watch::channel(false);
    let load = async move {
        let on_download = || {
            downloads.send_if_modified(|downloading| !std::mem::replace(downloading, true));
        };
        rows.ready(&on_download).await?;
        let (snapshot, filter, receiver) = open(&rows, &request).await?;
        let watch = Watch {
            rows,
            filter,
            receiver,
        };
        Ok((snapshot, watch))
    };
    let phase = Phase::Loading {
        load: load.boxed(),
        downloading,
    };
    unfold(phase, |phase| async move {
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
    .boxed()
}

async fn next_event(mut watch: Watch) -> Option<(TranscriptRowsEvent, Watch)> {
    loop {
        let change = match watch.receiver.recv().await {
            Ok(change) => change,
            Err(RecvError::Lagged(_)) => Arc::new(Change::Reset),
            Err(RecvError::Closed) => return None,
        };
        match &*change {
            Change::Rows(updates) => {
                let updates = watch.filter.apply(updates);
                if !updates.is_empty() {
                    return Some((TranscriptRowsEvent::Batch { updates }, watch));
                }
            }
            Change::Reset => {
                let (snapshot, filter, receiver) = open(&watch.rows, &watch.filter.request)
                    .await
                    .inspect_err(|error| {
                        tracing::warn!("could not reload transcript rows: {error:#}");
                    })
                    .ok()?;
                watch.filter = filter;
                watch.receiver = receiver;
                return Some((TranscriptRowsEvent::Snapshot { snapshot }, watch));
            }
        }
    }
}

async fn ready_rows(state: &AppState, user: &str, thread: &str) -> anyhow::Result<ThreadRowsLease> {
    let rows = state.thread_rows.open(state, user, thread);
    rows.ready(&|| {}).await?;
    Ok(rows)
}

/// The newest window, or the page of history before `before`.
pub(crate) async fn page(
    state: &AppState,
    user: &str,
    thread: &str,
    before: Option<u32>,
) -> Result<TranscriptSnapshot, ApiError> {
    let rows = ready_rows(state, user, thread)
        .await
        .map_err(ApiError::internal)?;
    let start = match before {
        Some(before) => Some(rows.page_before(before).await.map_err(ApiError::internal)?),
        None => None,
    };
    Ok(rows
        .read(|shared| thread_snapshot(shared, start.unwrap_or(shared.newest), before))
        .0)
}

/// A row with its full text or tool summary.
pub(crate) async fn row(
    state: &AppState,
    user: &str,
    thread: &str,
    id: String,
) -> Result<Option<TranscriptRow>, ApiError> {
    let rows = ready_rows(state, user, thread)
        .await
        .map_err(ApiError::internal)?;
    let (snapshot, ..) = open(&rows, &Request::Item { id })
        .await
        .map_err(ApiError::internal)?;
    Ok(snapshot.rows.into_iter().next())
}

pub(crate) fn watch_rows(
    state: &AppState,
    scope: Authorized<TranscriptRowsScope>,
) -> BoxStream<'static, TranscriptRowsEvent> {
    let scope = scope.into_inner();
    let request = Request::Thread {
        before: scope.before,
    };
    watch(state, &scope.user_id, &scope.thread_id, request)
}

pub(crate) fn watch_work(
    state: &AppState,
    scope: Authorized<TranscriptRowScope>,
) -> BoxStream<'static, TranscriptRowsEvent> {
    let scope = scope.into_inner();
    let request = Request::Work {
        id: scope.row_id,
        before: scope.before,
    };
    watch(state, &scope.user_id, &scope.thread_id, request)
}

pub(crate) fn watch_item(
    state: &AppState,
    scope: Authorized<TranscriptRowScope>,
) -> BoxStream<'static, TranscriptRowsEvent> {
    let scope = scope.into_inner();
    let request = Request::Item { id: scope.row_id };
    watch(state, &scope.user_id, &scope.thread_id, request)
}

#[cfg(test)]
mod test_support;
#[cfg(test)]
mod tests;
