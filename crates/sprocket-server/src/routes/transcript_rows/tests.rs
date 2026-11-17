use serde_json::json;
use sprocket_transcript::TranscriptPart;
use sprocket_transcript::rows::TranscriptRowBody;
use sprocket_transcript::tool_display::ToolStatus;

use super::test_support::{completion, prompt, reasoning, state, text, tool};
use super::*;

fn ids(snapshot: &TranscriptSnapshot) -> Vec<&str> {
    snapshot.rows.iter().map(|row| row.id.as_str()).collect()
}

async fn ready(state: &AppState, parts: &[TranscriptPart]) -> ThreadRowsLease {
    state
        .host
        .transcript
        .append_parts("user", "thread", parts)
        .await
        .unwrap();
    ready_rows(state, "user", "thread").await.unwrap()
}

#[tokio::test]
async fn pages_start_with_the_newest_run_then_split_large_runs() {
    let (state, _root) = state();
    let parts: Vec<_> = (0..450)
        .map(|number| {
            let run = if number < 20 { "old" } else { "new" };
            if number == 0 || number == 20 {
                prompt(number, run, None)
            } else {
                text(number, run)
            }
        })
        .collect();
    let rows = ready(&state, &parts).await;
    let newest = page(&state, "user", "thread", None).await.unwrap();
    assert_eq!((newest.rows.len(), newest.next_before), (200, Some(250)));
    assert_eq!(newest.rows[0].id, "text:new:source:250:0");
    for (before, len, next_before) in [(250, 200, Some(50)), (50, 30, Some(20)), (20, 20, None)] {
        let older = page(&state, "user", "thread", Some(before)).await.unwrap();
        assert_eq!(
            (older.rows.len(), older.next_before),
            (len, next_before),
            "before {before}"
        );
    }
    let (loaded, ..) = open(&rows, &Request::Thread { before: Some(20) })
        .await
        .unwrap();
    assert_eq!((loaded.rows.len(), loaded.next_before), (430, Some(20)));
}

#[tokio::test]
async fn row_repair_returns_full_reasoning_and_unknown_rows_are_empty() {
    let (state, _root) = state();
    let reasoning = json!([{"type":"reasoning", "text":"Plan\nFull reasoning"}]);
    ready(&state, &[completion(0, "run", "source", reasoning)]).await;
    let repaired = row(&state, "user", "thread", "reasoning:run:source:0".into())
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(repaired.body,
        TranscriptRowBody::Reasoning { text: Some(ref text), .. } if text == "Plan\nFull reasoning"));
    let missing = row(
        &state,
        "user",
        "thread",
        "reasoning:missing:source:0".into(),
    )
    .await;
    assert_eq!(missing.unwrap(), None);
}

#[tokio::test]
async fn work_pages_show_the_newest_items_then_older_ones_on_request() {
    let (state, _root) = state();
    let mut parts = vec![prompt(0, "run", None)];
    parts.extend((1..=450).map(|number| reasoning(number, "run")));
    let rows = ready(&state, &parts).await;
    let mut before = None;
    for (len, next_before) in [(200, Some(251)), (400, Some(51)), (450, None)] {
        let work = Request::Work {
            id: "work:run:source:1:0".into(),
            before,
        };
        let (snapshot, ..) = open(&rows, &work).await.unwrap();
        assert_eq!(
            (snapshot.rows.len(), snapshot.next_before),
            (len, next_before)
        );
        assert_eq!(ids(&snapshot).last(), Some(&"reasoning:run:source:450:0"));
        before = snapshot.next_before;
    }
}

#[tokio::test]
async fn details_of_older_runs_fold_that_run_on_request() {
    let (state, _root) = state();
    let call = json!([{"type":"tool-call", "callId":"legacy", "name":"read_file", "input":{"path":"file.txt"}}]);
    let mut parts = vec![
        prompt(0, "old", None),
        reasoning(1, "old"),
        completion(2, "old", "call", call),
        tool(
            3,
            "old",
            "legacy-result",
            json!({"callId":"legacy", "status":"completed", "output":{"content":"contents"}}),
        ),
        text(4, "old"),
        prompt(5, "new", None),
    ];
    parts.extend((6..=300).map(|number| text(number, "new")));
    let rows = ready(&state, &parts).await;
    assert_eq!(rows.read(|shared| shared.start).0, 5);
    let item = Request::Item {
        id: "tool:old:call:0".into(),
    };
    let (item, ..) = open(&rows, &item).await.unwrap();
    assert!(matches!(&item.rows[..], [row] if matches!(&row.body,
        TranscriptRowBody::Tool { display, .. } if display.status == ToolStatus::Completed)));
    let work = Request::Work {
        id: "work:old:source:1:0".into(),
        before: None,
    };
    let (work, ..) = open(&rows, &work).await.unwrap();
    assert_eq!(ids(&work), ["reasoning:old:source:1:0", "tool:old:call:0"]);
}

#[tokio::test]
async fn hidden_continuation_runs_keep_the_previous_visible_history() {
    let (state, _root) = state();
    ready(
        &state,
        &[text(0, "old"), prompt(1, "new", Some("continuation"))],
    )
    .await;
    let snapshot = page(&state, "user", "thread", None).await.unwrap();
    assert_eq!(ids(&snapshot), ["text:old:source:0:0"]);
}
