use std::collections::BTreeMap;
use std::sync::Arc;

use convex::Value;
use futures::StreamExt;
use sprocket_agent::{
    DownloadOrder, RemoteTranscriptState, TRANSCRIPT_CHUNK_SIZE, TranscriptStore,
    apply_remote_state,
};
use sprocket_convex::decode_labeled_function_result;
use tokio::sync::{broadcast, watch};

use crate::transcript_client::UserConvexClient;

const DOWNLOAD_PAGE_SIZE: u32 = TRANSCRIPT_CHUNK_SIZE;

fn thread_args(thread: &str) -> BTreeMap<String, Value> {
    BTreeMap::from([("threadId".into(), thread.to_owned().into())])
}

fn pop_download_page(pending: &mut Vec<(u32, u32)>) -> Option<(u32, u32)> {
    let (start, end) = pending.pop()?;
    let lower = ((end - 1) / DOWNLOAD_PAGE_SIZE * DOWNLOAD_PAGE_SIZE).max(start);
    if lower > start {
        pending.push((start, lower));
    }
    Some((lower, end))
}

async fn metadata(
    client: &UserConvexClient,
    store: &TranscriptStore,
    user: &str,
    thread: &str,
    states: watch::Sender<RemoteTranscriptState>,
    changed: &(impl Fn(u32) + Send + Sync),
) -> anyhow::Result<()> {
    let mut updates = client.watch_all().await?;
    let subscription = client
        .subscribe("transcript:getState", thread_args(thread))
        .await?;
    let mut previous = None;
    while let Some(results) = updates.next().await {
        let Some(result) = results.get(subscription.id()).cloned() else {
            continue;
        };
        let state: RemoteTranscriptState =
            decode_labeled_function_result(result, "transcript:getState")?;
        if previous.as_ref() == Some(&state) {
            continue;
        }
        apply_remote_state(store, user, thread, &state, false).await?;
        let total = state.total_parts;
        store
            .with_work_replica(user, thread, move |replica| replica.set_remote_total(total))
            .await?;
        previous = Some(state.clone());
        states.send_replace(state);
        changed(total);
    }
    anyhow::bail!("transcript state subscription ended")
}

async fn download<F, Fut>(
    store: &TranscriptStore,
    user: &str,
    thread: &str,
    mut states: watch::Receiver<RemoteTranscriptState>,
    changed: &(impl Fn(u32) + Send + Sync),
    mut fetch: F,
) -> anyhow::Result<()>
where
    F: FnMut(u32, u32, DownloadOrder) -> Fut,
    Fut: std::future::Future<Output = anyhow::Result<Vec<sprocket_agent::TranscriptPart>>>,
{
    let mut seen_total = 0;
    let mut pending = Vec::new();
    loop {
        let total = states.borrow_and_update().total_parts;
        if total > seen_total {
            pending.push((seen_total, total));
            seen_total = total;
        }
        let Some((lower, end)) = pop_download_page(&mut pending) else {
            states.changed().await?;
            continue;
        };
        let remaining = store
            .download_parts_page(user, thread, lower, end, DownloadOrder::Desc, &mut fetch)
            .await?;
        if remaining.0 < remaining.1 {
            pending.push(remaining);
        }
        changed(total);
        tokio::task::yield_now().await;
    }
}

async fn wait_for_reset(
    mut resets: broadcast::Receiver<(String, String)>,
    user: &str,
    thread: &str,
) -> anyhow::Result<()> {
    loop {
        match resets.recv().await {
            Ok((reset_user, reset_thread)) if reset_user != user || reset_thread != thread => {}
            _ => anyhow::bail!("transcript replica reset; restarting synchronization"),
        }
    }
}

