use serde_json::json;
use sprocket_transcript::rows::TranscriptRowBody;

use super::*;

fn text(id: &str, value: &str) -> TranscriptRow {
    TranscriptRow {
        id: id.into(),
        run_id: "run".into(),
        body: TranscriptRowBody::Text {
            text: value.into(),
            running: true,
        },
    }
}

fn snapshot(rows: Vec<TranscriptRow>) -> TranscriptSnapshot {
    TranscriptSnapshot {
        rows,
        next_before: None,
        stale: false,
    }
}

#[test]
fn appends_use_javascript_utf16_offsets_and_metadata_changes_replace_rows() {
    let before = snapshot(vec![text("row", "a😀")]);
    let mut after = snapshot(vec![text("row", "a😀more")]);
    assert_eq!(
        serde_json::to_value(diff(&before, &after).unwrap()).unwrap(),
        json!({
            "type":"batch", "updates":[{"type":"append", "rowId":"row", "offset":3, "text":"more"}]
        })
    );
    after.rows[0].body = TranscriptRowBody::Text {
        text: "a😀more".into(),
        running: false,
    };
    assert!(
        matches!(diff(&before, &after), Some(TranscriptRowsEvent::Batch { updates })
        if matches!(updates[0], TranscriptRowUpdate::Row { .. }))
    );
}

#[test]
fn inserted_removed_and_reordered_rows_replace_the_subscription_window() {
    let before = snapshot(vec![text("one", "first"), text("two", "second")]);
    for rows in [
        vec![text("one", "first")],
        vec![text("two", "second"), text("one", "first")],
        vec![
            text("older", "old"),
            text("one", "first"),
            text("two", "second"),
        ],
    ] {
        let after = snapshot(rows);
        assert_eq!(
            diff(&before, &after),
            Some(TranscriptRowsEvent::Snapshot { snapshot: after })
        );
    }
    let after = snapshot(vec![
        text("one", "first"),
        text("two", "second"),
        text("three", "new"),
    ]);
    assert!(
        matches!(diff(&before, &after), Some(TranscriptRowsEvent::Batch { updates }) if updates.len() == 1)
    );
    assert_eq!(diff(&before, &before), None);
}

fn live(stream: &str) -> LiveCompletionOverlay {
    serde_json::from_value(json!({
        "threadId":"thread", "runId":"run", "runStatus":"running", "streamId":stream, "text":"hello",
        "parts":[{"type":"text", "id":format!("{stream}:text:0"), "text":"hello", "completedAt":10}]
    })).unwrap()
}

fn completion(number: u32, run: &str, source: &str) -> TranscriptPart {
    serde_json::from_value(json!({
        "number":number, "sourceKey":source, "runId":run, "kind":"completion",
        "completion":{"items":[{"type":"text", "text":format!("part {number}")}]}
    }))
    .unwrap()
}

#[test]
fn live_clear_keeps_unsaved_parts_and_saved_active_parts_keep_run_status() {
    let mut window = LiveWindow::default();
    window.update(LiveCompletionWatchEvent::Updated {
        live: live("stream"),
    });
    let saved = completion(0, "run", "completion:run:stream");
    window.remove_saved(std::slice::from_ref(&saved));
    assert_eq!(window.overlays.len(), 1);
    window.update(LiveCompletionWatchEvent::Cleared);
    window.remove_saved(&[]);
    assert_eq!(window.overlays.len(), 1);
    window.remove_saved(&[saved]);
    assert!(window.overlays.is_empty());
}

#[test]
fn retry_replaces_the_cleared_attempt_and_completed_attempts_drop_after_saving() {
    let mut window = LiveWindow::default();
    window.update(LiveCompletionWatchEvent::Updated {
        live: live("attempt1"),
    });
    window.update(LiveCompletionWatchEvent::Cleared);
    window.update(LiveCompletionWatchEvent::Updated {
        live: live("attempt2"),
    });
    assert_eq!(window.overlays.len(), 1);
    assert_eq!(window.overlays[0].stream_id, "attempt2");
    window.update(LiveCompletionWatchEvent::Updated {
        live: live("attempt3"),
    });
    window.remove_saved(&[completion(0, "run", "completion:run:attempt2")]);
    assert_eq!(window.overlays.len(), 1);
    assert_eq!(window.overlays[0].stream_id, "attempt3");
}

#[test]
fn retries_keep_earlier_completed_attempts_until_saved_and_new_runs_keep_the_last_reply() {
    let mut window = LiveWindow::default();
    window.update(LiveCompletionWatchEvent::Updated {
        live: live("completed"),
    });
    window.update(LiveCompletionWatchEvent::Updated {
        live: live("retry"),
    });
    window.update(LiveCompletionWatchEvent::Cleared);
    window.update(LiveCompletionWatchEvent::Updated { live: live("next") });
    assert_eq!(
        window
            .overlays
            .iter()
            .map(|live| live.stream_id.as_str())
            .collect::<Vec<_>>(),
        ["completed", "next"]
    );
    window.update(LiveCompletionWatchEvent::Cleared);
    let mut next_run = live("new-run");
    next_run.run_id = "another-run".into();
    window.update(LiveCompletionWatchEvent::Updated { live: next_run });
    assert_eq!(window.overlays.len(), 3);
    window.remove_saved(&[
        completion(0, "run", "completion:run:completed"),
        completion(1, "run", "completion:run:next"),
    ]);
    assert_eq!(window.overlays.len(), 1);
}

