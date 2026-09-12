use std::collections::BTreeMap;
use std::sync::Arc;

use convex::{FunctionResult, QuerySubscription, Value};
use futures::StreamExt;
use serde::Deserialize;
use sprocket_agent::{
    RemoteTranscriptState, SectionPartition, TranscriptStore, WorkSnapshot, apply_remote_state,
    sections::{WorkMembership, WorkPosition, WorkSection},
};
use sprocket_convex::decode_labeled_function_result;
use tokio::sync::{Notify, broadcast, watch};

use crate::transcript_client::UserConvexClient;

mod metadata;

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkState {
    #[serde(deserialize_with = "sprocket_convex::deserialize_convex_u32")]
    total_parts: u32,
    through: WorkPosition,
    #[serde(deserialize_with = "sprocket_convex::deserialize_convex_u32")]
    history_from_number: u32,
    context_summary: Option<String>,
    active_run_id: Option<String>,
}

#[derive(Deserialize)]
struct SectionPage {
    rows: Vec<WorkSection>,
    split: Option<String>,
}

#[derive(Deserialize)]
struct MembershipPart {
    #[serde(deserialize_with = "sprocket_convex::deserialize_convex_u32")]
    number: u32,
    work: Option<MembershipBody>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MembershipBody {
    #[serde(deserialize_with = "sprocket_convex::deserialize_convex_u32")]
    processed: u32,
    ranges: Vec<sprocket_agent::sections::WorkRange>,
    section_key: Option<String>,
}

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
enum Feed {
    State,
    Sections {
        after: String,
        before: Option<String>,
    },
    Memberships(u32),
}

impl Feed {
    fn request(&self, thread: &str) -> (&'static str, BTreeMap<String, Value>) {
        let mut args = thread_args(thread);
        let function = match self {
            Self::State => "transcriptSections:state",
            Self::Sections { after, before } => {
                args.insert("after".into(), after.clone().into());
                if let Some(before) = before {
                    args.insert("before".into(), before.clone().into());
                }
                "transcriptSections:sections"
            }
            Self::Memberships(start) => {
                args.insert("start".into(), f64::from(*start).into());
                "transcriptSections:memberships"
            }
        };
        (function, args)
    }
}

fn thread_args(thread: &str) -> BTreeMap<String, Value> {
    BTreeMap::from([("threadId".into(), thread.to_owned().into())])
}

struct WorkSync<'a, F> {
    client: UserConvexClient,
    store: Arc<TranscriptStore>,
    user: String,
    thread: String,
    changed: &'a F,
    downloaded: Notify,
}

