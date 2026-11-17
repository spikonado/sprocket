use serde_json::json;
use sprocket_transcript::rows::{LIVE_PART, RowBody, TranscriptRow, TranscriptRowBody};
use sprocket_transcript::tool_display::ToolStatus;

use super::*;
use crate::routes::transcript_rows::test_support::{
    cached, completion, fetch, prompt, reasoning, state, text, thread_rows, tool,
};
use crate::routes::transcript_rows::{Filter, Request, TranscriptRowUpdate, open};

fn live(stream: &str) -> LiveCompletionOverlay {
    serde_json::from_value(json!({
        "threadId":"thread", "runId":"run", "runStatus":"running", "streamId":stream, "text":"hello",
        "parts":[{"type":"text", "id":format!("{stream}:text:0"), "text":"hello", "completedAt":10}]
    }))
    .unwrap()
}

#[test]
fn live_clear_keeps_unsaved_parts_and_saved_active_parts_keep_run_status() {
    let mut window = LiveWindow::default();
    window.update(LiveCompletionWatchEvent::Updated {
        live: live("stream"),
    });
    let saved = |source: &str| source == "completion:run:stream";
    window.remove_saved(saved);
    assert_eq!(window.overlays.len(), 1);
    window.update(LiveCompletionWatchEvent::Cleared);
    window.remove_saved(|_| false);
    assert_eq!(window.overlays.len(), 1);
    window.remove_saved(saved);
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
    window.remove_saved(|source| source == "completion:run:attempt2");
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
    window.remove_saved(|source| {
        ["completion:run:completed", "completion:run:next"].contains(&source)
    });
    assert_eq!(window.overlays.len(), 1);
}

#[tokio::test]
async fn lagged_live_events_resubscribe_at_the_latest_snapshot() {
    let (state, _root) = state();
    let rows = thread_rows(&state, cached());
    rows.ready(&|| {}).await.unwrap();
    let (_, mut changes) = rows.read(|_| ());
    let hub = &state.host.live_completions;
    for _ in 0..100 {
        hub.publish(live("buffered"));
    }
    hub.publish(live("latest"));
    tokio::time::timeout(Duration::from_secs(5), changes.recv())
        .await
        .unwrap()
        .unwrap();
    let ids = rows
        .read(|shared| shared.rows().map(|row| row.id.clone()).collect::<Vec<_>>())
        .0;
    assert_eq!(ids, ["text:run:completion:run:latest:0"]);
}

fn text_row(id: &str, part: u32, text: &str) -> Row {
    Row {
        id: id.into(),
        run_id: "run".into(),
        part,
        body: RowBody::Text {
            text: text.into(),
            running: false,
        },
    }
}

fn view(rows: Vec<Row>, streaming: &[&str]) -> LiveRows {
    LiveRows {
        rows,
        streaming: streaming.iter().map(|id| (*id).to_owned()).collect(),
    }
}

#[test]
fn streaming_text_appends_at_utf16_offsets_and_other_changes_replace_rows() {
    let mut shared = Shared::default();
    shared.replace(0, 0, vec![text_row("saved", 0, "saved")]);
    let added = shared.update(
        Vec::new(),
        view(vec![text_row("live", LIVE_PART, "h😀")], &["live"]),
        false,
    );
    assert!(
        matches!(added, Some(Change::Rows(updates)) if matches!(&updates[..],
        [Update::Added(row)] if row.id == "live" && row.body == RowBody::Text { text: "h😀".into(), running: true }))
    );
    let appended = shared.update(
        Vec::new(),
        view(vec![text_row("live", LIVE_PART, "h😀 there")], &["live"]),
        false,
    );
    assert!(
        matches!(appended, Some(Change::Rows(updates)) if matches!(&updates[..],
        [Update::Append { id, offset: 3, text }] if id == "live" && text == " there"))
    );
    let saved = shared.update(
        vec![text_row("live", 1, "h😀 there")],
        LiveRows::default(),
        false,
    );
    assert!(
        matches!(saved, Some(Change::Rows(updates)) if matches!(&updates[..],
        [Update::Changed(row)] if row.body == RowBody::Text { text: "h😀 there".into(), running: false }))
    );
    assert_eq!(
        shared
            .update(Vec::new(), LiveRows::default(), false)
            .map(|_| ()),
        None
    );
}

