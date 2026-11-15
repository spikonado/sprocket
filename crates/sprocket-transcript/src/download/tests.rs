use std::future::{pending, ready};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::json;
use tokio::sync::oneshot;

use super::*;

fn part(number: u32) -> TranscriptPart {
    serde_json::from_value(json!({
        "number": number,
        "sourceKey": format!("prompt:{number}"),
        "kind": "prompt",
        "runId": "run",
        "prompt": { "text": format!("part {number}"), "imageUploads": [] }
    }))
    .unwrap()
}

fn newest(start: u32, end: u32, limit: usize) -> Vec<TranscriptPart> {
    (start..end).rev().take(limit).map(part).collect()
}

async fn saved(store: &TranscriptStore, start: u32, end: u32) -> Vec<u32> {
    store
        .read_parts_range("user", "thread", start, end)
        .await
        .unwrap()
        .iter()
        .map(|part| part.number)
        .collect()
}

#[tokio::test]
async fn downloads_newest_first_in_chunk_pages_and_skips_cached_parts() {
    let dir = tempfile::tempdir().unwrap();
    let store = TranscriptStore::new(dir.path().to_owned());
    let _lease = store.open_thread("user", "thread").await.unwrap();
    store
        .append_parts("user", "thread", &[part(150)])
        .await
        .unwrap();
    let mut requests = Vec::new();
    store
        .ensure_parts("user", "thread", 0, 257, |start, end| {
            requests.push((start, end));
            ready(Ok(newest(start, end, 40)))
        })
        .await
        .unwrap();
    assert_eq!(
        requests,
        [
            (200, 257),
            (200, 217),
            (151, 200),
            (151, 160),
            (100, 150),
            (100, 110),
            (0, 100),
            (0, 60),
            (0, 20),
        ]
    );
    assert_eq!(saved(&store, 0, 257).await, (0..257).collect::<Vec<_>>());
    let chunk = std::fs::read_to_string(
        store
            .thread_dir("user", "thread")
            .join("parts/00000100.jsonl"),
    )
    .unwrap();
    let numbers: Vec<u32> = chunk
        .lines()
        .map(|line| serde_json::from_str::<TranscriptPart>(line).unwrap().number)
        .collect();
    assert_eq!(numbers, (100..200).collect::<Vec<_>>());
}

#[tokio::test]
async fn concurrent_downloads_fetch_each_part_once() {
    let dir = tempfile::tempdir().unwrap();
    let store = TranscriptStore::new(dir.path().to_owned());
    let fetched = Arc::new(Mutex::new(Vec::new()));
    let download = |start: u32, end: u32| {
        let fetched = Arc::clone(&fetched);
        let store = Arc::clone(&store);
        async move {
            store
                .ensure_parts("user", "thread", start, end, |from, to| {
                    fetched.lock().unwrap().extend(from..to);
                    async move {
                        tokio::task::yield_now().await;
                        Ok(newest(from, to, usize::MAX))
                    }
                })
                .await
        }
    };
    let (first, second) = tokio::join!(download(0, 300), download(50, 250));
    first.unwrap();
    second.unwrap();
    let mut fetched = fetched.lock().unwrap().clone();
    fetched.sort_unstable();
    assert_eq!(fetched, (0..300).collect::<Vec<_>>());
}

#[tokio::test]
async fn a_cancelled_fetch_is_dropped_and_frees_the_download() {
    let dir = tempfile::tempdir().unwrap();
    let store = TranscriptStore::new(dir.path().to_owned());
    let (started_tx, started_rx) = oneshot::channel();
    let (dropped_tx, dropped_rx) = oneshot::channel::<()>();
    let stuck = tokio::spawn({
        let store = Arc::clone(&store);
        async move {
            store
                .download_missing_page("user", "thread", 0, 8, |_, _| async move {
                    let _fetch_lifetime = dropped_tx;
                    started_tx.send(()).unwrap();
                    pending::<anyhow::Result<Vec<TranscriptPart>>>().await
                })
                .await
        }
    });
    started_rx.await.unwrap();
    stuck.abort();
    assert!(stuck.await.unwrap_err().is_cancelled());
    assert!(dropped_rx.await.is_err());
    tokio::time::timeout(
        Duration::from_secs(2),
        store.ensure_parts("user", "thread", 0, 8, |start, end| {
            ready(Ok(newest(start, end, usize::MAX)))
        }),
    )
    .await
    .expect("the cancelled fetch kept the download lock")
    .unwrap();
    assert_eq!(saved(&store, 0, 8).await, (0..8).collect::<Vec<_>>());
}