pub(crate) async fn synchronize(
    client: UserConvexClient,
    store: Arc<TranscriptStore>,
    user: String,
    thread: String,
    changed: impl Fn(u32) + Send + Sync,
) -> anyhow::Result<()> {
    let resets = store.watch_work_replica_resets();
    store.prepare_work_replica(&user, &thread).await?;
    let (states, state_rx) = watch::channel(RemoteTranscriptState {
        thread_id: thread.clone(),
        total_parts: 0,
        history_from_number: 0,
        context_summary: None,
        reasoning_stripped_through_part_number: None,
    });
    tokio::select! {
        result = async {
            tokio::try_join!(
                metadata(&client, &store, &user, &thread, states, &changed),
                download(&store, &user, &thread, state_rx, &changed, |start, end, order| {
                    client.transcript_parts_page(&thread, start, end, order)
                }),
            )
        } => { result?; }
        result = wait_for_reset(resets, &user, &thread) => { return result; }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downloads_newest_pages_first_without_shifting_old_pages() {
        for total in 301..=304 {
            let mut pending = vec![(0, total)];
            assert_eq!(pop_download_page(&mut pending), Some((300, total)));
            for range in [(200, 300), (100, 200), (0, 100)] {
                assert_eq!(pop_download_page(&mut pending), Some(range));
            }
            assert_eq!(pop_download_page(&mut pending), None);
        }
    }

    #[tokio::test]
    async fn downloads_partial_pages_around_cached_gaps_and_prioritizes_live_parts() {
        use sprocket_agent::TranscriptPart;
        use std::sync::Mutex;

        fn prompt(number: u32) -> TranscriptPart {
            serde_json::from_value(serde_json::json!({
                "number": number, "sourceKey": format!("prompt:{number}"),
                "runId": "run", "kind": "prompt",
                "prompt": {"text": format!("Part {number}"), "imageUploads": []}
            }))
            .unwrap()
        }

        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(TranscriptStore::new(dir.path().to_owned()));
        store
            .append_parts("user", "thread", &[prompt(115), prompt(210)])
            .await
            .unwrap();
        store
            .with_work_replica("user", "thread", |replica| {
                replica.save_parts("thread", &[prompt(210)])
            })
            .await
            .unwrap();
        let state = RemoteTranscriptState {
            thread_id: "thread".into(),
            total_parts: 250,
            history_from_number: 0,
            context_summary: None,
            reasoning_stripped_through_part_number: None,
        };
        let (states, state_rx) = watch::channel(state);
        let requests = Arc::new(Mutex::new(Vec::new()));
        let fetched_numbers = Arc::new(Mutex::new(Vec::new()));
        let (changed_tx, mut changes) = tokio::sync::mpsc::unbounded_channel();
        let changed = move |total| {
            changed_tx.send(total).unwrap();
        };
        let fetch = |start: u32, end: u32, _order| {
            let mut requests = requests.lock().unwrap();
            if requests.is_empty() {
                states.send_modify(|state| state.total_parts = 251);
            }
            requests.push((start, end));
            let numbers: Vec<_> = (start.max(end.saturating_sub(20))..end).rev().collect();
            fetched_numbers
                .lock()
                .unwrap()
                .extend(numbers.iter().copied());
            std::future::ready(Ok(numbers.into_iter().map(prompt).collect()))
        };
        let downloading = download(&store, "user", "thread", state_rx, &changed, fetch);
        tokio::pin!(downloading);
        tokio::time::timeout(std::time::Duration::from_secs(30), async {
            loop {
                tokio::select! {
                    result = &mut downloading => panic!("download stopped: {result:?}"),
                    change = changes.recv() => { change.unwrap(); }
                }
                let complete = store
                    .with_work_replica("user", "thread", |replica| {
                        for number in 0..251 {
                            if !replica.has_part(number)? {
                                return Ok(false);
                            }
                        }
                        Ok(true)
                    })
                    .await
                    .unwrap();
                if complete {
                    break;
                }
            }
        })
        .await
        .unwrap();
        {
            let requests = requests.lock().unwrap();
            assert_eq!(requests[0], (211, 250));
            assert_eq!(requests[1], (250, 251));
            assert_eq!(requests[2], (211, 230));
        }
        let mut fetched = fetched_numbers.lock().unwrap().clone();
        fetched.sort_unstable();
        assert_eq!(
            fetched,
            (0..251)
                .filter(|number| ![115, 210].contains(number))
                .collect::<Vec<_>>()
        );
        assert_eq!(
            store
                .read_parts("user", "thread", &(0..251).collect::<Vec<_>>())
                .await
                .unwrap(),
            (0..251).map(prompt).collect::<Vec<_>>()
        );
    }
}
