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
    use sprocket_transcript::TranscriptPart;
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
    let store = TranscriptStore::new(dir.path().to_owned());
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
    let mut downloading = tokio::spawn({
        let store = Arc::clone(&store);
        let requests = Arc::clone(&requests);
        let fetched_numbers = Arc::clone(&fetched_numbers);
        async move {
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
            download(&store, "user", "thread", state_rx, &changed, fetch).await
        }
    });
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
    downloading.abort();
    assert!(downloading.await.unwrap_err().is_cancelled());
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
