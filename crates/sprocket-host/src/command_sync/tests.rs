use std::sync::atomic::{AtomicUsize, Ordering};

use super::*;

fn event(sequence: u64, channel: &str, bytes: &[u8]) -> Vec<u8> {
    let mut encoded = serde_json::to_vec(&serde_json::json!({
        "sequence": sequence,
        "timestampMs": 123,
        "channel": channel,
        "bytes": bytes,
    }))
    .unwrap();
    encoded.push(b'\n');
    encoded
}

#[cfg(unix)]
#[tokio::test]
async fn captured_command_events_rebuild_the_original_log() {
    use sprocket_workspace::{CommandSessionManager, WorkspaceCancellation, default_command_shell};

    let directory = tempfile::tempdir().unwrap();
    let sessions =
        CommandSessionManager::new(directory.path().into(), directory.path().join("logs"));
    let captured = sessions
        .exec_command(
            WorkspaceCancellation::new(),
            "printf '\\033[32mready\\000\\377\\n'; printf 'warning\\n' >&2",
            ".",
            &default_command_shell(),
            None,
            5_000,
            20_000,
        )
        .await
        .unwrap();
    assert!(captured.result.success);
    let output = directory.path().join("rebuilt.log");
    rebuild_output(Path::new(&captured.result.events_path), &output, false)
        .await
        .unwrap();
    assert_eq!(
        tokio::fs::read(output).await.unwrap(),
        tokio::fs::read(captured.result.complete_log_path)
            .await
            .unwrap()
    );
}

#[tokio::test]
async fn downloaded_events_rebuild_exact_combined_output_across_partial_batches() {
    let directory = tempfile::tempdir().unwrap();
    let events = directory.path().join("events.jsonl");
    let output = directory.path().join("output.log");
    tokio::fs::write(&events, b"").await.unwrap();
    rebuild_output(&events, &output, false).await.unwrap();
    assert_eq!(tokio::fs::read(&output).await.unwrap(), b"");
    let first = event(0, "stdout", b"\x1b[32mready\x00\xff\n");
    let second = event(1, "stderr", b"warning\n");
    let third = event(2, "stdout", "done \u{1f680}\n".as_bytes());
    let mut downloaded = first.clone();
    downloaded.extend_from_slice(&second[..second.len() / 2]);
    tokio::fs::write(&events, &downloaded).await.unwrap();
    rebuild_output(&events, &output, true).await.unwrap();
    assert_eq!(
        tokio::fs::read(&output).await.unwrap(),
        b"\x1b[32mready\x00\xff\n"
    );

    downloaded.extend_from_slice(&second[second.len() / 2..]);
    downloaded.extend_from_slice(&third);
    tokio::fs::write(&events, &downloaded).await.unwrap();
    let expected = [
        b"\x1b[32mready\x00\xff\nwarning\n".as_slice(),
        "done \u{1f680}\n".as_bytes(),
    ]
    .concat();
    for _ in 0..2 {
        rebuild_output(&events, &output, false).await.unwrap();
        assert_eq!(tokio::fs::read(&output).await.unwrap(), expected);
    }
    assert_eq!(tokio::fs::read(&events).await.unwrap(), downloaded);
}

#[tokio::test]
async fn invalid_events_preserve_the_previous_output() {
    let directory = tempfile::tempdir().unwrap();
    let events = directory.path().join("events.jsonl");
    let output = directory.path().join("output.log");
    tokio::fs::write(&output, b"previous output").await.unwrap();
    let incomplete = event(0, "stdout", b"unfinished");
    for bytes in [
        event(1, "stdout", b"sequence gap"),
        b"not JSON\n".to_vec(),
        incomplete[..incomplete.len() - 1].to_vec(),
    ] {
        tokio::fs::write(&events, bytes).await.unwrap();
        assert!(rebuild_output(&events, &output, false).await.is_err());
        assert_eq!(tokio::fs::read(&output).await.unwrap(), b"previous output");
    }
}

async fn running_history(directory: &Path) -> CommandHistory {
    let output = directory.join("output.log");
    let events = directory.join("events.jsonl");
    tokio::fs::write(&output, b"").await.unwrap();
    tokio::fs::write(&events, b"").await.unwrap();
    CommandHistory {
        user_id: "user".into(),
        thread_id: "thread".into(),
        machine_id: "machine".into(),
        command: "build".into(),
        workdir: "/workspace".into(),
        max_output_chars: 20_000,
        result: CommandOutput {
            exit_code: None,
            success: false,
            running: true,
            timed_out: false,
            output: String::new(),
            complete_log_path: output.to_string_lossy().into_owned(),
            events_path: events.to_string_lossy().into_owned(),
            error: None,
        },
        pending_output: None,
    }
}

async fn acknowledged_sync(calls: &AtomicUsize, outcome: SyncOutcome) -> Result<SyncOutcome> {
    calls.fetch_add(1, Ordering::Relaxed);
    Ok(outcome)
}

