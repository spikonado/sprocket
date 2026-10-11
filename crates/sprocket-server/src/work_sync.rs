use std::collections::BTreeMap;
use std::sync::Arc;

use convex::Value;
use futures::StreamExt;
use sprocket_agent::{
    RemoteTranscriptState, TRANSCRIPT_CHUNK_SIZE, TranscriptStore, apply_remote_state,
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

fn newest_missing_range(numbers: &[u32]) -> Option<(u32, u32)> {
    let &last = numbers.last()?;
    let mut start = last;
    for &number in numbers.iter().rev().skip(1) {
        if number + 1 != start {
            break;
        }
        start = number;
    }
    Some((start, last + 1))
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

async fn download(
    client: &UserConvexClient,
    store: &TranscriptStore,
    user: &str,
    thread: &str,
    mut states: watch::Receiver<RemoteTranscriptState>,
    changed: &(impl Fn(u32) + Send + Sync),
) -> anyhow::Result<()> {
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
        let numbers = store
            .with_work_replica(user, thread, move |replica| {
                (lower..end)
                    .filter_map(|number| match replica.has_part(number) {
                        Ok(true) => None,
                        Ok(false) => Some(Ok(number)),
                        Err(error) => Some(Err(error)),
                    })
                    .collect::<anyhow::Result<Vec<_>>>()
            })
            .await?;
        if numbers.is_empty() {
            continue;
        }
        let mut parts = store.read_parts(user, thread, &numbers).await?;
        let missing: Vec<_> = numbers
            .iter()
            .copied()
            .filter(|number| !parts.iter().any(|part| part.number == *number))
            .collect();
        if let Some((start, end)) = newest_missing_range(&missing) {
            let fetched = client.transcript_parts_page(thread, start, end).await?;
            let next_end = fetched.last().map(|part| part.number).unwrap_or(end);
            anyhow::ensure!(
                next_end >= start
                    && next_end < end
                    && fetched.len() == (end - next_end) as usize
                    && fetched
                        .iter()
                        .zip((next_end..end).rev())
                        .all(|(part, number)| part.number == number),
                "incomplete transcript download"
            );
            store.append_parts(user, thread, &fetched).await?;
            parts.extend(fetched);
            if next_end > lower {
                pending.push((lower, next_end));
            }
        }
        parts.sort_by_key(|part| part.number);
        let thread_id = thread.to_owned();
        store
            .with_work_replica(user, thread, move |replica| {
                replica.save_parts(&thread_id, &parts)
            })
            .await?;
        changed(total);
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
                download(&client, &store, &user, &thread, state_rx, &changed),
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

    #[test]
    fn missing_ranges_skip_cached_parts() {
        assert_eq!(newest_missing_range(&[1, 2, 5, 7, 8, 9]), Some((7, 10)));
        assert_eq!(newest_missing_range(&[1, 2, 5]), Some((5, 6)));
        assert_eq!(newest_missing_range(&[]), None);
    }

    #[test]
    fn byte_limited_pages_resume_without_skipping_history() {
        let mut pending = vec![(0, 250)];
        assert_eq!(pop_download_page(&mut pending), Some((200, 250)));
        pending.push((200, 230));
        assert_eq!(pop_download_page(&mut pending), Some((200, 230)));
        assert_eq!(pop_download_page(&mut pending), Some((100, 200)));
        pending.push((100, 150));
        pending.push((250, 251));
        assert_eq!(pop_download_page(&mut pending), Some((250, 251)));
        assert_eq!(pop_download_page(&mut pending), Some((100, 150)));
        assert_eq!(pop_download_page(&mut pending), Some((0, 100)));
        assert_eq!(pop_download_page(&mut pending), None);
    }
}
