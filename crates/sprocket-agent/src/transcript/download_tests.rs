use std::future::{pending, ready};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::json;
use tokio::sync::oneshot;

use super::monitor::{MONITOR_PAGE_CHAR_LIMIT, MonitorEntry, download_monitor_page};
use super::{DownloadOrder, TRANSCRIPT_CHUNK_SIZE, TranscriptPart, TranscriptStore};

fn prompt(number: u32, text: &str) -> TranscriptPart {
    serde_json::from_value(json!({
        "number": number,
        "sourceKey": format!("prompt:{number}"),
        "kind": "prompt",
        "runId": format!("run-{number}"),
        "prompt": { "text": text, "imageUploads": [] }
    }))
    .unwrap()
}

fn part(number: u32) -> TranscriptPart {
    prompt(number, &format!("part {number}"))
}

fn page(start: u32, end: u32, order: DownloadOrder, limit: usize) -> Vec<TranscriptPart> {
    match order {
        DownloadOrder::Asc => (start..end).take(limit).map(part).collect(),
        DownloadOrder::Desc => (start..end).rev().take(limit).map(part).collect(),
    }
}

async fn assert_saved(store: &TranscriptStore, start: u32, end: u32) {
    let numbers: Vec<_> = (start..end).collect();
    assert_eq!(
        store.read_parts("user", "thread", &numbers).await.unwrap(),
        numbers.iter().copied().map(part).collect::<Vec<_>>()
    );
    let state = store.load_state("user", "thread").await.unwrap();
    assert!(numbers.iter().all(|&number| state.covers(number)));
    store
        .with_work_replica("user", "thread", move |replica| {
            for number in numbers {
                assert_eq!(replica.part(number)?, Some(part(number)));
                let text: String = replica.db.query_row(
                    "SELECT json_extract(body,'$.text') FROM rows WHERE part=? AND kind='prompt'",
                    [number],
                    |row| row.get(0),
                )?;
                assert_eq!(text, format!("part {number}"));
            }
            Ok(())
        })
        .await
        .unwrap();
}

