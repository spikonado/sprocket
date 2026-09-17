use std::collections::BTreeMap;
use std::sync::Arc;

use convex::Value;
use futures::StreamExt;
use sprocket_agent::{
    RemoteTranscriptState, TranscriptPart, TranscriptPartKind, TranscriptStore, apply_remote_state,
};
use sprocket_convex::decode_labeled_function_result;
use tokio::sync::{broadcast, watch};

use crate::transcript_client::UserConvexClient;

const DOWNLOAD_PAGE_SIZE: u32 = 4;

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

fn needs_work_refresh(part: &TranscriptPart) -> bool {
    if !part.work.ranges.is_empty()
        || part.work.section_key.is_some()
        || !part.work.tool_invocations.is_empty()
    {
        return false;
    }
    match part.kind {
        TranscriptPartKind::Tool => true,
        TranscriptPartKind::Completion => part
            .content_items()
            .iter()
            .any(|item| item.get("type").and_then(serde_json::Value::as_str) != Some("text")),
        TranscriptPartKind::Prompt => false,
    }
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
    while let Some(results) = updates.next().await {
        let Some(result) = results.get(subscription.id()).cloned() else {
            continue;
        };
        let state: RemoteTranscriptState =
            decode_labeled_function_result(result, "transcript:getState")?;
        apply_remote_state(store, user, thread, &state, false).await?;
        let total = state.total_parts;
        store
            .with_work_replica(user, thread, move |replica| replica.set_remote_total(total))
            .await?;
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
        parts.retain(|part| !needs_work_refresh(part));
        let missing: Vec<_> = numbers
            .iter()
            .copied()
            .filter(|number| !parts.iter().any(|part| part.number == *number))
            .collect();
        if !missing.is_empty() {
            let fetched = client.transcript_parts(thread, &missing).await?;
            anyhow::ensure!(
                fetched.len() == missing.len()
                    && missing
                        .iter()
                        .all(|number| fetched.iter().any(|part| part.number == *number)),
                "incomplete transcript download"
            );
            store.append_parts(user, thread, &fetched).await?;
            parts.extend(fetched);
        }
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
    use serde_json::json;

    use super::*;

    #[test]
    fn downloads_newest_pages_first_without_shifting_old_pages() {
        for total in 13..=16 {
            let mut pending = vec![(0, total)];
            assert_eq!(pop_download_page(&mut pending), Some((12, total)));
            for range in [(8, 12), (4, 8), (0, 4)] {
                assert_eq!(pop_download_page(&mut pending), Some(range));
            }
            assert_eq!(pop_download_page(&mut pending), None);
        }
    }

    #[test]
    fn refreshes_old_cached_parts_that_need_work_assignments() {
        let old_tool: TranscriptPart = serde_json::from_value(json!({
            "number": 1,
            "sourceKey": "tool:invocation:started",
            "kind": "tool",
            "runId": "run",
            "tool": {
                "toolInvocationId": "invocation",
                "callId": "call",
                "name": "exec_command",
                "status": "started"
            }
        }))
        .unwrap();
        let old_reasoning: TranscriptPart = serde_json::from_value(json!({
            "number": 2,
            "sourceKey": "completion:run:stream",
            "kind": "completion",
            "runId": "run",
            "completion": { "items": [{ "type": "reasoning", "text": "Thinking" }] }
        }))
        .unwrap();
        let text: TranscriptPart = serde_json::from_value(json!({
            "number": 3,
            "sourceKey": "completion:run:answer",
            "kind": "completion",
            "runId": "run",
            "completion": { "items": [{ "type": "text", "text": "Done" }] }
        }))
        .unwrap();
        let assigned: TranscriptPart = serde_json::from_value(json!({
            "number": 4,
            "sourceKey": "completion:run:assigned",
            "kind": "completion",
            "runId": "run",
            "completion": { "items": [{ "type": "reasoning", "text": "Thinking" }] },
            "work": { "ranges": [{ "start": 0, "end": 1, "sectionKey": "section" }] }
        }))
        .unwrap();

        assert!(needs_work_refresh(&old_tool));
        assert!(needs_work_refresh(&old_reasoning));
        assert!(!needs_work_refresh(&text));
        assert!(!needs_work_refresh(&assigned));
    }
}
