use std::borrow::Cow;
use std::collections::hash_map::Entry;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;

use futures::FutureExt;
use futures::future::BoxFuture;
use sprocket_host::transcript_watch::TranscriptWatchSession;
use sprocket_transcript::rows::{
    LiveRows, Row, RowTally, completion_source_key, is_visible_prompt, page_start,
};
use sprocket_transcript::tool_display::SessionCommands;
use sprocket_transcript::{
    LiveCompletionOverlay, LiveCompletionWatchEvent, TRANSCRIPT_CHUNK_SIZE, TranscriptLease,
    TranscriptPart,
};
use tokio::sync::broadcast;
use tokio::sync::broadcast::error::RecvError;
use tokio::task::JoinHandle;
use tokio::time::Instant;

use crate::AppState;

const PAGE_PARTS: u32 = 200;
const UPDATE_INTERVAL: Duration = Duration::from_millis(100);
const LINGER: Duration = Duration::from_secs(10);

/// `fetch(start, end)` downloads the newest parts of `start..end` from Convex, newest first.
pub(super) type Fetch =
    Arc<dyn Fn(u32, u32) -> BoxFuture<'static, anyhow::Result<Vec<TranscriptPart>>> + Send + Sync>;

/// One [`ThreadRows`] per thread in use, shared by every tab, watch and request.
#[derive(Default)]
pub(crate) struct ThreadRowsRegistry {
    threads: Mutex<HashMap<(String, String), Weak<ThreadRows>>>,
}

impl ThreadRowsRegistry {
    pub(super) fn open(&self, state: &AppState, user: &str, thread: &str) -> ThreadRowsLease {
        let mut threads = lock(&self.threads);
        threads.retain(|_, rows| rows.strong_count() > 0);
        let key = (user.to_owned(), thread.to_owned());
        if let Some(rows) = threads.get(&key).and_then(Weak::upgrade) {
            return ThreadRowsLease::new(rows);
        }
        let fetch = convex_fetch(state, user, thread);
        let rows = Arc::new(ThreadRows::new(state.clone(), user, thread, fetch));
        threads.insert(key, Arc::downgrade(&rows));
        ThreadRowsLease::new(rows)
    }
}

fn convex_fetch(state: &AppState, user: &str, thread: &str) -> Fetch {
    let (state, user, thread) = (state.clone(), user.to_owned(), thread.to_owned());
    Arc::new(move |start, end| {
        let (state, user, thread) = (state.clone(), user.clone(), thread.clone());
        async move {
            state
                .host
                .convex_client_for(&user)
                .await?
                .transcript_parts_page(&thread, start, end)
                .await
        }
        .boxed()
    })
}

/// Keeps a thread's rows for a short while after it is dropped, so loading an older page or
/// restarting a watch reuses them.
pub(super) struct ThreadRowsLease(Option<Arc<ThreadRows>>);

impl ThreadRowsLease {
    pub(super) fn new(rows: Arc<ThreadRows>) -> Self {
        Self(Some(rows))
    }
}

impl std::ops::Deref for ThreadRowsLease {
    type Target = Arc<ThreadRows>;

    fn deref(&self) -> &Arc<ThreadRows> {
        self.0
            .as_ref()
            .expect("a lease holds its rows until dropped")
    }
}

impl Drop for ThreadRowsLease {
    fn drop(&mut self) {
        if let Some(rows) = self.0.take()
            && let Ok(runtime) = tokio::runtime::Handle::try_current()
        {
            runtime.spawn(async move {
                tokio::time::sleep(LINGER).await;
                drop(rows);
            });
        }
    }
}

/// A thread's rows from the start of a run through the newest saved part, plus the live view.
pub(super) struct ThreadRows {
    state: AppState,
    user: String,
    thread: String,
    fetch: Fetch,
    /// Held while folding parts, so saved rows change in one place at a time.
    folder: tokio::sync::Mutex<Folder>,
    shared: Mutex<Shared>,
    events: broadcast::Sender<Arc<Change>>,
}