async fn assert_empty(store: &TranscriptStore) {
    assert!(
        store
            .read_parts("user", "thread", &(0..8).collect::<Vec<_>>())
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        store
            .load_state("user", "thread")
            .await
            .unwrap()
            .downloaded_ranges
            .is_empty()
    );
    store
        .with_work_replica("user", "thread", |replica| {
            let counts: (u32, u32, u32) = replica.db.query_row(
                "SELECT (SELECT COUNT(*) FROM parts), (SELECT COUNT(*) FROM rows),
                    (SELECT COUNT(*) FROM coverage)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            assert_eq!(counts, (0, 0, 0));
            Ok(())
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn cold_ranges_complete_in_both_directions_with_twenty_part_pages() {
    for order in [DownloadOrder::Asc, DownloadOrder::Desc] {
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::new(dir.path().to_owned());
        let mut fetched = Vec::new();
        let mut fetch = |start, end, actual_order| {
            assert!(matches!(
                (order, actual_order),
                (DownloadOrder::Asc, DownloadOrder::Asc)
                    | (DownloadOrder::Desc, DownloadOrder::Desc)
            ));
            let parts = page(start, end, actual_order, 20);
            fetched.extend(parts.iter().map(|part| part.number));
            ready(Ok(parts))
        };
        let remaining = store
            .download_parts_page("user", "thread", 0, 257, order, &mut fetch)
            .await
            .unwrap();
        assert_eq!(
            remaining,
            match order {
                DownloadOrder::Asc => (20, 257),
                DownloadOrder::Desc => (0, 237),
            }
        );
        store
            .ensure_parts(
                "user",
                "thread",
                remaining.0,
                remaining.1,
                order,
                &mut fetch,
            )
            .await
            .unwrap();
        let expected: Vec<_> = match order {
            DownloadOrder::Asc => (0..257).collect(),
            DownloadOrder::Desc => (0..257).rev().collect(),
        };
        assert_eq!(fetched, expected);
        assert_saved(&store, 0, 257).await;

        let reopened = TranscriptStore::new(dir.path().to_owned());
        reopened
            .ensure_parts("user", "thread", 0, 257, order, |_, _, _| {
                ready(Err(anyhow::anyhow!("cached history was fetched again")))
            })
            .await
            .unwrap();
        assert_saved(&reopened, 0, 257).await;
    }
}

#[tokio::test]
async fn cached_islands_are_indexed_and_only_the_gaps_are_fetched() {
    for order in [DownloadOrder::Asc, DownloadOrder::Desc] {
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::new(dir.path().to_owned());
        let cached: Vec<_> = (0..15)
            .chain(35..60)
            .chain(95..125)
            .chain(150..175)
            .chain(225..240)
            .collect();
        store
            .append_parts(
                "user",
                "thread",
                &cached.iter().copied().map(part).collect::<Vec<_>>(),
            )
            .await
            .unwrap();
        let mut fetched = Vec::new();
        store
            .ensure_parts("user", "thread", 0, 253, order, |start, end, order| {
                assert!((start..end).all(|number| !cached.contains(&number)));
                let parts = page(start, end, order, 20);
                fetched.extend(parts.iter().map(|part| part.number));
                ready(Ok(parts))
            })
            .await
            .unwrap();
        let mut expected: Vec<_> = (0..253).filter(|number| !cached.contains(number)).collect();
        if matches!(order, DownloadOrder::Desc) {
            expected.reverse();
        }
        assert_eq!(fetched, expected);
        assert_saved(&store, 0, 253).await;
    }
}

#[tokio::test]
async fn overlapping_opposite_direction_downloads_fetch_each_part_once() {
    let dir = tempfile::tempdir().unwrap();
    let store = TranscriptStore::new(dir.path().to_owned());
    let fetched = Arc::new(Mutex::new(Vec::new()));
    let (started_tx, started_rx) = oneshot::channel();
    let (release_tx, release_rx) = oneshot::channel();
    let ascending = tokio::spawn({
        let store = Arc::clone(&store);
        let fetched = Arc::clone(&fetched);
        async move {
            let mut first_page = Some((started_tx, release_rx));
            store
                .ensure_parts(
                    "user",
                    "thread",
                    0,
                    240,
                    DownloadOrder::Asc,
                    |start, end, order| {
                        let first_page = first_page.take();
                        let fetched = Arc::clone(&fetched);
                        async move {
                            if let Some((started, release)) = first_page {
                                started.send(()).unwrap();
                                release.await.unwrap();
                            }
                            let parts = page(start, end, order, usize::MAX);
                            fetched
                                .lock()
                                .unwrap()
                                .extend(parts.iter().map(|part| part.number));
                            Ok(parts)
                        }
                    },
                )
                .await
        }
    });
    started_rx.await.unwrap();
    let descending = store.ensure_parts(
        "user",
        "thread",
        0,
        180,
        DownloadOrder::Desc,
        |start, end, order| {
            let parts = page(start, end, order, usize::MAX);
            fetched
                .lock()
                .unwrap()
                .extend(parts.iter().map(|part| part.number));
            ready(Ok(parts))
        },
    );
    tokio::pin!(descending);
    assert!(futures::poll!(descending.as_mut()).is_pending());
    release_tx.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        let (ascending, descending) = tokio::join!(ascending, descending);
        ascending.unwrap().unwrap();
        descending.unwrap();
    })
    .await
    .unwrap();
    let mut fetched = fetched.lock().unwrap().clone();
    fetched.sort_unstable();
    assert_eq!(fetched, (0..240).collect::<Vec<_>>());
    assert_saved(&store, 0, 240).await;
}

#[tokio::test]
async fn foreground_demand_waits_for_the_current_background_page_only() {
    let dir = tempfile::tempdir().unwrap();
    let store = TranscriptStore::new(dir.path().to_owned());
    let (started_tx, started_rx) = oneshot::channel();
    let (release_tx, release_rx) = oneshot::channel();
    let background = tokio::spawn({
        let store = Arc::clone(&store);
        async move {
            let mut first_page = Some((started_tx, release_rx));
            store
                .ensure_parts(
                    "user",
                    "thread",
                    0,
                    1000,
                    DownloadOrder::Asc,
                    |start, end, order| {
                        let first_page = first_page.take();
                        async move {
                            if let Some((started, release)) = first_page {
                                started.send(()).unwrap();
                                release.await.unwrap();
                                Ok(page(start, end, order, 20))
                            } else {
                                pending::<anyhow::Result<Vec<TranscriptPart>>>().await
                            }
                        }
                    },
                )
                .await
        }
    });
    started_rx.await.unwrap();
    let foreground = store.ensure_parts(
        "user",
        "thread",
        900,
        940,
        DownloadOrder::Desc,
        |start, end, order| ready(Ok(page(start, end, order, usize::MAX))),
    );
    tokio::pin!(foreground);
    assert!(futures::poll!(foreground.as_mut()).is_pending());
    release_tx.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(2), foreground)
        .await
        .expect("foreground demand waited for the background backlog")
        .unwrap();
    assert_saved(&store, 900, 940).await;
    assert_saved(&store, 0, 20).await;
    assert_eq!(
        store
            .missing_numbers("user", "thread", 20, 900)
            .await
            .unwrap(),
        (20..900).collect::<Vec<_>>()
    );
    assert!(!background.is_finished());
    background.abort();
    assert!(background.await.unwrap_err().is_cancelled());
}

enum FetchFailure {
    Auth,
    Timeout,
    Cancellation,
}

struct DroppedFetch(Arc<AtomicBool>);

impl Drop for DroppedFetch {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

async fn recover_from_failed_auth_fetch(failure: FetchFailure) {
    let dir = tempfile::tempdir().unwrap();
    let store = TranscriptStore::new(dir.path().to_owned());
    let dropped = Arc::new(AtomicBool::new(false));
    let (started_tx, started_rx) = oneshot::channel();
    let (release_tx, release_rx) = oneshot::channel();
    let failing = tokio::spawn({
        let store = Arc::clone(&store);
        let dropped = Arc::clone(&dropped);
        async move {
            store
                .download_parts_page(
                    "user",
                    "thread",
                    0,
                    8,
                    DownloadOrder::Asc,
                    |_, _, _| async move {
                        let _dropped = DroppedFetch(dropped);
                        started_tx.send(()).unwrap();
                        release_rx.await.unwrap();
                        Err(anyhow::anyhow!("expired auth"))
                    },
                )
                .await
        }
    });
    started_rx.await.unwrap();
    if matches!(failure, FetchFailure::Timeout) {
        tokio::time::pause();
    }
    let healthy = store.download_parts_page(
        "user",
        "thread",
        0,
        8,
        DownloadOrder::Desc,
        |start, end, order| {
            assert!(dropped.load(Ordering::SeqCst));
            ready(Ok(page(start, end, order, usize::MAX)))
        },
    );
    tokio::pin!(healthy);
    assert!(futures::poll!(healthy.as_mut()).is_pending());
    match failure {
        FetchFailure::Auth => {
            release_tx.send(()).unwrap();
            assert_eq!(
                failing.await.unwrap().unwrap_err().to_string(),
                "expired auth"
            );
        }
        FetchFailure::Timeout => {
            tokio::time::advance(Duration::from_secs(30)).await;
            assert!(
                failing
                    .await
                    .unwrap()
                    .unwrap_err()
                    .to_string()
                    .contains("timed out")
            );
            tokio::time::resume();
        }
        FetchFailure::Cancellation => {
            failing.abort();
            assert!(failing.await.unwrap_err().is_cancelled());
        }
    }
    assert!(dropped.load(Ordering::SeqCst));
    assert_empty(&store).await;
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(2), healthy)
            .await
            .expect("a different auth callback could not acquire the download lock")
            .unwrap(),
        (0, 0)
    );
    assert_saved(&store, 0, 8).await;
}

