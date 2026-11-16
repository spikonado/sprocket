use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt;
use sprocket_convex::decode_labeled_function_result;
use sprocket_transcript::{RemoteTranscriptState, TranscriptPart, TranscriptStore};
use tokio::sync::{OnceCell, watch};

use crate::transcript_client::{UserConvexClient, thread_id_args};
use crate::transcript_watch::TranscriptSyncStatus;

const STARTUP_STATE_TIMEOUT: Duration = Duration::from_secs(10);

pub(crate) struct RunStart {
    pub total: OnceCell<Option<u32>>,
    paused: watch::Sender<bool>,
}

impl Default for RunStart {
    fn default() -> Self {
        Self {
            total: OnceCell::new(),
            paused: watch::channel(false).0,
        }
    }
}

impl RunStart {
    pub async fn wait_until_paused(&self) -> anyhow::Result<()> {
        self.paused.subscribe().wait_for(|paused| *paused).await?;
        Ok(())
    }

    pub async fn initialize<F, Fut>(&self, thread: &str, query: F) -> Option<u32>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = anyhow::Result<u32>>,
    {
        *self
            .total
            .get_or_init(|| async {
                match tokio::time::timeout(STARTUP_STATE_TIMEOUT, query()).await {
                    Ok(Ok(total)) => Some(total),
                    Ok(Err(error)) => {
                        tracing::warn!(
                            "could not read transcript state for the run in {thread}: {error:#}"
                        );
                        None
                    }
                    Err(_) => {
                        tracing::warn!(
                            "timed out reading transcript state for the run in {thread}"
                        );
                        None
                    }
                }
            })
            .await
    }
}

#[derive(Clone)]
pub(crate) enum SyncMode {
    /// Follow `totalParts`, for threads open only in tabs.
    Remote,
    /// A run on this machine saves the parts it creates, so only older parts download.
    Local(Arc<RunStart>),
}

fn raise(totals: &watch::Sender<u32>, total: u32) {
    totals.send_if_modified(|current| {
        let raised = total > *current;
        *current = (*current).max(total);
        raised
    });
}

async fn subscribe_total(
    client: &UserConvexClient,
    thread: &str,
    totals: &watch::Sender<u32>,
    status: &watch::Sender<TranscriptSyncStatus>,
) -> anyhow::Result<()> {
    let mut subscription = client
        .subscribe("transcript:getState", thread_id_args(thread))
        .await?;
    while let Some(result) = subscription.next().await {
        let state: RemoteTranscriptState =
            decode_labeled_function_result(result, "transcript:getState")?;
        raise(totals, state.total_parts);
        status.send_replace(TranscriptSyncStatus::Ready);
    }
    anyhow::bail!("transcript state subscription ended")
}

async fn follow_total(
    client: &UserConvexClient,
    thread: &str,
    mode: &SyncMode,
    totals: watch::Sender<u32>,
    status: &watch::Sender<TranscriptSyncStatus>,
) -> anyhow::Result<()> {
    match mode {
        SyncMode::Remote => subscribe_total(client, thread, &totals, status).await,
        SyncMode::Local(start) => {
            match start
                .initialize(thread, || client.transcript_total_parts(thread))
                .await
            {
                Some(total) => {
                    raise(&totals, total);
                    status.send_replace(TranscriptSyncStatus::Ready);
                }
                None => {
                    status.send_replace(TranscriptSyncStatus::Unavailable);
                }
            }
            std::future::pending().await
        }
    }
}

pub(crate) async fn follow_modes<F, Fut>(
    mut modes: watch::Receiver<SyncMode>,
    mut synchronize: F,
) -> anyhow::Result<()>
where
    F: FnMut(SyncMode) -> Fut,
    Fut: std::future::Future<Output = anyhow::Result<()>>,
{
    loop {
        let mode = modes.borrow_and_update().clone();
        if let SyncMode::Local(start) = &mode {
            start.paused.send_replace(true);
        }
        tokio::select! {
            biased;
            result = modes.changed() => result?,
            result = synchronize(mode) => result?,
        }
    }
}

async fn download<F, Fut>(
    store: &TranscriptStore,
    user: &str,
    thread: &str,
    mut totals: watch::Receiver<u32>,
    mut fetch: F,
) -> anyhow::Result<()>
where
    F: FnMut(u32, u32) -> Fut,
    Fut: std::future::Future<Output = anyhow::Result<Vec<TranscriptPart>>>,
{
    loop {
        let total = *totals.borrow_and_update();
        if store
            .download_missing_page(user, thread, 0, total, &mut fetch)
            .await?
        {
            tokio::task::yield_now().await;
        } else {
            totals.changed().await?;
        }
    }
}

pub(crate) async fn synchronize(
    client: &UserConvexClient,
    store: &TranscriptStore,
    user: &str,
    thread: &str,
    mode: &SyncMode,
    status: &watch::Sender<TranscriptSyncStatus>,
) -> anyhow::Result<()> {
    let (totals, total_rx) = watch::channel(0);
    tokio::try_join!(
        follow_total(client, thread, mode, totals, status),
        download(store, user, thread, total_rx, |start, end| {
            client.transcript_parts_page(thread, start, end)
        }),
    )
    .map(|_| ())
}

pub(crate) async fn reconcile(
    client: &UserConvexClient,
    store: &TranscriptStore,
    user: &str,
    thread: &str,
    from: u32,
) -> anyhow::Result<()> {
    let total = client.transcript_total_parts(thread).await?;
    store
        .ensure_parts(user, thread, from, total, |start, end| {
            client.transcript_parts_page(thread, start, end)
        })
        .await
}

#[cfg(test)]
mod tests;