#[test]
fn rows_that_vanish_or_land_before_live_rows_reset_watchers() {
    let mut shared = Shared::default();
    let attempt = || view(vec![text_row("retry", LIVE_PART, "again")], &[]);
    shared.update(
        Vec::new(),
        view(vec![text_row("first", LIVE_PART, "try")], &[]),
        false,
    );
    assert!(matches!(
        shared.update(Vec::new(), attempt(), false),
        Some(Change::Reset)
    ));
    assert!(matches!(
        shared.update(vec![text_row("saved", 1, "first")], attempt(), false),
        Some(Change::Reset)
    ));
    assert!(matches!(
        shared.update(Vec::new(), attempt(), true),
        Some(Change::Reset)
    ));
    assert_eq!(
        shared.rows().map(|row| row.id.clone()).collect::<Vec<_>>(),
        ["saved", "retry"]
    );
}

#[tokio::test]
async fn the_newest_page_folds_from_its_runs_origin() {
    let (state, _root) = state();
    let store = &state.host.transcript;
    store
        .append_parts("user", "thread", &[reasoning(449, "run")])
        .await
        .unwrap();
    let unavailable = thread_rows(
        &state,
        fetch(|number| {
            anyhow::ensure!(number >= 250, "context unavailable");
            Ok(reasoning(number, "run"))
        }),
    );
    let error = unavailable.ready(&|| {}).await.unwrap_err();
    assert!(format!("{error:#}").contains("context unavailable"));
    let rows = thread_rows(&state, fetch(|number| Ok(reasoning(number, "run"))));
    rows.ready(&|| {}).await.unwrap();
    let thread = Request::Thread { before: None };
    let (snapshot, ..) = open(&rows, &thread).await.unwrap();
    assert_eq!(
        rows.read(|shared| (shared.start, shared.newest)).0,
        (0, 250)
    );
    assert_eq!(snapshot.next_before, Some(250));
    assert_eq!(
        snapshot
            .rows
            .iter()
            .map(|row| row.id.as_str())
            .collect::<Vec<_>>(),
        ["work:run:source:0:0"]
    );
    let again = thread_rows(&state, cached());
    again.ready(&|| {}).await.unwrap();
    assert_eq!(open(&again, &thread).await.unwrap().0, snapshot);
}

#[tokio::test]
async fn a_wide_gap_rebuilds_from_the_newest_page_and_resets_watchers() {
    let (state, _root) = state();
    let store = &state.host.transcript;
    let old: Vec<_> = (0..450).map(|number| text(number, "run")).collect();
    store.append_parts("user", "thread", &old).await.unwrap();
    let rows = thread_rows(
        &state,
        fetch(|number| {
            assert!(
                number >= 750,
                "the gap before the newest page stays missing"
            );
            Ok(text(number, "next"))
        }),
    );
    rows.ready(&|| {}).await.unwrap();
    let (_, mut changes) = rows.read(|_| ());
    let mut newest = vec![prompt(900, "next", None)];
    newest.extend((901..950).map(|number| text(number, "next")));
    store.append_parts("user", "thread", &newest).await.unwrap();
    let mut folder = rows.folder.lock().await;
    rows.refresh(&mut folder, &mut LiveWindow::default(), true, false)
        .await
        .unwrap();
    assert!(matches!(*changes.try_recv().unwrap(), Change::Reset));
    assert_eq!(
        rows.read(|shared| (shared.start, shared.newest)).0,
        (900, 900)
    );
}

#[tokio::test]
async fn hidden_continuation_runs_fold_only_their_own_run() {
    let (state, _root) = state();
    let mut parts = vec![prompt(300, "new", Some("continuation"))];
    parts.extend((301..550).map(|number| reasoning(number, "new")));
    state
        .host
        .transcript
        .append_parts("user", "thread", &parts)
        .await
        .unwrap();
    let rows = thread_rows(
        &state,
        fetch(|number| {
            assert!(number >= 200, "continuations must not wait for older runs");
            Ok(text(number, "old"))
        }),
    );
    rows.ready(&|| {}).await.unwrap();
    assert_eq!(
        rows.read(|shared| (shared.start, shared.newest)).0,
        (300, 350)
    );
}

/// A watch applied the way the web client applies it.
struct Browser {
    rows: Vec<TranscriptRow>,
    filter: Filter,
    changes: broadcast::Receiver<Arc<Change>>,
    resets: usize,
}