struct Folder {
    tally: RowTally,
    commands: SessionCommands,
    end: u32,
    watching: Option<Watching>,
}

struct Watching {
    _lease: TranscriptLease,
    task: JoinHandle<()>,
}

impl Drop for Watching {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[derive(Default)]
pub(super) struct Shared {
    /// Rows cover parts from `start`, which always begins a run, through the newest saved part.
    pub(super) start: u32,
    pub(super) newest: u32,
    rows: Vec<Row>,
    index: HashMap<String, usize>,
    view: View,
    pub(super) stale: bool,
}

/// What the live completions change: rows replaced or added after the saved ones, and the rows
/// still streaming.
#[derive(Default)]
struct View {
    rows: HashMap<String, Row>,
    added: Vec<String>,
    streaming: HashSet<String>,
}

#[derive(Debug)]
pub(super) enum Change {
    /// Rows moved or disappeared, so watchers take a new snapshot.
    Reset,
    Rows(Vec<Update>),
}

#[derive(Debug)]
pub(super) enum Update {
    /// A row after every row sent before it.
    Added(Row),
    Changed(Row),
    Append {
        id: String,
        offset: usize,
        text: String,
    },
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}

fn fold<'a>(
    tally: &mut RowTally,
    commands: &mut SessionCommands,
    parts: impl IntoIterator<Item = &'a TranscriptPart>,
) -> Vec<Row> {
    parts
        .into_iter()
        .flat_map(|part| tally.apply(part, commands))
        .collect()
}

/// The latest version of each changed row, in the order the rows first appeared.
fn latest(changes: Vec<Row>) -> Vec<Row> {
    let (mut rows, mut index) = (Vec::new(), HashMap::new());
    for row in changes {
        upsert(&mut rows, &mut index, row);
    }
    rows
}

impl ThreadRows {
    pub(super) fn new(state: AppState, user: &str, thread: &str, fetch: Fetch) -> Self {
        let commands = SessionCommands::new(state.host.transcript.thread_dir(user, thread));
        Self {
            state,
            user: user.to_owned(),
            thread: thread.to_owned(),
            fetch,
            folder: tokio::sync::Mutex::new(Folder {
                tally: RowTally::default(),
                commands,
                end: 0,
                watching: None,
            }),
            shared: Mutex::new(Shared::default()),
            events: broadcast::channel(256).0,
        }
    }

