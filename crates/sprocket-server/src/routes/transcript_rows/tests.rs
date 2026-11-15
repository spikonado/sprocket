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

fn prompt(number: u32, run: &str) -> TranscriptPart {
    serde_json::from_value(json!({
        "number":number, "sourceKey":format!("prompt:{run}"), "runId":run, "kind":"prompt",
        "prompt":{"text":"prompt", "imageUploads":[]}
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
async fn pages_start_with_the_newest_run_then_split_large_runs() {
    let (state, _root) = state().await;
    let store = &state.host.transcript;
    let parts = (0..450)
        .map(|number| {
            let run = if number < 20 { "old" } else { "new" };
            if number == 0 || number == 20 {
                prompt(number, run)
            } else {
                completion(number, run, &format!("source:{number}"))
            }
        })
        .collect::<Vec<_>>();
    store.append_parts("user", "thread", &parts).await.unwrap();
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
        .append_parts("user", "thread", &[part])
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

fn remote_parts(start: u32, end: u32) -> Vec<TranscriptPart> {
    (start..end)
        .rev()
        .map(|number| completion(number, "run", &format!("source:{number}")))
        .collect()
}

#[tokio::test]
async fn empty_cache_loads_the_first_available_window_and_keeps_its_boundary() {
    let (state, _root) = state().await;
    let store = &state.host.transcript;
    let empty = load_store_window(
        store,
        "user",
        "thread",
        &ProjectionScope::Thread,
        None,
        None,
        |_, _| async { panic!("empty cache must not query Convex") },
    )
    .await
    .unwrap();
    assert_eq!(empty.window, 0..0);
    store
        .append_parts("user", "thread", &remote_parts(400, 450))
        .await
        .unwrap();
    let mut fetched = Vec::new();
    let newest = load_store_window(
        store,
        "user",
        "thread",
        &ProjectionScope::Thread,
        None,
        None,
        |start, end| {
            fetched.push(start..end);
            async move { Ok(remote_parts(start, end)) }
        },
    )
    .await
    .unwrap();
    assert_eq!(newest.window, 250..450);
    assert_eq!(newest.next_before, Some(250));
    assert_eq!(newest.parts.len(), 200);
    assert!(
        fetched
            .iter()
            .all(|range| range.start >= 250 && range.end <= 400)
    );
    store
        .append_parts("user", "thread", &remote_parts(0, 100))
        .await
        .unwrap();
    let reloaded = load_store_window(
        store,
        "user",
        "thread",
        &ProjectionScope::Thread,
        None,
        Some(newest.window.start),
        |_, _| async { panic!("loaded window must stay anchored") },
    )
    .await
    .unwrap();
    assert_eq!(reloaded.window, 250..450);
}

#[tokio::test]
async fn cursors_above_cache_highwater_fill_gaps_before_advancing_and_return_download_errors() {
    let (state, _root) = state().await;
    let store = &state.host.transcript;
    store
        .append_parts("user", "thread", &remote_parts(60, 65))
        .await
        .unwrap();
    let failed = load_store_window(
        store,
        "user",
        "thread",
        &ProjectionScope::Thread,
        Some(250),
        None,
        |_, _| async { anyhow::bail!("offline") },
    )
    .await;
    assert!(failed.err().unwrap().to_string().contains("offline"));
    let mut fetched = Vec::new();
    let older = load_store_window(
        store,
        "user",
        "thread",
        &ProjectionScope::Thread,
        Some(250),
        None,
        |start, end| {
            fetched.push(start..end);
            async move { Ok(remote_parts(start, end)) }
        },
    )
    .await
    .unwrap();
    assert_eq!(older.window, 50..250);
    assert_eq!(older.next_before, Some(50));
    assert_eq!(
        older
            .parts
            .iter()
            .map(|part| part.number)
            .collect::<Vec<_>>(),
        (50..250).collect::<Vec<_>>()
    );
    assert!(!fetched.is_empty());
    assert!(
        fetched
            .iter()
            .all(|range| !(60..65).any(|number| range.contains(&number)))
    );
}

fn reasoning(number: u32) -> TranscriptPart {
    serde_json::from_value(json!({
        "number":number, "sourceKey":format!("source:{number}"), "runId":"run", "kind":"completion",
        "completion":{"items":[{"type":"reasoning", "text":format!("thinking {number}")}]}
    }))
    .unwrap()
}

#[tokio::test]
async fn prefix_downloads_keep_the_original_work_block_id() {
    let (state, _root) = state().await;
    let store = &state.host.transcript;
    store
        .append_parts("user", "thread", &[reasoning(449)])
        .await
        .unwrap();
    let failed = load_store_window(
        store,
        "user",
        "thread",
        &ProjectionScope::Thread,
        None,
        None,
        |start, end| async move {
            anyhow::ensure!(start >= 250, "context unavailable");
            Ok((start..end).rev().map(reasoning).collect())
        },
    )
    .await;
    assert!(
        failed
            .err()
            .unwrap()
            .to_string()
            .contains("context unavailable")
    );
    let mut fetched = Vec::new();
    let saved = load_store_window(
        store,
        "user",
        "thread",
        &ProjectionScope::Thread,
        None,
        None,
        |start, end| {
            fetched.push(start..end);
            async move { Ok((start..end).rev().map(reasoning).collect()) }
        },
    )
    .await
    .unwrap();
    assert_eq!(saved.window, 250..450);
    assert_eq!(saved.parts.len(), 450);
    assert!(fetched.iter().any(|range| range.start == 0));
    let before = project_window(
        &state,
        "user",
        "thread",
        &ProjectionScope::Thread,
        &saved,
        &[],
    )
    .await;
    assert_eq!(before.rows[0].id, "work:run:source:0:0");
    let again = load_store_window(
        store,
        "user",
        "thread",
        &ProjectionScope::Thread,
        None,
        Some(saved.window.start),
        |_, _| async { panic!("prefix is cached") },
    )
    .await
    .unwrap();
    let after = project_window(
        &state,
        "user",
        "thread",
        &ProjectionScope::Thread,
        &again,
        &[],
    )
    .await;
    assert_eq!(before, after);
}

#[tokio::test]
async fn explicit_work_requests_fill_gaps_and_include_interleaved_parts_after_the_cached_span() {
    let (state, _root) = state().await;
    let store = &state.host.transcript;
    let part = |number| {
        if number == 19 {
            prompt(number, "run")
        } else if (20..280).contains(&number) || number == 290 {
            reasoning(number)
        } else {
            completion(number, "other", &format!("source:{number}"))
        }
    };
    store
        .append_parts("user", "thread", &[part(80), part(200), part(300)])
        .await
        .unwrap();
    let scope = ProjectionScope::Work("work:run:source:20:0".into());
    let saved = load_store_window(store, "user", "thread", &scope, None, None, |start, end| {
        let parts = (start..end).rev().map(part).collect();
        async move { Ok(parts) }
    })
    .await
    .unwrap();
    assert_eq!(saved.window, 20..291);
    let projected = project_window(&state, "user", "thread", &scope, &saved, &[]).await;
    assert_eq!(projected.rows.len(), 261);
    assert_eq!(projected.rows[0].id, "reasoning:run:source:20:0");
    assert_eq!(projected.rows[260].id, "reasoning:run:source:290:0");
}

#[tokio::test]
async fn interleaved_thread_blocks_each_get_their_own_canonical_prefix() {
    let (state, _root) = state().await;
    let store = &state.host.transcript;
    let part = |number| {
        let run = if number % 2 == 0 { "run" } else { "other" };
        if number < 2 {
            prompt(number, run)
        } else if number == 161 {
            completion(number, run, &format!("source:{number}"))
        } else {
            let mut part = reasoning(number);
            part.run_id = run.into();
            part
        }
    };
    store
        .append_parts("user", "thread", &[part(449)])
        .await
        .unwrap();
    let saved = load_store_window(
        store,
        "user",
        "thread",
        &ProjectionScope::Thread,
        None,
        None,
        |start, end| async move { Ok((start..end).rev().map(part).collect()) },
    )
    .await
    .unwrap();
    assert_eq!(saved.window, 250..450);
    assert_eq!(saved.next_before, Some(250));
    assert_eq!(saved.parts[0].number, 0);
    assert_eq!(
        saved
            .parts
            .iter()
            .find(|part| part.run_id == "other")
            .unwrap()
            .number,
        161
    );
    let projected = project_window(
        &state,
        "user",
        "thread",
        &ProjectionScope::Thread,
        &saved,
        &[],
    )
    .await;
    assert_eq!(
        projected
            .rows
            .iter()
            .map(|row| row.id.as_str())
            .collect::<Vec<_>>(),
        ["work:run:source:2:0", "work:other:source:163:0"]
    );
    let reloaded = load_store_window(
        store,
        "user",
        "thread",
        &ProjectionScope::Thread,
        None,
        Some(saved.window.start),
        |_, _| async { panic!("canonical context is cached") },
    )
    .await
    .unwrap();
    let after = project_window(
        &state,
        "user",
        "thread",
        &ProjectionScope::Thread,
        &reloaded,
        &[],
    )
    .await;
    assert_eq!(projected, after);
}

#[tokio::test]
async fn item_details_keep_only_the_source_and_matching_result() {
    let (state, _root) = state().await;
    let store = &state.host.transcript;
    let call = serde_json::from_value(json!({
        "number":20, "sourceKey":"call", "runId":"run", "kind":"completion",
        "completion":{"items":[{"type":"tool-call", "name":"read_file", "callId":"call",
            "toolInvocationId":"invocation", "input":{"path":"file.txt"}}]}
    }))
    .unwrap();
    let result = serde_json::from_value(json!({
        "number":250, "sourceKey":"tool:invocation:finished", "runId":"run", "kind":"tool",
        "tool":{"toolInvocationId":"invocation", "status":"completed", "output":{"content":"contents"}}
    })).unwrap();
    store
        .append_parts(
            "user",
            "thread",
            &[reasoning(10), call, result, completion(400, "run", "tail")],
        )
        .await
        .unwrap();
    for (scope, expected) in [
        (
            ProjectionScope::Item("reasoning:run:source:10:0".into()),
            vec![10],
        ),
        (
            ProjectionScope::Item("tool:run:call:0".into()),
            vec![20, 250],
        ),
    ] {
        let saved = load_store_window(store, "user", "thread", &scope, None, None, |_, _| async {
            panic!("cached item details must not download unrelated history")
        })
        .await
        .unwrap();
        assert_eq!(
            saved
                .parts
                .iter()
                .map(|part| part.number)
                .collect::<Vec<_>>(),
            expected
        );
        assert_eq!(
            project_window(&state, "user", "thread", &scope, &saved, &[])
                .await
                .rows
                .len(),
            1
        );
    }
}

#[tokio::test]
async fn closed_work_details_stop_at_the_block_and_keep_legacy_results() {
    let (state, _root) = state().await;
    let store = &state.host.transcript;
    let part = |number| {
        if number == 20 {
            serde_json::from_value(json!({
                "number":20, "sourceKey":"call", "runId":"run", "kind":"completion",
                "completion":{"items":[{"type":"tool-call", "name":"read_file", "callId":"legacy", "input":{"path":"file.txt"}}]}
            })).unwrap()
        } else if number == 230 {
            serde_json::from_value(json!({
                "number":230, "sourceKey":"legacy-result", "runId":"run", "kind":"tool",
                "tool":{"callId":"legacy", "status":"completed", "output":{"content":"contents"}}
            }))
            .unwrap()
        } else {
            completion(number, "run", &format!("source:{number}"))
        }
    };
    store
        .append_parts("user", "thread", &[part(20), part(400)])
        .await
        .unwrap();
    let scope = ProjectionScope::Work("work:run:call:0".into());
    let saved = load_store_window(store, "user", "thread", &scope, None, None, |start, end| {
        let page = (start..end).rev().map(part).collect();
        async move { Ok(page) }
    })
    .await
    .unwrap();
    assert_eq!(
        saved
            .parts
            .iter()
            .map(|part| part.number)
            .collect::<Vec<_>>(),
        vec![20, 21, 230]
    );
    let projected = project_window(&state, "user", "thread", &scope, &saved, &[]).await;
    assert!(
        matches!(&projected.rows[0].body, TranscriptRowBody::Tool { display, .. } if display.status == sprocket_transcript::tool_display::ToolStatus::Completed)
    );
    let item_scope = ProjectionScope::Item("tool:run:call:0".into());
    let item = load_store_window(
        store,
        "user",
        "thread",
        &item_scope,
        None,
        None,
        |_, _| async { panic!("legacy result is cached") },
    )
    .await
    .unwrap();
    assert_eq!(
        item.parts
            .iter()
            .map(|part| part.number)
            .collect::<Vec<_>>(),
        vec![20, 230]
    );
}

#[tokio::test]
async fn grouped_historical_orphan_details_keep_each_tool_and_its_action() {
    let (state, _root) = state().await;
    let store = &state.host.transcript;
    let result = serde_json::from_value(json!({
        "number":20, "sourceKey":"legacy-result", "runId":"run", "kind":"tool",
        "tool":{"callId":"legacy", "name":"parse_file", "input":{"path":"file.txt"},
            "status":"completed", "output":{"source":{"path":"file.txt"}}}
    }))
    .unwrap();
    let second = serde_json::from_value(json!({
        "number":21, "sourceKey":"second-result", "runId":"run", "kind":"tool",
        "tool":{"callId":"second", "name":"parse_file", "input":{"path":"second.txt"},
            "status":"completed", "output":{"source":{"path":"second.txt"}}}
    }))
    .unwrap();
    store
        .append_parts(
            "user",
            "thread",
            &[
                result,
                second,
                completion(22, "run", "closing"),
                completion(400, "run", "tail"),
            ],
        )
        .await
        .unwrap();
    for (scope, expected_parts, expected_paths) in [
        (
            ProjectionScope::Work("work:run:legacy-result:0".into()),
            vec![20, 21, 22],
            vec!["file.txt", "second.txt"],
        ),
        (
            ProjectionScope::Item("tool:run:legacy-result:0".into()),
            vec![20],
            vec!["file.txt"],
        ),
    ] {
        let saved = load_store_window(store, "user", "thread", &scope, None, None, |_, _| async {
            panic!("orphan details must not download unrelated history")
        })
        .await
        .unwrap();
        assert_eq!(
            saved
                .parts
                .iter()
                .map(|part| part.number)
                .collect::<Vec<_>>(),
            expected_parts
        );
        let snapshot = project_window(&state, "user", "thread", &scope, &saved, &[]).await;
        assert_eq!(snapshot.rows.len(), expected_paths.len());
        for (row, path) in snapshot.rows.iter().zip(expected_paths) {
            assert!(matches!(&row.body, TranscriptRowBody::Tool { display, .. }
                if display.status == sprocket_transcript::tool_display::ToolStatus::Completed
                && display.action == Some(sprocket_transcript::tool_display::ToolDisplayAction::OpenFile { path: path.into() })));
        }
    }
}

#[tokio::test]
async fn legacy_details_find_results_numbered_before_the_call() {
    let (state, _root) = state().await;
    let store = &state.host.transcript;
    let part = |number| {
        match number {
        0 => {
            serde_json::from_value(json!({
                "number":0, "sourceKey":"early-result", "runId":"run", "kind":"tool",
                "tool":{"callId":"legacy", "name":"parse_file", "status":"completed",
                    "output":{"source":{"path":"saved.txt"}}}
            }))
            .unwrap()
        }
        1 => {
            serde_json::from_value(json!({
                "number":1, "sourceKey":"call", "runId":"run", "kind":"completion",
                "completion":{"items":[{"type":"tool-call", "name":"parse_file", "callId":"legacy", "input":{"path":"saved.txt"}}]}
            }))
            .unwrap()
        }
        _ => completion(number, "run", "closing"),
    }
    };
    store
        .append_parts("user", "thread", &[part(1), part(2)])
        .await
        .unwrap();
    for scope in [
        ProjectionScope::Work("work:run:call:0".into()),
        ProjectionScope::Item("tool:run:call:0".into()),
    ] {
        let saved = load_store_window(store, "user", "thread", &scope, None, None, |start, end| {
            let page = (start..end).rev().map(part).collect();
            async move { Ok(page) }
        })
        .await
        .unwrap();
        assert_eq!(
            saved
                .parts
                .iter()
                .map(|part| part.number)
                .collect::<Vec<_>>(),
            if matches!(scope, ProjectionScope::Work(_)) {
                vec![0, 1, 2]
            } else {
                vec![0, 1]
            }
        );
        let snapshot = project_window(&state, "user", "thread", &scope, &saved, &[]).await;
        assert_eq!(snapshot.rows.len(), 1);
        assert!(
            matches!(&snapshot.rows[0].body, TranscriptRowBody::Tool { display, .. }
            if display.status == sprocket_transcript::tool_display::ToolStatus::Completed
            && display.action == Some(sprocket_transcript::tool_display::ToolDisplayAction::OpenFile { path: "saved.txt".into() }))
        );
    }
}

#[tokio::test]
async fn unanswered_details_do_not_download_history_before_the_run() {
    let (state, _root) = state().await;
    let store = &state.host.transcript;
    for invocation in [Some("current"), None] {
        let thread = invocation.unwrap_or("legacy");
        let call = serde_json::from_value(json!({
            "number":350, "sourceKey":"call", "runId":"run", "kind":"completion",
            "completion":{"items":[{"type":"tool-call", "name":"read_file", "callId":"call",
                "toolInvocationId":invocation, "input":{"path":"file.txt"}}]}
        }))
        .unwrap();
        let mut parts = vec![completion(0, "older", "older")];
        if invocation.is_none() {
            parts.push(prompt(300, "run"));
            parts.extend(
                (301..350).map(|number| completion(number, "run", &format!("source:{number}"))),
            );
        }
        parts.push(call);
        store.append_parts("user", thread, &parts).await.unwrap();
        for scope in [
            ProjectionScope::Work("work:run:call:0".into()),
            ProjectionScope::Item("tool:run:call:0".into()),
        ] {
            let saved =
                load_store_window(store, "user", thread, &scope, None, None, |_, _| async {
                    panic!("unanswered details must not wait for history before their run")
                })
                .await
                .unwrap();
            assert_eq!(
                saved
                    .parts
                    .iter()
                    .map(|part| part.number)
                    .collect::<Vec<_>>(),
                vec![350]
            );
            let snapshot = project_window(&state, "user", thread, &scope, &saved, &[]).await;
            assert!(
                matches!(&snapshot.rows[0].body, TranscriptRowBody::Tool { display, .. }
                if display.status == sprocket_transcript::tool_display::ToolStatus::Running)
            );
        }
    }
}

#[tokio::test]
async fn visible_tool_results_keep_the_call_context_before_closing_text() {
    let (state, _root) = state().await;
    let store = &state.host.transcript;
    let part = |number| {
        if number == 9 {
            prompt(number, "run")
        } else if number == 10 {
            serde_json::from_value(json!({
                "number":number, "sourceKey":format!("source:{number}"), "runId":"run", "kind":"completion",
                "completion":{"items":[{
                    "type":"tool-call", "name":"exec_cmd", "toolInvocationId":"call", "input":{"cmd":"echo done"}
                }]}
            }))
            .unwrap()
        } else if number == 350 {
            serde_json::from_value(json!({
                "number":number, "sourceKey":format!("source:{number}"), "runId":"run", "kind":"tool",
                "tool":{"toolInvocationId":"call", "status":"completed", "output":{"output":"done"}}
            }))
            .unwrap()
        } else {
            completion(
                number,
                if number < 9 { "other" } else { "run" },
                &format!("source:{number}"),
            )
        }
    };
    let cached = (250..450).map(part).collect::<Vec<_>>();
    store.append_parts("user", "thread", &cached).await.unwrap();
    let saved = load_store_window(
        store,
        "user",
        "thread",
        &ProjectionScope::Thread,
        None,
        None,
        |start, end| async move { Ok((start..end).rev().map(part).collect()) },
    )
    .await
    .unwrap();
    assert_eq!(saved.window, 250..450);
    assert_eq!(saved.parts[0].number, 9);
    let projected = project_window(
        &state,
        "user",
        "thread",
        &ProjectionScope::Thread,
        &saved,
        &[],
    )
    .await;
    assert_eq!(projected.rows[0].id, "work:run:source:10:0");
    assert_eq!(
        projected.rows[0].body,
        TranscriptRowBody::Work {
            tool_counts: [("exec_cmd".into(), 1)].into(),
            running: false,
        }
    );
}

#[tokio::test]
async fn hidden_continuation_runs_keep_the_previous_visible_history() {
    let (state, _root) = state().await;
    let hidden = serde_json::from_value(json!({
        "number":1, "sourceKey":"continuation", "runId":"new", "kind":"prompt",
        "prompt":{"text":"Continue working", "hidden":"continuation", "imageUploads":[]}
    }))
    .unwrap();
    state
        .host
        .transcript
        .append_parts("user", "thread", &[completion(0, "old", "answer"), hidden])
        .await
        .unwrap();
    let snapshot = project(&state, "user", "thread", ProjectionScope::Thread, None)
        .await
        .unwrap();
    assert_eq!(snapshot.rows.len(), 1);
    assert_eq!(snapshot.rows[0].text(), Some("part 0"));
}