impl Browser {
    async fn watch(rows: &ThreadRowsLease, request: Request) -> Self {
        let (snapshot, filter, changes) = open(rows, &request).await.unwrap();
        Self {
            rows: snapshot.rows,
            filter,
            changes,
            resets: 0,
        }
    }

    async fn catch_up(&mut self, rows: &ThreadRowsLease) {
        while let Ok(change) = self.changes.try_recv() {
            match &*change {
                Change::Reset => {
                    let resets = self.resets + 1;
                    *self = Self::watch(rows, self.filter.request.clone()).await;
                    self.resets = resets;
                }
                Change::Rows(updates) => {
                    for update in self.filter.apply(updates) {
                        self.apply(update);
                    }
                }
            }
        }
    }

    fn apply(&mut self, update: TranscriptRowUpdate) {
        match update {
            TranscriptRowUpdate::Row { row } => {
                match self.rows.iter_mut().find(|known| known.id == row.id) {
                    Some(known) => *known = row,
                    None => self.rows.push(row),
                }
            }
            TranscriptRowUpdate::Append {
                row_id,
                offset,
                text,
            } => {
                let row = self.rows.iter_mut().find(|row| row.id == row_id).unwrap();
                let (TranscriptRowBody::Text { text: shown, .. }
                | TranscriptRowBody::Reasoning {
                    text: Some(shown), ..
                }) = &mut row.body
                else {
                    panic!("{row_id} has no text to append to");
                };
                assert_eq!(shown.encode_utf16().count(), offset);
                shown.push_str(&text);
            }
        }
    }
}

enum Step {
    Save(Vec<TranscriptPart>),
    Live(LiveCompletionWatchEvent),
}

fn overlay(stream: &str, status: &str, parts: serde_json::Value) -> Step {
    Step::Live(LiveCompletionWatchEvent::Updated {
        live: serde_json::from_value(json!({
            "threadId":"thread", "runId":"b", "runStatus":status, "streamId":stream, "text":"",
            "parts":parts
        }))
        .unwrap(),
    })
}

fn steps() -> Vec<Step> {
    let thinking = |text: &str| json!({"type":"reasoning", "id":"s1:reasoning:0", "text":text});
    let live_call = json!({"type":"tool-call", "partId":"s1:tool:1", "callId":"call-b",
        "name":"exec_cmd", "input":{"cmd":"ls"}});
    let mut saved_call = live_call.clone();
    saved_call["toolInvocationId"] = "inv-b".into();
    let answer = |stream: &str, text: &str| json!([{"type":"text", "id":format!("{stream}:text:0"), "text":text}]);
    vec![
        Step::Save(vec![prompt(0, "a", None)]),
        Step::Save(vec![completion(
            1,
            "a",
            "c1",
            json!([
                {"type":"reasoning", "text":"Plan A"},
                {"type":"tool-call", "callId":"call-1", "toolInvocationId":"inv-1", "name":"read_file",
                    "input":{"path":"a.txt"}}
            ]),
        )]),
        Step::Save(vec![tool(
            2,
            "a",
            "tool:inv-1:finished",
            json!({"toolInvocationId":"inv-1",
            "callId":"call-1", "name":"read_file", "status":"completed", "output":{"content":"a"}}),
        )]),
        // Older agents saved some results just before their call.
        Step::Save(vec![
            tool(
                3,
                "a",
                "legacy-result",
                json!({"callId":"legacy", "name":"parse_file",
                "status":"completed", "output":{"source":{"path":"early.txt"}}}),
            ),
            completion(
                4,
                "a",
                "c4",
                json!([
                    {"type":"tool-call", "callId":"legacy", "name":"parse_file", "input":{"path":"early.txt"}},
                    {"type":"text", "text":"Done with A"}
                ]),
            ),
        ]),
        Step::Save(vec![tool(
            5,
            "a",
            "orphan-result",
            json!({"callId":"orphan", "name":"parse_file",
            "input":{"path":"saved.txt"}, "status":"completed", "output":{"source":{"path":"saved.txt"}}}),
        )]),
        Step::Save(vec![prompt(6, "b", Some("continuation"))]),
        overlay("s1", "running", json!([thinking("Thinking")])),
        overlay("s1", "running", json!([thinking("Thinking about B 😀")])),
        overlay(
            "s1",
            "running",
            json!([thinking("Thinking about B 😀"), live_call]),
        ),
        Step::Save(vec![completion(
            7,
            "b",
            "completion:b:s1",
            json!([thinking("Thinking about B 😀"), saved_call]),
        )]),
        Step::Save(vec![tool(
            8,
            "b",
            "tool:inv-b:finished",
            json!({"toolInvocationId":"inv-b",
            "callId":"call-b", "status":"completed", "output":{"output":"done"}}),
        )]),
        overlay("s2", "running", answer("s2", "Partial")),
        Step::Live(LiveCompletionWatchEvent::Cleared),
        overlay("s3", "running", answer("s3", "Final answer")),
        Step::Save(vec![completion(
            9,
            "b",
            "completion:b:s3",
            answer("s3", "Final answer"),
        )]),
        Step::Live(LiveCompletionWatchEvent::Cleared),
    ]
}