    fn shared(&self) -> MutexGuard<'_, Shared> {
        lock(&self.shared)
    }

    /// Reads the rows and subscribes to their changes at once, so no change is missed.
    pub(super) fn read<T>(
        &self,
        read: impl FnOnce(&Shared) -> T,
    ) -> (T, broadcast::Receiver<Arc<Change>>) {
        let shared = self.shared();
        (read(&shared), self.events.subscribe())
    }

    /// Downloads the missing parts of `start..end` and reads them.
    async fn ensure(
        &self,
        start: u32,
        end: u32,
        on_download: &(dyn Fn() + Sync),
    ) -> anyhow::Result<Vec<TranscriptPart>> {
        let store = &self.state.host.transcript;
        store
            .ensure_parts(&self.user, &self.thread, start, end, |from, to| {
                on_download();
                (self.fetch)(from, to)
            })
            .await?;
        let parts = store
            .read_parts_range(&self.user, &self.thread, start, end)
            .await?;
        anyhow::ensure!(
            parts.len() == end.saturating_sub(start) as usize,
            "transcript parts {start}..{end} are incomplete"
        );
        Ok(parts)
    }

    /// Folds the newest page, from the start of its first run.
    async fn build(
        &self,
        folder: &mut Folder,
        on_download: &(dyn Fn() + Sync),
    ) -> anyhow::Result<()> {
        let end = self
            .state
            .host
            .transcript
            .part_numbers(&self.user, &self.thread)
            .await?
            .last()
            .map_or(0, |number| number + 1);
        let page_from = end.saturating_sub(PAGE_PARTS);
        let page = self.ensure(page_from, end, on_download).await?;
        let newest = page_start(&page, page_from);
        let page = &page[(newest - page_from) as usize..];
        let prefix = match page.first() {
            Some(first) => self.run_prefix(first, on_download).await?,
            None => Vec::new(),
        };
        folder.tally = RowTally::default();
        let rows = latest(fold(
            &mut folder.tally,
            &mut folder.commands,
            prefix.iter().chain(page),
        ));
        folder.end = end;
        let start = prefix.first().map_or(newest, |part| part.number);
        self.shared().replace(start, newest, rows);
        Ok(())
    }

    /// The parts of `first`'s run before it, from its visible prompt or its first part.
    async fn run_prefix(
        &self,
        first: &TranscriptPart,
        on_download: &(dyn Fn() + Sync),
    ) -> anyhow::Result<Vec<TranscriptPart>> {
        let mut prefix = Vec::new();
        let mut end = first.number;
        'pages: while end > 0 && !is_visible_prompt(first) {
            let start = end
                .saturating_sub(PAGE_PARTS)
                .next_multiple_of(TRANSCRIPT_CHUNK_SIZE);
            for part in self
                .ensure(start, end, on_download)
                .await?
                .into_iter()
                .rev()
            {
                if part.run_id != first.run_id {
                    break 'pages;
                }
                let origin = is_visible_prompt(&part);
                prefix.push(part);
                if origin {
                    break 'pages;
                }
            }
            end = start;
        }
        prefix.reverse();
        Ok(prefix)
    }

    /// Adds the rows of parts from `number`'s run onward, for older pages and lookups.
    async fn extend_to(&self, number: u32) -> anyhow::Result<()> {
        let mut folder = self.folder.lock().await;
        let start = self.shared().start;
        if number >= start {
            return Ok(());
        }
        let parts = self.ensure(number, start, &|| {}).await?;
        let prefix = self.run_prefix(&parts[0], &|| {}).await?;
        let mut tally = RowTally::default();
        let mut changes = fold(
            &mut tally,
            &mut folder.commands,
            prefix.iter().chain(&parts),
        );
        changes.extend(tally.settle(&mut folder.commands));
        let start = prefix.first().map_or(number, |part| part.number);
        self.shared().prepend(start, latest(changes));
        Ok(())
    }

    /// Where the page of history before `before` starts, with its rows added.
    pub(super) async fn page_before(&self, before: u32) -> anyhow::Result<u32> {
        let page_from = before.saturating_sub(PAGE_PARTS);
        let page = self.ensure(page_from, before, &|| {}).await?;
        let start = page_start(&page, page_from);
        self.extend_to(start).await?;
        Ok(start)
    }

    /// Adds the rows of the part that `source` names, when it is saved.
    pub(super) async fn extend_to_source(&self, source: &str) -> anyhow::Result<()> {
        let number = self
            .state
            .host
            .transcript
            .source_number(&self.user, &self.thread, source)
            .await?;
        match number {
            Some(number) => self.extend_to(number).await,
            None => Ok(()),
        }
    }

    /// Adds the rows from `boundary` when at most a page of them is missing locally.
    pub(super) async fn extend_to_boundary(&self, boundary: u32) -> anyhow::Result<()> {
        let start = self.shared().start;
        if boundary >= start {
            return Ok(());
        }
        let numbers = self
            .state
            .host
            .transcript
            .part_numbers(&self.user, &self.thread)
            .await?;
        // A boundary past a wide gap moves the window instead of downloading the gap.
        if uncached(&numbers, boundary..start) > PAGE_PARTS as usize {
            return Ok(());
        }
        self.extend_to(boundary).await
    }

    /// Folds parts saved since the last call, then rebuilds the live view on top. Every read
    /// happens before the first change, so a failed refresh leaves the rows as they were.
    async fn refresh(
        &self,
        folder: &mut Folder,
        live: &mut LiveWindow,
        read_saved: bool,
        stale: bool,
    ) -> anyhow::Result<()> {
        let store = &self.state.host.transcript;
        let numbers = if read_saved {
            store.part_numbers(&self.user, &self.thread).await?
        } else {
            Vec::new()
        };
        let end = numbers.last().map_or(folder.end, |number| number + 1);
        let mut saved_sources = HashSet::new();
        for overlay in &live.overlays {
            let source = completion_source_key(overlay);
            if store
                .source_number(&self.user, &self.thread, &source)
                .await?
                .is_some_and(|number| number < end)
            {
                saved_sources.insert(source);
            }
        }
        let rebuilt = end > folder.end && uncached(&numbers, folder.end..end) > PAGE_PARTS as usize;
        let mut saved = Vec::new();
        if rebuilt {
            self.build(folder, &|| {}).await?;
        } else if end > folder.end {
            let parts = self.ensure(folder.end, end, &|| {}).await?;
            saved = fold(&mut folder.tally, &mut folder.commands, &parts);
            folder.end = end;
        }
        live.remove_saved(|source| saved_sources.contains(source));
        let view = folder.tally.live_rows(
            &live.overlays,
            |source| saved_sources.contains(source),
            &mut folder.commands,
        );
        let mut shared = self.shared();
        let change = shared.update(saved, view, stale);
        if let Some(change) = rebuilt.then_some(Change::Reset).or(change) {
            let _ = self.events.send(Arc::new(change));
        }
        Ok(())
    }

    fn fail(&self) {
        let mut shared = self.shared();
        shared.stale = true;
        let _ = self.events.send(Arc::new(Change::Reset));
    }

    /// Builds the rows on first use and follows the thread's saved parts and live completion.
    pub(super) async fn ready(
        self: &Arc<Self>,
        on_download: &(dyn Fn() + Sync),
    ) -> anyhow::Result<()> {
        let mut folder = self.folder.lock().await;
        if folder.watching.is_some() {
            return Ok(());
        }
        let lease = self
            .state
            .host
            .transcript
            .open_thread(&self.user, &self.thread)
            .await?;
        let mut session = self
            .state
            .host
            .transcript_watchers
            .open(&self.user, &self.thread)
            .await;
        let subscription = self.state.host.live_completions.subscribe(&self.thread);
        if let Err(error) = self.download_newest_page(&mut session, on_download).await {
            tracing::warn!(thread = %self.thread, "could not download the newest transcript page: {error:#}");
        }
        self.build(&mut folder, on_download).await?;
        let mut live = LiveWindow {
            overlays: subscription.snapshot.into_iter().collect(),
            ..LiveWindow::default()
        };
        self.refresh(&mut folder, &mut live, false, session.stale())
            .await?;
        let task = tokio::spawn(follow(
            Arc::downgrade(self),
            session,
            subscription.receiver,
            live,
        ));
        folder.watching = Some(Watching {
            _lease: lease,
            task,
        });
        Ok(())
    }

    /// An empty cache has no highwater to page back from, so its newest page starts at Convex's
    /// total.
    async fn download_newest_page(
        &self,
        session: &mut TranscriptWatchSession,
        on_download: &(dyn Fn() + Sync),
    ) -> anyhow::Result<()> {
        let store = &self.state.host.transcript;
        let (user, thread) = (self.user.as_str(), self.thread.as_str());
        if !store.part_numbers(user, thread).await?.is_empty() {
            return Ok(());
        }
        let total = async {
            let client = self.state.host.convex_client_for(user).await?;
            client.transcript_total_parts(thread).await
        };
        tokio::pin!(total);
        // A local run or the background watcher can save parts first, which makes the lookup moot.
        let total = loop {
            tokio::select! {
                total = &mut total => break total?,
                event = session.receiver().recv() => {
                    if matches!(event, Err(RecvError::Closed))
                        || !store.part_numbers(user, thread).await?.is_empty()
                    {
                        return Ok(());
                    }
                }
            }
        };
        if total == 0 || !store.part_numbers(user, thread).await?.is_empty() {
            return Ok(());
        }
        self.ensure(total.saturating_sub(PAGE_PARTS), total, on_download)
            .await
            .map(drop)
    }
}