#[tokio::test]
async fn idle_sessions_sync_again_for_events_and_completion() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("session.json");
    let mut history = running_history(directory.path()).await;
    let mut idle = IdleSessions::new();
    let calls = AtomicUsize::new(0);

    for _ in 0..3 {
        assert!(
            !sync_when_changed(
                &mut idle,
                &path,
                &history,
                acknowledged_sync(&calls, SyncOutcome::RunningCaughtUp),
            )
            .await
            .unwrap()
        );
    }
    assert_eq!(calls.load(Ordering::Relaxed), 1);

    tokio::fs::write(&history.result.events_path, b"new event")
        .await
        .unwrap();
    for _ in 0..2 {
        sync_when_changed(
            &mut idle,
            &path,
            &history,
            acknowledged_sync(&calls, SyncOutcome::RunningCaughtUp),
        )
        .await
        .unwrap();
    }
    assert_eq!(calls.load(Ordering::Relaxed), 2);

    history.result.running = false;
    history.result.exit_code = Some(0);
    history.result.success = true;
    assert!(
        sync_when_changed(
            &mut idle,
            &path,
            &history,
            acknowledged_sync(&calls, SyncOutcome::Completed),
        )
        .await
        .unwrap()
    );
    assert_eq!(calls.load(Ordering::Relaxed), 3);
    assert!(idle.is_empty());
}

#[tokio::test]
async fn pending_batches_and_failed_uploads_retry_until_acknowledged() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("session.json");
    let history = running_history(directory.path()).await;
    let mut idle = IdleSessions::new();
    let calls = AtomicUsize::new(0);

    for _ in 0..2 {
        sync_when_changed(
            &mut idle,
            &path,
            &history,
            acknowledged_sync(&calls, SyncOutcome::Pending),
        )
        .await
        .unwrap();
    }
    let failed = sync_when_changed(&mut idle, &path, &history, async {
        calls.fetch_add(1, Ordering::Relaxed);
        bail!("upload failed");
    })
    .await;
    assert!(failed.is_err());

    for _ in 0..2 {
        sync_when_changed(
            &mut idle,
            &path,
            &history,
            acknowledged_sync(&calls, SyncOutcome::RunningCaughtUp),
        )
        .await
        .unwrap();
    }
    assert_eq!(calls.load(Ordering::Relaxed), 4);

    let mut restarted = IdleSessions::new();
    sync_when_changed(
        &mut restarted,
        &path,
        &history,
        acknowledged_sync(&calls, SyncOutcome::RunningCaughtUp),
    )
    .await
    .unwrap();
    assert_eq!(calls.load(Ordering::Relaxed), 5);
}

#[tokio::test]
async fn malformed_record_remains_pending_for_retry() {
    let directory = tempfile::tempdir().unwrap();
    let store = TranscriptStore::new(directory.path().to_path_buf());
    let records = store
        .thread_dir("user", "thread")
        .join("command-logs/sessions");
    tokio::fs::create_dir_all(&records).await.unwrap();
    let path = records.join(format!("{}.json", uuid::Uuid::new_v4()));
    tokio::fs::write(&path, b"interrupted write").await.unwrap();
    let auth = NativeAuthManager::configured_for_test(
        crate::native_auth::NativeAuthConfig {
            workos_client_id: "test".into(),
        },
        "http://localhost/callback".into(),
    );
    let registry = ThreadCommandSessions::default();
    assert!(
        !sync_directory(
            &store,
            &registry,
            &auth,
            "http://localhost",
            "machine",
            &mut IdleSessions::new(),
        )
        .await
        .unwrap()
    );
    assert_eq!(tokio::fs::read(&path).await.unwrap(), b"interrupted write");
    assert!(!path.with_extension("synced").exists());
}

#[tokio::test]
async fn log_batches_resume_in_order_without_changing_retry_bytes() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("output.log");
    let bytes: Vec<u8> = (0..CHUNK_BYTES * 5 + 17).map(|index| index as u8).collect();
    tokio::fs::write(&path, &bytes).await.unwrap();
    let path = path.to_str().unwrap();
    let mut downloaded = bytes[..23].to_vec();

    while downloaded.len() < bytes.len() {
        let offset = downloaded.len() as u64;
        let chunks = log_chunks(path, offset).await.unwrap();
        assert_eq!(chunks, log_chunks(path, offset).await.unwrap());
        assert!(!chunks.is_empty());
        assert!(chunks.len() <= 2);

        for chunk in chunks {
            let Value::Object(mut chunk) = chunk else {
                panic!("expected a log chunk");
            };
            assert_eq!(
                chunk.remove("offset"),
                Some(Value::Float64(downloaded.len() as f64))
            );
            let Some(Value::Bytes(chunk)) = chunk.remove("bytes") else {
                panic!("expected log bytes");
            };
            assert!(!chunk.is_empty());
            assert!(chunk.len() <= CHUNK_BYTES);
            downloaded.extend(chunk);
        }
    }

    assert_eq!(downloaded, bytes);
    assert!(
        log_chunks(path, bytes.len() as u64)
            .await
            .unwrap()
            .is_empty()
    );
}