impl<F: Fn(u32) + Send + Sync> WorkSync<'_, F> {
    async fn metadata(&self, state_tx: watch::Sender<WorkState>) -> anyhow::Result<()> {
        let mut updates = self.client.watch_all().await?;
        let mut subscriptions: BTreeMap<Feed, QuerySubscription> = BTreeMap::new();
        for feed in [
            Feed::State,
            Feed::Sections {
                after: String::new(),
                before: None,
            },
        ] {
            let (function, args) = feed.request(&self.thread);
            subscriptions.insert(feed, self.client.subscribe(function, args).await?);
        }
        let mut metadata = metadata::Metadata::default();
        while let Some(results) = updates.next().await {
            let Some(metadata::Update {
                state,
                snapshot,
                mut add,
                remove,
            }) = metadata.apply(
                subscriptions
                    .iter()
                    .map(|(feed, subscription)| {
                        (feed.clone(), results.get(subscription.id()).cloned())
                    })
                    .collect(),
            )?
            else {
                continue;
            };
            let stale = !snapshot.complete;
            let thread = self.thread.clone();
            let pending = self
                .store
                .with_work_replica(&self.user, &self.thread, move |replica| {
                    replica.save_snapshot(&thread, snapshot)?;
                    replica.pending_membership_pages(4)
                })
                .await?;
            apply_remote_state(
                &self.store,
                &self.user,
                &self.thread,
                &RemoteTranscriptState {
                    thread_id: self.thread.clone(),
                    total_parts: state.total_parts,
                    history_from_number: state.history_from_number,
                    context_summary: state.context_summary.clone(),
                },
                stale,
            )
            .await?;
            (self.changed)(state.total_parts);
            state_tx.send_replace(state);
            for feed in remove {
                subscriptions.remove(&feed);
            }
            for start in pending {
                let feed = Feed::Memberships(start);
                let active = subscriptions
                    .keys()
                    .chain(add.iter())
                    .filter(|feed| matches!(feed, Feed::Memberships(_)))
                    .count();
                if active < 4 && !subscriptions.contains_key(&feed) {
                    add.push(feed);
                }
            }
            for feed in add {
                let (function, args) = feed.request(&self.thread);
                subscriptions.insert(feed, self.client.subscribe(function, args).await?);
            }
        }
        anyhow::bail!("transcript metadata subscription ended")
    }

    async fn download(&self, mut states: watch::Receiver<WorkState>) -> anyhow::Result<()> {
        let mut seen_total = 0;
        let mut pending = Vec::new();
        loop {
            let total = states.borrow_and_update().total_parts;
            if total > seen_total {
                pending.push((seen_total, total));
                seen_total = total;
            }
            let Some((start, end)) = pending.pop() else {
                states.changed().await?;
                continue;
            };
            let lower = end.saturating_sub(4).max(start);
            if lower > start {
                pending.push((start, lower));
            }
            let numbers = self
                .store
                .with_work_replica(&self.user, &self.thread, move |replica| {
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
            let mut parts = self
                .store
                .read_parts(&self.user, &self.thread, &numbers)
                .await?;
            let missing: Vec<_> = numbers
                .iter()
                .copied()
                .filter(|number| !parts.iter().any(|part| part.number == *number))
                .collect();
            if !missing.is_empty() {
                let fetched = self.client.transcript_parts(&self.thread, &missing).await?;
                anyhow::ensure!(
                    fetched.len() == missing.len()
                        && missing
                            .iter()
                            .all(|number| fetched.iter().any(|part| part.number == *number)),
                    "incomplete transcript download"
                );
                self.store
                    .append_parts(&self.user, &self.thread, &fetched)
                    .await?;
                parts.extend(fetched);
            }
            let thread = self.thread.clone();
            self.store
                .with_work_replica(&self.user, &self.thread, move |replica| {
                    replica.save_parts(&thread, &parts)
                })
                .await?;
            self.downloaded.notify_one();
            (self.changed)(total);
        }
    }

    async fn process(&self, mut states: watch::Receiver<WorkState>) -> anyhow::Result<()> {
        states.changed().await?;
        let mut remote = WorkPosition::default();
        loop {
            let state = states.borrow_and_update().clone();
            remote = remote.max(state.through);
            let Some(batch) = self
                .store
                .with_work_replica(&self.user, &self.thread, move |replica| {
                    if let Some(batch) = replica.advance(remote)? {
                        return Ok(Some(batch));
                    }
                    if remote.part == state.total_parts && remote.item == 0 {
                        return replica.finish_inactive(state.active_run_id.as_deref(), remote);
                    }
                    Ok(None)
                })
                .await?
            else {
                tokio::select! {
                    result = states.changed() => { result?; }
                    () = self.downloaded.notified() => {}
                }
                continue;
            };
            if batch.through > remote || batch.finished_run_id.is_some() {
                anyhow::ensure!(batch.expected <= remote, "remote work checkpoint regressed");
                let mut submitted = batch.clone();
                submitted.expected = remote;
                if submitted.finished_run_id.is_some() {
                    submitted.through = remote;
                }
                let mut args = thread_args(&self.thread);
                args.insert(
                    "batch".into(),
                    Value::try_from(serde_json::to_value(&submitted)?)?,
                );
                let accepted: bool = self
                    .client
                    .mutate("transcriptSections:commit", args)
                    .await?;
                if !accepted {
                    let current: WorkState = self
                        .client
                        .query("transcriptSections:state", thread_args(&self.thread))
                        .await?;
                    anyhow::ensure!(
                        current.through > remote,
                        "work checkpoint conflict did not advance"
                    );
                    remote = current.through;
                    continue;
                }
                remote = remote.max(batch.through);
            }
            self.store
                .with_work_replica(&self.user, &self.thread, move |replica| {
                    replica.acknowledge_batch(batch.through)
                })
                .await?;
            (self.changed)(states.borrow().total_parts);
        }
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
    let sync = WorkSync {
        client,
        store,
        user,
        thread,
        changed: &changed,
        downloaded: Notify::new(),
    };
    let (states, state_rx) = watch::channel(WorkState::default());
    tokio::select! {
        result = async {
            tokio::try_join!(sync.metadata(states), sync.download(state_rx.clone()), sync.process(state_rx))
        } => { result?; }
        result = wait_for_reset(resets, &sync.user, &sync.thread) => { return result; }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::poll;
    use std::task::Poll;

    #[tokio::test]
    async fn idle_sync_restarts_only_for_its_replica_or_missed_resets() {
        let (resets, receiver) = broadcast::channel(1);
        let waiting = wait_for_reset(receiver, "user", "thread");
        tokio::pin!(waiting);
        assert!(poll!(&mut waiting).is_pending());
        resets.send(("other-user".into(), "thread".into())).unwrap();
        assert!(poll!(&mut waiting).is_pending());
        resets.send(("user".into(), "other-thread".into())).unwrap();
        assert!(poll!(&mut waiting).is_pending());
        resets.send(("user".into(), "thread".into())).unwrap();
        assert!(matches!(poll!(&mut waiting), Poll::Ready(Err(_))));

        let receiver = resets.subscribe();
        for _ in 0..2 {
            resets.send(("other-user".into(), "thread".into())).unwrap();
        }
        assert!(wait_for_reset(receiver, "user", "thread").await.is_err());
    }
}