async fn follow(
    rows: Weak<ThreadRows>,
    mut session: TranscriptWatchSession,
    mut live_events: broadcast::Receiver<LiveCompletionWatchEvent>,
    mut live: LiveWindow,
) {
    let mut next_send = Instant::now();
    let (mut dirty, mut read_saved) = (false, false);
    loop {
        tokio::select! {
            event = session.receiver().recv() => {
                if matches!(event, Err(RecvError::Closed)) {
                    return;
                }
                (dirty, read_saved) = (true, true);
            }
            event = live_events.recv() => {
                let event = match event {
                    Ok(event) => event,
                    Err(RecvError::Lagged(_)) => {
                        let Some(rows) = rows.upgrade() else { return };
                        let subscription = rows.state.host.live_completions.subscribe(&rows.thread);
                        live_events = subscription.receiver;
                        read_saved = true;
                        subscription.snapshot.map_or(LiveCompletionWatchEvent::Cleared, |live| {
                            LiveCompletionWatchEvent::Updated { live }
                        })
                    }
                    Err(RecvError::Closed) => return,
                };
                // A new stream usually follows a saved completion.
                read_saved |= matches!(&event, LiveCompletionWatchEvent::Updated { live: next }
                    if live.overlays.last().is_none_or(|last| last.stream_id != next.stream_id));
                live.update(event);
                dirty = true;
            }
            () = tokio::time::sleep_until(next_send), if dirty => {
                let Some(rows) = rows.upgrade() else { return };
                let mut folder = rows.folder.lock().await;
                if let Err(error) = rows.refresh(&mut folder, &mut live, read_saved, session.stale()).await {
                    tracing::warn!(thread = %rows.thread, "could not update transcript rows: {error:#}");
                    rows.fail();
                }
                (dirty, read_saved) = (false, false);
                next_send = Instant::now() + UPDATE_INTERVAL;
            }
        }
    }
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
                // A retry replaces the attempt that was cleared.
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

    /// Drops finished overlays once their completion is saved.
    fn remove_saved(&mut self, is_saved: impl Fn(&str) -> bool) {
        self.overlays
            .retain(|live| !live.run_status.is_final() || !is_saved(&completion_source_key(live)));
    }
}