#[tokio::test]
async fn foreground_demand_waits_for_one_background_page_not_its_backlog() {
    let dir = tempfile::tempdir().unwrap();
    let store = TranscriptStore::new(dir.path().to_owned());
    let (started_tx, started_rx) = oneshot::channel();
    let (release_tx, release_rx) = oneshot::channel();
    let background = tokio::spawn({
        let store = Arc::clone(&store);
        async move {
            let mut first = Some((started_tx, release_rx));
            store
                .ensure_parts("user", "thread", 0, 1000, |start, end| {
                    let first = first.take();
                    async move {
                        if let Some((started, release)) = first {
                            started.send(()).unwrap();
                            release.await.unwrap();
                            Ok(newest(start, end, 20))
                        } else {
                            pending::<anyhow::Result<Vec<TranscriptPart>>>().await
                        }
                    }
                })
                .await
        }
    });
    started_rx.await.unwrap();
    let foreground = store.download_missing_page("user", "thread", 500, 540, |start, end| {
        ready(Ok(newest(start, end, usize::MAX)))
    });
    tokio::pin!(foreground);
    assert!(futures::poll!(foreground.as_mut()).is_pending());
    release_tx.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(2), foreground)
        .await
        .expect("foreground waited for the background backlog")
        .unwrap();
    assert_eq!(
        saved(&store, 500, 540).await,
        (500..540).collect::<Vec<_>>()
    );
    background.abort();
    assert!(background.await.unwrap_err().is_cancelled());
}

#[tokio::test]
async fn a_timed_out_fetch_is_dropped_and_can_be_retried() {
    let dir = tempfile::tempdir().unwrap();
    let store = TranscriptStore::new(dir.path().to_owned());
    let (started_tx, started_rx) = oneshot::channel();
    let (dropped_tx, dropped_rx) = oneshot::channel::<()>();
    let stuck = tokio::spawn({
        let store = Arc::clone(&store);
        async move {
            store
                .download_missing_page("user", "thread", 0, 8, |_, _| async move {
                    let _fetch_lifetime = dropped_tx;
                    started_tx.send(()).unwrap();
                    pending::<anyhow::Result<Vec<TranscriptPart>>>().await
                })
                .await
        }
    });
    started_rx.await.unwrap();
    tokio::time::pause();
    tokio::time::advance(PAGE_DOWNLOAD_TIMEOUT).await;
    assert!(
        stuck
            .await
            .unwrap()
            .unwrap_err()
            .to_string()
            .contains("timed out")
    );
    assert!(dropped_rx.await.is_err());
    tokio::time::resume();
    store
        .ensure_parts("user", "thread", 0, 8, |start, end| {
            ready(Ok(newest(start, end, usize::MAX)))
        })
        .await
        .unwrap();
    assert_eq!(saved(&store, 0, 8).await, (0..8).collect::<Vec<_>>());
}

#[tokio::test]
async fn invalid_pages_save_nothing_and_can_be_retried() {
    let valid = newest(0, 4, usize::MAX);
    let mut gap = valid.clone();
    gap.remove(1);
    let mut outside = valid.clone();
    outside[0].number = 4;
    let mut ascending = valid.clone();
    ascending.reverse();
    let mut oversized = valid;
    oversized.insert(0, part(4));
    for invalid in [Vec::new(), gap, outside, ascending, oversized] {
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::new(dir.path().to_owned());
        store
            .download_missing_page("user", "thread", 0, 4, |_, _| ready(Ok(invalid)))
            .await
            .unwrap_err();
        assert!(saved(&store, 0, 8).await.is_empty());
        store
            .ensure_parts("user", "thread", 0, 4, |start, end| {
                ready(Ok(newest(start, end, usize::MAX)))
            })
            .await
            .unwrap();
        assert_eq!(saved(&store, 0, 4).await, [0, 1, 2, 3]);
    }
}

#[tokio::test]
async fn a_page_that_cannot_be_stored_stops_instead_of_refetching() {
    let dir = tempfile::tempdir().unwrap();
    let store = TranscriptStore::new(dir.path().to_owned());
    let mut cached = part(0);
    cached.source_key = "prompt:1".into();
    store
        .append_parts("user", "thread", &[cached])
        .await
        .unwrap();
    let error = store
        .ensure_parts("user", "thread", 0, 2, |start, end| {
            ready(Ok(newest(start, end, usize::MAX)))
        })
        .await
        .unwrap_err();
    assert!(error.to_string().contains("conflict"), "{error:#}");
}