async fn state() -> (AppState, tempfile::TempDir) {
    let root = tempfile::tempdir().unwrap();
    let auth = crate::auth::AuthState::load(root.path()).unwrap();
    let native_auth = sprocket_host::native_auth::NativeAuthManager::configured_for_test(
        sprocket_host::native_auth::NativeAuthConfig {
            workos_client_id: "client_test".into(),
        },
        crate::auth::desktop_login_callback_url(7731),
    );
    (
        AppState::for_test(
            auth,
            native_auth,
            root.path().to_owned(),
            true,
            sprocket_host::package_update::PackageUpdateManager::disabled(),
        ),
        root,
    )
}

#[tokio::test]
async fn lagged_live_watch_resubscribes_at_the_latest_snapshot() {
    let (state, _root) = state().await;
    let session = state.host.transcript_watchers.open("user", "thread").await;
    let hub = &state.host.live_completions;
    let subscription = hub.subscribe("thread");
    let saved = load_window(
        &state,
        "user",
        "thread",
        &ProjectionScope::Thread,
        None,
        None,
    )
    .await
    .unwrap();
    for _ in 0..100 {
        hub.publish(live("buffered"));
    }
    hub.publish(live("latest"));
    let watch = Watch {
        state,
        user: "user".into(),
        thread: "thread".into(),
        scope: ProjectionScope::Thread,
        session,
        live_events: subscription.receiver,
        saved,
        window_start: None,
        live: LiveWindow::default(),
        previous: snapshot(Vec::new()),
        next_send: Instant::now() + UPDATE_INTERVAL,
    };
    let (_, watch) = tokio::time::timeout(Duration::from_secs(5), next_event(watch))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        watch
            .live
            .overlays
            .iter()
            .map(|live| live.stream_id.as_str())
            .collect::<Vec<_>>(),
        ["latest"]
    );
    assert!(watch.live_events.is_empty());
}

#[tokio::test]
async fn pages_start_with_the_newest_run_then_split_large_runs_and_ignore_model_context_floor() {
    let (state, _root) = state().await;
    let store = &state.host.transcript;
    store
        .update_state("user", "thread", |state| {
            state.remote_total_parts = 450;
            state.history_from_number = 440;
        })
        .await
        .unwrap();
    store
        .with_work_replica("user", "thread", |replica| {
            let parts = (0..450)
                .map(|number| {
                    completion(
                        number,
                        if number < 20 { "old" } else { "new" },
                        &format!("source:{number}"),
                    )
                })
                .collect::<Vec<_>>();
            replica.save_parts("thread", &parts)
        })
        .await
        .unwrap();
    let newest = load_window(
        &state,
        "user",
        "thread",
        &ProjectionScope::Thread,
        None,
        None,
    )
    .await
    .unwrap();
    assert_eq!(newest.window, 250..450);
    assert_eq!(newest.next_before, Some(250));
    let older = load_window(
        &state,
        "user",
        "thread",
        &ProjectionScope::Thread,
        Some(250),
        None,
    )
    .await
    .unwrap();
    assert_eq!(older.window, 50..250);
    let rest = load_window(
        &state,
        "user",
        "thread",
        &ProjectionScope::Thread,
        Some(50),
        None,
    )
    .await
    .unwrap();
    assert_eq!(rest.window, 20..50);
    let oldest = load_window(
        &state,
        "user",
        "thread",
        &ProjectionScope::Thread,
        Some(20),
        None,
    )
    .await
    .unwrap();
    assert_eq!(oldest.window, 0..20);
    assert_eq!(oldest.next_before, None);
    let loaded = load_window(
        &state,
        "user",
        "thread",
        &ProjectionScope::Thread,
        None,
        Some(20),
    )
    .await
    .unwrap();
    assert_eq!(loaded.window, 20..450);
}

#[tokio::test]
async fn row_repair_returns_full_reasoning_and_unknown_rows_are_empty() {
    let (state, _root) = state().await;
    let part: TranscriptPart = serde_json::from_value(json!({
        "number":0, "sourceKey":"source", "runId":"run", "kind":"completion",
        "completion":{"items":[{"type":"reasoning", "text":"Plan\nFull reasoning"}]}
    }))
    .unwrap();
    state
        .host
        .transcript
        .with_work_replica("user", "thread", move |replica| {
            replica.save_parts("thread", &[part])
        })
        .await
        .unwrap();
    let repaired = project(
        &state,
        "user",
        "thread",
        ProjectionScope::Row("reasoning:run:source:0".into()),
        None,
    )
    .await
    .unwrap();
    assert_eq!(repaired.rows[0].text(), Some("Plan\nFull reasoning"));
    let missing = project(
        &state,
        "user",
        "thread",
        ProjectionScope::Row("reasoning:missing:source:0".into()),
        None,
    )
    .await
    .unwrap();
    assert!(missing.rows.is_empty());
}

#[tokio::test]
async fn hidden_continuation_runs_keep_the_previous_visible_history() {
    let (state, _root) = state().await;
    state
        .host
        .transcript
        .update_state("user", "thread", |metadata| metadata.remote_total_parts = 2)
        .await
        .unwrap();
    state
        .host
        .transcript
        .with_work_replica("user", "thread", |replica| {
            let hidden = serde_json::from_value(json!({
                "number":1, "sourceKey":"continuation", "runId":"new", "kind":"prompt",
                "prompt":{"text":"Continue working", "hidden":"continuation", "imageUploads":[]}
            }))
            .unwrap();
            replica.save_parts("thread", &[completion(0, "old", "answer"), hidden])
        })
        .await
        .unwrap();
    let snapshot = project(&state, "user", "thread", ProjectionScope::Thread, None)
        .await
        .unwrap();
    assert_eq!(snapshot.rows.len(), 1);
    assert_eq!(snapshot.rows[0].text(), Some("part 0"));
}
