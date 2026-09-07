use std::future::Future;
use std::time::Duration;

use serde::Serialize;
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio::time::{self, Instant};

use crate::live::LiveAssistantPart;

/// Matches local `TRANSCRIPT_FLUSH_INTERVAL` so hosted tokens land at the same cadence.
pub(crate) const HOSTED_LIVE_PUBLISH_INTERVAL: Duration = Duration::from_millis(500);
/// Caps one Convex mutation so a hung RPC cannot stall the single writer.
pub(crate) const HOSTED_LIVE_WRITE_TIMEOUT: Duration = Duration::from_secs(8);
pub(crate) const HOSTED_LIVE_WRITE_ATTEMPTS: u32 = 3;
pub(crate) const HOSTED_LIVE_RETRY_DELAY: Duration = Duration::from_millis(250);

/// Oversize JSON/parts are dropped locally; the last in-bound overlay stays.
pub(crate) const MAX_LIVE_SNAPSHOT_BYTES: usize = 64 * 1024;
pub(crate) const MAX_LIVE_PARTS: usize = 256;

#[derive(Clone, Copy, Debug)]
pub(crate) struct HostedLiveWriteLimits {
    pub interval: Duration,
    pub write_timeout: Duration,
    pub max_attempts: u32,
    pub retry_delay: Duration,
}

const DEFAULT_WRITE_LIMITS: HostedLiveWriteLimits = HostedLiveWriteLimits {
    interval: HOSTED_LIVE_PUBLISH_INTERVAL,
    write_timeout: HOSTED_LIVE_WRITE_TIMEOUT,
    max_attempts: HOSTED_LIVE_WRITE_ATTEMPTS,
    retry_delay: HOSTED_LIVE_RETRY_DELAY,
};

#[derive(Clone, Debug)]
pub(crate) struct HostedLiveSnapshot {
    pub run_id: String,
    pub claim_id: String,
    pub attempt_seq: u64,
    pub stream_id: String,
    pub text: String,
    pub parts: Vec<LiveAssistantPart>,
}

/// No `providerMetadata`; extra fields would leak into stored overlay JSON.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredLiveOverlayPayload<'a> {
    claim_id: &'a str,
    attempt_seq: u64,
    stream_id: &'a str,
    text: &'a str,
    parts: &'a [LiveAssistantPart],
}

pub(crate) fn snapshot_within_bound(snapshot: &HostedLiveSnapshot) -> bool {
    if snapshot.parts.len() > MAX_LIVE_PARTS {
        return false;
    }
    serde_json::to_vec(&StoredLiveOverlayPayload {
        claim_id: &snapshot.claim_id,
        attempt_seq: snapshot.attempt_seq,
        stream_id: &snapshot.stream_id,
        text: &snapshot.text,
        parts: &snapshot.parts,
    })
    .map(|bytes| bytes.len() <= MAX_LIVE_SNAPSHOT_BYTES)
    .unwrap_or(false)
}

/// Latest-value channel: one writer; `publish` never waits on Convex.
pub(crate) struct HostedLivePublisher {
    tx: watch::Sender<Option<HostedLiveSnapshot>>,
    task: JoinHandle<()>,
}

impl HostedLivePublisher {
    pub fn spawn<F, Fut>(write: F) -> Self
    where
        F: Fn(HostedLiveSnapshot, u64) -> Fut + Send + 'static,
        Fut: Future<Output = bool> + Send + 'static,
    {
        let (tx, rx) = watch::channel(None);
        let task = tokio::spawn(write_hosted_live_snapshots(rx, DEFAULT_WRITE_LIMITS, write));
        Self { tx, task }
    }

    pub fn publish(&self, snapshot: HostedLiveSnapshot) {
        if !snapshot_within_bound(&snapshot) {
            return;
        }
        self.tx.send_replace(Some(snapshot));
    }
}

impl Drop for HostedLivePublisher {
    fn drop(&mut self) {
        self.task.abort();
    }
}