#[tokio::test]
async fn auth_failure_releases_the_lock_for_a_different_auth_callback() {
    recover_from_failed_auth_fetch(FetchFailure::Auth).await;
}

#[tokio::test]
async fn timed_out_fetch_is_dropped_and_a_different_auth_callback_succeeds() {
    recover_from_failed_auth_fetch(FetchFailure::Timeout).await;
}

#[tokio::test]
async fn cancelled_fetch_is_dropped_and_a_different_auth_callback_succeeds() {
    recover_from_failed_auth_fetch(FetchFailure::Cancellation).await;
}

#[tokio::test]
async fn invalid_pages_leave_no_partial_files_or_indexes_and_can_be_retried() {
    for order in [DownloadOrder::Asc, DownloadOrder::Desc] {
        let valid = page(0, 4, order, usize::MAX);
        let mut gap = valid.clone();
        gap.remove(1);
        let mut duplicate = valid.clone();
        duplicate[2].number = duplicate[1].number;
        let mut outside = valid.clone();
        outside[2].number = 4;
        let mut reversed = valid.clone();
        reversed.reverse();
        let mut oversized = valid;
        oversized.push(part(4));
        for invalid in [Vec::new(), gap, duplicate, outside, reversed, oversized] {
            let dir = tempfile::tempdir().unwrap();
            let store = TranscriptStore::new(dir.path().to_owned());
            store
                .download_parts_page("user", "thread", 0, 4, order, |_, _, _| ready(Ok(invalid)))
                .await
                .unwrap_err();
            assert_empty(&store).await;
            let remaining = store
                .download_parts_page("user", "thread", 0, 4, order, |start, end, order| {
                    ready(Ok(page(start, end, order, usize::MAX)))
                })
                .await
                .unwrap();
            assert_eq!(remaining.0, remaining.1);
            assert_saved(&store, 0, 4).await;
        }
    }
}

fn monitor_part(number: u32) -> TranscriptPart {
    if number == 0 {
        return prompt(0, &"界".repeat(MONITOR_PAGE_CHAR_LIMIT * 2 + 37));
    }
    serde_json::from_value(json!({
        "number": number,
        "sourceKey": format!("completion:run:{number}"),
        "kind": "completion",
        "runId": "run-0",
        "completion": {
            "streamId": number.to_string(),
            "items": if number == 150 {
                vec![json!({"type":"text","text":"completed answer"})]
            } else {
                Vec::new()
            }
        }
    }))
    .unwrap()
}

