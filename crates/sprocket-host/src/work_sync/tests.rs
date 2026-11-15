use std::sync::Mutex;

use super::*;

fn prompt(number: u32) -> TranscriptPart {
    serde_json::from_value(serde_json::json!({
        "number": number, "sourceKey": format!("prompt:{number}"),
        "runId": "run", "kind": "prompt",
        "prompt": {"text": format!("Part {number}"), "imageUploads": []}
    }))
    .unwrap()
}

#[tokio::test]
async fn downloads_around_cached_gaps_and_new_parts_first() {
    let dir = tempfile::tempdir().unwrap();
    let store = TranscriptStore::new(dir.path().to_owned());
    let _lease = store.open_thread("user", "thread").await.unwrap();
    store
        .append_parts("user", "thread", &[prompt(115), prompt(210)])
        .await
        .unwrap();
    let (totals, total_rx) = watch::channel(250);
    let mut changes = store.watch_changes();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let downloading = tokio::spawn({
        let store = Arc::clone(&store);
        let requests = Arc::clone(&requests);
        async move {
            let fetch = |start: u32, end: u32| {
                let mut requests = requests.lock().unwrap();
                if requests.is_empty() {
                    raise(&totals, 251);
                }
                requests.push((start, end));
                let parts: Vec<TranscriptPart> = (start.max(end.saturating_sub(20))..end)
                    .rev()
                    .map(prompt)
                    .collect();
                std::future::ready(Ok(parts))
            };
            download(&store, "user", "thread", total_rx, fetch).await
        }
    });
    tokio::time::timeout(std::time::Duration::from_secs(30), async {
        while store
            .read_parts_range("user", "thread", 0, 251)
            .await
            .unwrap()
            .len()
            < 251
        {
            changes.recv().await.unwrap();
        }
    })
    .await
    .unwrap();
    downloading.abort();
    assert!(downloading.await.unwrap_err().is_cancelled());
    let requests = requests.lock().unwrap();
    assert_eq!(requests[..3], [(211, 250), (250, 251), (211, 230)]);
}

#[tokio::test]
async fn cancelling_download_drops_the_in_flight_fetch() {
    let dir = tempfile::tempdir().unwrap();
    let store = TranscriptStore::new(dir.path().to_owned());
    let (_totals, total_rx) = watch::channel(1);
    let (started, fetching) = tokio::sync::oneshot::channel();
    let (dropped, cancelled) = tokio::sync::oneshot::channel::<()>();
    let mut signals = Some((started, dropped));
    let downloading = tokio::spawn(async move {
        download(&store, "user", "thread", total_rx, move |_, _| {
            let (started, dropped) = signals.take().unwrap();
            async move {
                let _fetch = dropped;
                started.send(()).unwrap();
                std::future::pending::<anyhow::Result<Vec<TranscriptPart>>>().await
            }
        })
        .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), fetching)
        .await
        .unwrap()
        .unwrap();
    downloading.abort();
    assert!(downloading.await.unwrap_err().is_cancelled());
    assert!(cancelled.await.is_err());
}

#[tokio::test]
async fn startup_cutoff_stays_fixed_when_the_remote_total_changes() {
    let start = RunStart::default();
    assert_eq!(
        start.initialize("thread", || async { Ok(100) }).await,
        Some(100)
    );
    assert_eq!(
        start.initialize("thread", || async { Ok(107) }).await,
        Some(100)
    );
}

#[tokio::test]
async fn failed_startup_query_keeps_a_full_reconciliation_cutoff() {
    let start = RunStart::default();
    assert_eq!(
        start
            .initialize("thread", || async { anyhow::bail!("offline") })
            .await,
        None
    );
    assert_eq!(
        start
            .initialize("thread", || async {
                panic!("startup cutoff must stay fixed")
            })
            .await,
        None
    );
}