pub(crate) async fn write_hosted_live_snapshots<F, Fut>(
    mut rx: watch::Receiver<Option<HostedLiveSnapshot>>,
    limits: HostedLiveWriteLimits,
    write: F,
) where
    F: Fn(HostedLiveSnapshot, u64) -> Fut,
    Fut: Future<Output = bool>,
{
    let mut sequence = 0_u64;
    let mut last_write: Option<Instant> = None;
    let mut wait_for_change = true;
    loop {
        if wait_for_change && rx.changed().await.is_err() {
            return;
        }
        let Some(mut snapshot) = rx.borrow_and_update().clone() else {
            wait_for_change = true;
            continue;
        };
        wait_for_change = true;
        if let Some(last_write_at) = last_write {
            let elapsed = last_write_at.elapsed();
            if elapsed < limits.interval {
                time::sleep(limits.interval - elapsed).await;
                if let Some(latest) = rx.borrow_and_update().clone() {
                    snapshot = latest;
                }
            }
        }

        let mut attempts = 0;
        loop {
            attempts += 1;
            sequence += 1;
            let succeeded = match time::timeout(
                limits.write_timeout,
                write(snapshot.clone(), sequence),
            )
            .await
            {
                Ok(true) => true,
                Ok(false) | Err(_) => false,
            };
            if succeeded {
                last_write = Some(Instant::now());
                break;
            }
            match rx.has_changed() {
                Ok(true) => {
                    wait_for_change = false;
                    break;
                }
                Err(_) => return,
                Ok(false) if attempts >= limits.max_attempts => break,
                Ok(false) => {
                    tokio::select! {
                        _ = time::sleep(limits.retry_delay) => {}
                        result = rx.changed() => {
                            if result.is_err() {
                                return;
                            }
                            wait_for_change = false;
                            break;
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;
    use crate::live::LiveAssistantPart;
    use tokio::sync::mpsc;

    fn snapshot(text: &str) -> HostedLiveSnapshot {
        HostedLiveSnapshot {
            run_id: "run".into(),
            claim_id: "claim".into(),
            attempt_seq: 1,
            stream_id: "stream".into(),
            text: text.into(),
            parts: vec![LiveAssistantPart::Text {
                id: "t".into(),
                text: text.into(),
                started_at: None,
                completed_at: None,
                turn_id: Some("stream".into()),
            }],
        }
    }

    fn test_limits() -> HostedLiveWriteLimits {
        HostedLiveWriteLimits {
            interval: Duration::from_millis(500),
            write_timeout: Duration::from_secs(8),
            max_attempts: 3,
            retry_delay: Duration::from_millis(250),
        }
    }

    #[test]
    fn oversized_snapshots_and_too_many_parts_are_dropped_before_send() {
        let huge = snapshot(&"a".repeat(MAX_LIVE_SNAPSHOT_BYTES));
        assert!(!snapshot_within_bound(&huge));
        let mut many = snapshot("ok");
        many.parts = (0..=MAX_LIVE_PARTS)
            .map(|index| LiveAssistantPart::Text {
                id: format!("t{index}"),
                text: "x".into(),
                started_at: None,
                completed_at: None,
                turn_id: None,
            })
            .collect();
        assert!(!snapshot_within_bound(&many));
        assert!(snapshot_within_bound(&snapshot("hello")));
    }

    #[tokio::test(start_paused = true)]
    async fn coalesces_to_the_latest_snapshot_and_throttles() {
        let (tx, rx) = watch::channel(None);
        let (writes_tx, mut writes_rx) = mpsc::unbounded_channel();
        let writer = tokio::spawn(write_hosted_live_snapshots(
            rx,
            test_limits(),
            move |snapshot, sequence| {
                let writes_tx = writes_tx.clone();
                async move {
                    let _ = writes_tx.send((snapshot.text, sequence));
                    true
                }
            },
        ));

        tx.send_replace(Some(snapshot("a")));
        tx.send_replace(Some(snapshot("b")));
        let first = writes_rx.recv().await.expect("first write");
        assert_eq!(first, ("b".into(), 1));

        tx.send_replace(Some(snapshot("c")));
        tokio::task::yield_now().await;
        assert!(writes_rx.try_recv().is_err());

        tx.send_replace(Some(snapshot("d")));
        time::advance(Duration::from_millis(500)).await;
        let second = writes_rx.recv().await.expect("second write");
        assert_eq!(second, ("d".into(), 2));

        writer.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn retries_the_latest_frame_while_no_newer_snapshot_arrives() {
        let (tx, rx) = watch::channel(None);
        let (writes_tx, mut writes_rx) = mpsc::unbounded_channel();
        let failures = Arc::new(AtomicUsize::new(0));
        let writer = tokio::spawn(write_hosted_live_snapshots(rx, test_limits(), {
            let failures = Arc::clone(&failures);
            move |snapshot, sequence| {
                let writes_tx = writes_tx.clone();
                let failures = Arc::clone(&failures);
                async move {
                    let _ = writes_tx.send((snapshot.text, sequence));
                    failures.fetch_add(1, Ordering::SeqCst) >= 2
                }
            }
        }));

        tx.send_replace(Some(snapshot("hold")));
        let first = writes_rx.recv().await.expect("first attempt");
        assert_eq!(first, ("hold".into(), 1));
        time::advance(Duration::from_millis(250)).await;
        let second = writes_rx.recv().await.expect("retry");
        assert_eq!(second, ("hold".into(), 2));
        time::advance(Duration::from_millis(250)).await;
        let third = writes_rx.recv().await.expect("success");
        assert_eq!(third, ("hold".into(), 3));
        assert!(writes_rx.try_recv().is_err());

        writer.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn does_not_retry_a_stale_snapshot_after_a_newer_one_arrives() {
        let (tx, rx) = watch::channel(None);
        let (writes_tx, mut writes_rx) = mpsc::unbounded_channel();
        let writer = tokio::spawn(write_hosted_live_snapshots(
            rx,
            test_limits(),
            move |snapshot, sequence| {
                let writes_tx = writes_tx.clone();
                async move {
                    let succeeded = snapshot.text != "old";
                    let _ = writes_tx.send((snapshot.text, sequence));
                    succeeded
                }
            },
        ));

        tx.send_replace(Some(snapshot("old")));
        let first = writes_rx.recv().await.expect("old attempt");
        assert_eq!(first, ("old".into(), 1));
        tx.send_replace(Some(snapshot("fresh")));
        let second = writes_rx.recv().await.expect("fresh write");
        assert_eq!(second, ("fresh".into(), 2));

        writer.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn write_timeout_does_not_block_the_writer() {
        let (tx, rx) = watch::channel(None);
        let (writes_tx, mut writes_rx) = mpsc::unbounded_channel();
        let mut limits = test_limits();
        limits.write_timeout = Duration::from_secs(1);
        limits.retry_delay = Duration::from_millis(100);
        let writer = tokio::spawn(write_hosted_live_snapshots(
            rx,
            limits,
            move |snapshot, sequence| {
                let writes_tx = writes_tx.clone();
                async move {
                    let _ = writes_tx.send(sequence);
                    time::sleep(Duration::from_secs(30)).await;
                    let _ = snapshot;
                    true
                }
            },
        ));

        tx.send_replace(Some(snapshot("slow")));
        assert_eq!(writes_rx.recv().await, Some(1));
        time::advance(Duration::from_secs(1)).await;
        time::advance(Duration::from_millis(100)).await;
        assert_eq!(writes_rx.recv().await, Some(2));

        writer.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn drop_aborts_an_in_flight_write() {
        let (writes_tx, mut writes_rx) = mpsc::unbounded_channel::<String>();
        let publisher = HostedLivePublisher::spawn(move |snapshot, _sequence| {
            let writes_tx = writes_tx.clone();
            async move {
                time::sleep(Duration::from_secs(10)).await;
                let _ = writes_tx.send(snapshot.text);
                true
            }
        });
        publisher.publish(snapshot("late"));
        tokio::task::yield_now().await;
        drop(publisher);
        time::advance(Duration::from_secs(10)).await;
        tokio::task::yield_now().await;
        assert!(writes_rx.try_recv().is_err());
    }

    #[test]
    fn overlay_payload_omits_provider_metadata() {
        let encoded = serde_json::to_value(&StoredLiveOverlayPayload {
            claim_id: "claim",
            attempt_seq: 1,
            stream_id: "stream",
            text: "hi",
            parts: &snapshot("hi").parts,
        })
        .unwrap();
        assert!(encoded.get("providerMetadata").is_none());
        assert!(encoded["parts"][0].get("providerMetadata").is_none());
        assert_eq!(encoded["claimId"], "claim");
    }
}