#[tokio::test]
async fn stale_monitor_total_preserves_newer_cached_answers_and_known_history() {
    for known_total in [2, 3] {
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::new(dir.path().to_owned());
        let answer: TranscriptPart = serde_json::from_value(json!({
            "number": 1,
            "sourceKey": "completion:run:1",
            "kind": "completion",
            "runId": "run-0",
            "completion": {
                "streamId": "1",
                "items": [{"type": "text", "text": "final answer"}]
            }
        }))
        .unwrap();
        let parts = vec![prompt(0, "question"), answer];
        store.append_parts("user", "thread", &parts).await.unwrap();
        store
            .with_work_replica("user", "thread", move |replica| {
                replica.set_remote_total(known_total)?;
                replica.save_parts("thread", &parts)
            })
            .await
            .unwrap();

        let monitor = download_monitor_page(&store, "user", "thread", None, 1, |_, _, _| {
            ready(Err(anyhow::anyhow!(
                "cached monitor output triggered a fetch"
            )))
        })
        .await
        .unwrap();
        assert_eq!(
            monitor.entries,
            vec![
                MonitorEntry::Prompt {
                    id: "prompt-0".into(),
                    text: "question".into(),
                },
                MonitorEntry::Text {
                    id: "text-1-0".into(),
                    text: "final answer".into(),
                },
            ]
        );
        assert_eq!(monitor.has_more, known_total > 2);
        store
            .with_work_replica("user", "thread", move |replica| {
                assert_eq!(replica.state::<u32>("total")?, Some(known_total));
                let display = replica.page(None, 10, None, &[], false)?;
                assert_eq!(display["rows"][1]["text"], "final answer");
                assert_eq!(display["syncing"], known_total > 2);
                Ok(())
            })
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn monitor_returns_the_prompt_then_cached_cursor_output_before_advancing_the_prefix() {
    let dir = tempfile::tempdir().unwrap();
    let store = TranscriptStore::new(dir.path().to_owned());
    let mut calls = Vec::new();
    let first = download_monitor_page(&store, "user", "thread", None, 1000, |start, end, order| {
        assert!(matches!(order, DownloadOrder::Asc));
        calls.push((start, end));
        ready(Ok((start..end).take(20).map(monitor_part).collect()))
    })
    .await
    .unwrap();
    assert_eq!(calls, vec![(0, TRANSCRIPT_CHUNK_SIZE)]);
    assert_eq!(
        first.entries,
        vec![MonitorEntry::Prompt {
            id: "prompt-0".into(),
            text: "界".repeat(MONITOR_PAGE_CHAR_LIMIT),
        }]
    );
    assert!(first.has_more);

    let second = download_monitor_page(
        &store,
        "user",
        "thread",
        Some(&first.next_cursor),
        1000,
        |_, _, _| {
            ready(Err(anyhow::anyhow!(
                "cached prompt continuation triggered a fetch"
            )))
        },
    )
    .await
    .unwrap();
    assert_eq!(second.entries, first.entries);
    assert_ne!(second.next_cursor, first.next_cursor);
    assert!(second.has_more);
    let third = download_monitor_page(
        &store,
        "user",
        "thread",
        Some(&second.next_cursor),
        1000,
        |_, _, _| {
            ready(Err(anyhow::anyhow!(
                "cached prompt suffix triggered a fetch"
            )))
        },
    )
    .await
    .unwrap();
    assert_eq!(
        third.entries,
        vec![MonitorEntry::Prompt {
            id: "prompt-0".into(),
            text: "界".repeat(37),
        }]
    );
    assert!(third.has_more);
    let fourth = download_monitor_page(
        &store,
        "user",
        "thread",
        Some(&third.next_cursor),
        1000,
        |start, end, order| {
            assert!(matches!(order, DownloadOrder::Asc));
            calls.push((start, end));
            ready(Ok((start..end).take(20).map(monitor_part).collect()))
        },
    )
    .await
    .unwrap();
    assert_eq!(
        fourth.entries,
        vec![MonitorEntry::Text {
            id: "text-150-0".into(),
            text: "completed answer".into(),
        }]
    );
    assert!(fourth.has_more);
    assert_ne!(fourth.next_cursor, third.next_cursor);
    assert_eq!(
        calls,
        (0..160)
            .step_by(20)
            .map(|start| (start, start + TRANSCRIPT_CHUNK_SIZE))
            .collect::<Vec<_>>()
    );
    store
        .with_work_replica("user", "thread", |replica| {
            assert_eq!(replica.downloaded_prefix()?, 160);
            Ok(())
        })
        .await
        .unwrap();
    assert_eq!(
        store
            .missing_numbers("user", "thread", 160, 1000)
            .await
            .unwrap(),
        (160..1000).collect::<Vec<_>>()
    );
}