/// What rows built from scratch show for `request`.
async fn fresh(state: &AppState, live: &LiveWindow, request: &Request) -> Vec<TranscriptRow> {
    let rows = thread_rows(state, cached());
    let mut live = LiveWindow {
        overlays: live.overlays.clone(),
        ..LiveWindow::default()
    };
    let mut folder = rows.folder.lock().await;
    rows.build(&mut folder, &|| {}).await.unwrap();
    rows.refresh(&mut folder, &mut live, false, false)
        .await
        .unwrap();
    drop(folder);
    open(&rows, request).await.unwrap().0.rows
}

#[tokio::test]
async fn watched_rows_match_a_fresh_snapshot_after_every_change() {
    let (state, _root) = state();
    let rows = thread_rows(&state, cached());
    let mut live = LiveWindow::default();
    rows.build(&mut *rows.folder.lock().await, &|| {})
        .await
        .unwrap();
    let mut browsers = Vec::new();
    for request in [
        Request::Thread { before: None },
        Request::Work {
            id: "work:a:c1:0".into(),
            before: None,
        },
        Request::Work {
            id: "work:b:completion:b:s1:0".into(),
            before: None,
        },
        Request::Item {
            id: "reasoning:b:completion:b:s1:0".into(),
        },
        Request::Item {
            id: "tool:a:c4:0".into(),
        },
    ] {
        browsers.push(Browser::watch(&rows, request).await);
    }
    for (index, step) in steps().into_iter().enumerate() {
        let read_saved = match step {
            Step::Save(parts) => {
                state
                    .host
                    .transcript
                    .append_parts("user", "thread", &parts)
                    .await
                    .unwrap();
                true
            }
            Step::Live(event) => {
                live.update(event);
                false
            }
        };
        let mut folder = rows.folder.lock().await;
        rows.refresh(&mut folder, &mut live, read_saved, false)
            .await
            .unwrap();
        drop(folder);
        for browser in &mut browsers {
            browser.catch_up(&rows).await;
            let request = &browser.filter.request;
            let expected = open(&rows, request).await.unwrap().0.rows;
            assert_eq!(browser.rows, expected, "step {index}: {request:?}");
            let rebuilt = fresh(&state, &live, request).await;
            assert_eq!(browser.rows, rebuilt, "step {index}: {request:?}");
        }
    }
    let ids = |browser: &Browser| -> Vec<String> {
        browser.rows.iter().map(|row| row.id.clone()).collect()
    };
    assert_eq!(
        ids(&browsers[0]),
        [
            "prompt:a:prompt:a:0:0",
            "work:a:c1:0",
            "text:a:c4:1",
            "work:a:orphan-result:0",
            "work:b:completion:b:s1:0",
            "text:b:completion:b:s3:0",
        ]
    );
    assert_eq!(
        ids(&browsers[1]),
        ["reasoning:a:c1:0", "tool:a:c1:1", "tool:a:c4:0"]
    );
    assert_eq!(
        ids(&browsers[2]),
        ["reasoning:b:completion:b:s1:0", "tool:b:completion:b:s1:1"]
    );
    assert!(matches!(&browsers[4].rows[0].body,
        TranscriptRowBody::Tool { display, .. } if display.status == ToolStatus::Completed));
    assert!(
        browsers.iter().all(|browser| browser.resets == 1),
        "only the retry moves rows"
    );
}