fn uncached(numbers: &[u32], range: std::ops::Range<u32>) -> usize {
    let cached = numbers
        .partition_point(|number| *number < range.end)
        .saturating_sub(numbers.partition_point(|number| *number < range.start));
    range.len() - cached
}

fn upsert(rows: &mut Vec<Row>, index: &mut HashMap<String, usize>, row: Row) -> Option<Row> {
    match index.get(&row.id) {
        Some(&position) => Some(std::mem::replace(&mut rows[position], row)),
        None => {
            index.insert(row.id.clone(), rows.len());
            rows.push(row);
            None
        }
    }
}

impl Shared {
    fn committed(&self, id: &str) -> Option<&Row> {
        self.index.get(id).map(|&position| &self.rows[position])
    }

    pub(super) fn row(&self, id: &str) -> Option<Cow<'_, Row>> {
        self.view
            .rows
            .get(id)
            .or_else(|| self.committed(id))
            .map(|row| self.streamed(row))
    }

    pub(super) fn rows(&self) -> impl Iterator<Item = Cow<'_, Row>> {
        self.rows
            .iter()
            .map(move |row| self.view.rows.get(&row.id).unwrap_or(row))
            .chain(
                self.view
                    .added
                    .iter()
                    .filter_map(move |id| self.view.rows.get(id)),
            )
            .map(move |row| self.streamed(row))
    }

    fn streamed<'a>(&self, row: &'a Row) -> Cow<'a, Row> {
        if self.view.streaming.contains(&row.id) {
            let mut row = row.clone();
            row.set_streaming();
            Cow::Owned(row)
        } else {
            Cow::Borrowed(row)
        }
    }

    fn replace(&mut self, start: u32, newest: u32, rows: Vec<Row>) {
        self.start = start;
        self.newest = newest;
        self.index = rows
            .iter()
            .enumerate()
            .map(|(position, row)| (row.id.clone(), position))
            .collect();
        self.rows = rows;
        self.view = View::default();
    }

    fn prepend(&mut self, start: u32, mut rows: Vec<Row>) {
        rows.append(&mut self.rows);
        let (newest, view) = (self.newest, std::mem::take(&mut self.view));
        self.replace(start, newest, rows);
        self.view = view;
    }

    /// Applies saved row changes and a new live view, and returns what watchers must change.
    fn update(&mut self, saved: Vec<Row>, live: LiveRows, stale: bool) -> Option<Change> {
        let mut previous: HashMap<String, Option<Row>> = HashMap::new();
        let mut order = Vec::new();
        for row in saved {
            let id = row.id.clone();
            let replaced = upsert(&mut self.rows, &mut self.index, row);
            if let Entry::Vacant(entry) = previous.entry(id) {
                if replaced.is_none() {
                    order.push(entry.key().clone());
                }
                entry.insert(replaced);
            }
        }
        let mut view = View {
            streaming: live.streaming,
            ..View::default()
        };
        for row in live.rows {
            if !self.index.contains_key(&row.id) && !view.rows.contains_key(&row.id) {
                view.added.push(row.id.clone());
            }
            view.rows.insert(row.id.clone(), row);
        }
        order.extend(view.added.iter().cloned());
        let old = std::mem::replace(&mut self.view, view);
        if !order.starts_with(&old.added) || self.stale != stale {
            self.stale = stale;
            return Some(Change::Reset);
        }
        let added = &order[old.added.len()..];
        let shown_before = |id: &String| -> Option<Row> {
            let mut row = match old.rows.get(id) {
                Some(row) => row.clone(),
                None => match previous.get(id) {
                    Some(row) => row.clone()?,
                    None => self.committed(id)?.clone(),
                },
            };
            if old.streaming.contains(id) {
                row.set_streaming();
            }
            Some(row)
        };
        let mut seen: HashSet<&String> = added.iter().collect();
        let mut updates = Vec::new();
        let changed = previous
            .keys()
            .chain(old.rows.keys())
            .chain(self.view.rows.keys())
            .chain(&old.streaming)
            .chain(&self.view.streaming);
        for id in changed {
            if !seen.insert(id) {
                continue;
            }
            let (Some(before), Some(after)) = (shown_before(id), self.row(id)) else {
                continue;
            };
            if before == *after {
                continue;
            }
            if let (Some(text), Some(next)) = (before.text(), after.text())
                && let Some(suffix) = next.strip_prefix(text)
                && before.differs_only_in_text(&after)
            {
                updates.push(Update::Append {
                    id: id.clone(),
                    offset: text.encode_utf16().count(),
                    text: suffix.to_owned(),
                });
            } else {
                updates.push(Update::Changed(after.into_owned()));
            }
        }
        updates.extend(
            added
                .iter()
                .filter_map(|id| self.row(id).map(|row| Update::Added(row.into_owned()))),
        );
        (!updates.is_empty()).then_some(Change::Rows(updates))
    }
}

#[cfg(test)]
mod tests;
