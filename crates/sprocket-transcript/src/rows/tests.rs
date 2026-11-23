use std::path::PathBuf;

use serde_json::json;
use sprocket_convex::RunStatus;

use super::*;
use crate::tool_display::ToolDisplayAction;

fn completion(number: u32, source: &str, items: Vec<Value>) -> TranscriptPart {
    serde_json::from_value(json!({
        "number": number, "sourceKey": source, "kind": "completion", "runId": "run",
        "completion": { "items": items }
    }))
    .unwrap()
}

fn result(number: u32, tool: Value) -> TranscriptPart {
    serde_json::from_value(json!({
        "number": number, "sourceKey": format!("result:{number}"), "kind": "tool", "runId": "run",
        "tool": tool
    }))
    .unwrap()
}

fn overlay(items: Vec<Value>) -> LiveCompletionOverlay {
    LiveCompletionOverlay {
        thread_id: "thread".into(),
        run_id: "run".into(),
        run_status: RunStatus::Running,
        stream_id: "stream".into(),
        text: String::new(),
        parts: items
            .into_iter()
            .map(|item| serde_json::from_value(item).unwrap())
            .collect(),
    }
}

fn commands() -> SessionCommands {
    SessionCommands::new(PathBuf::from("/unused-transcript"))
}

/// Every row after folding `parts` and showing `live` on top.
fn fold(parts: &[TranscriptPart], live: &[LiveCompletionOverlay]) -> Vec<Row> {
    let mut tally = RowTally::default();
    let mut commands = commands();
    let mut rows: Vec<Row> = Vec::new();
    let mut upsert = |row: Row| match rows.iter_mut().find(|existing| existing.id == row.id) {
        Some(existing) => *existing = row,
        None => rows.push(row),
    };
    for part in parts {
        tally
            .apply(part, &mut commands)
            .into_iter()
            .for_each(&mut upsert);
    }
    let saved: HashSet<_> = parts.iter().map(|part| part.source_key.as_str()).collect();
    let live = tally.live_rows(live, |source| saved.contains(source), &mut commands);
    live.rows.into_iter().for_each(&mut upsert);
    for row in &mut rows {
        if live.streaming.contains(&row.id) {
            row.set_streaming();
        }
    }
    rows
}

fn thread(rows: &[Row]) -> Vec<TranscriptRow> {
    rows.iter()
        .filter_map(|row| row.render(RowScope::Thread))
        .collect()
}

fn work(rows: &[Row], id: &str) -> Vec<TranscriptRow> {
    rows.iter()
        .filter(|row| row.work() == Some(id))
        .filter_map(|row| row.render(RowScope::Work))
        .collect()
}

fn item(rows: &[Row], id: &str) -> TranscriptRow {
    rows.iter()
        .find(|row| row.id == id)
        .and_then(|row| row.render(RowScope::Item))
        .unwrap()
}

fn status(row: &TranscriptRow) -> ToolStatus {
    match &row.body {
        TranscriptRowBody::Tool { display, .. } => display.status,
        body => panic!("expected a tool row, got {body:?}"),
    }
}

#[test]
fn reasoning_labels_use_the_first_line_and_mark_cuts() {
    assert_eq!(reasoning_label("\n# Plan\nDetails"), "Plan");
    assert_eq!(
        reasoning_label(&format!("{} tail", "a".repeat(119))),
        format!("{}…", "a".repeat(119))
    );
}

#[test]
fn work_blocks_follow_item_order_across_parts() {
    let rows = fold(
        &[
            completion(
                0,
                "first",
                vec![
                    json!({"type":"reasoning", "text":" \n"}),
                    json!({"type":"text", "text":"before"}),
                    json!({"type":"reasoning", "text":"thinking"}),
                ],
            ),
            completion(
                2,
                "second",
                vec![
                    json!({"type":"text", "text":"\t"}),
                    json!({"type":"tool-call", "callId":"call", "name":"read_file"}),
                    json!({"type":"text", "text":"answer"}),
                    json!({"type":"reasoning", "text":"next"}),
                ],
            ),
            completion(3, "third", vec![json!({"type":"reasoning", "text":"more"})]),
        ],
        &[],
    );
    let ids: Vec<_> = thread(&rows).into_iter().map(|row| row.id).collect();
    assert_eq!(
        ids,
        [
            "text:run:first:1",
            "work:run:first:2",
            "text:run:second:2",
            "work:run:second:3"
        ]
    );
    assert_eq!(
        work(&rows, "work:run:first:2")
            .into_iter()
            .map(|row| row.id)
            .collect::<Vec<_>>(),
        ["reasoning:run:first:2", "tool:run:second:1"]
    );
    assert!(matches!(
        thread(&rows)[1].body,
        TranscriptRowBody::Work { running: false, ref tool_counts } if tool_counts["read_file"] == 1
    ));
    assert!(matches!(
        thread(&rows)[3].body,
        TranscriptRowBody::Work { running: true, .. }
    ));
    assert_eq!(work(&rows, "work:run:second:3").len(), 2);
}

#[test]
fn a_new_run_keeps_the_previous_runs_rows_and_turns_its_waiting_results_into_rows() {
    let mut parts = vec![
        completion(0, "a", vec![json!({"type":"reasoning", "text":"thinking"})]),
        result(
            1,
            json!({"callId":"lost", "name":"parse_file", "status":"completed"}),
        ),
        completion(2, "b", vec![json!({"type":"reasoning", "text":"again"})]),
    ];
    parts[2].run_id = "next".into();
    let rows = fold(&parts, &[]);
    let ids: Vec<_> = thread(&rows).into_iter().map(|row| row.id).collect();
    assert_eq!(ids, ["work:run:a:0", "work:next:b:0"]);
    assert!(matches!(
        thread(&rows)[0].body,
        TranscriptRowBody::Work { running: true, ref tool_counts } if tool_counts["parse_file"] == 1
    ));
    assert_eq!(
        status(&work(&rows, "work:run:a:0")[1]),
        ToolStatus::Completed
    );
}

#[test]
fn results_pair_with_their_calls_and_unmatched_results_stand_in_for_them() {
    let rows = fold(
        &[
            result(
                0,
                json!({"callId":"early", "name":"parse_file", "status":"completed",
                    "output":{"source":{"path":"early.txt"}}}),
            ),
            completion(
                1,
                "calls",
                vec![
                    json!({"type":"tool-call", "callId":"early", "name":"parse_file", "input":{"path":"early.txt"}}),
                    json!({"type":"tool-call", "callId":"exec", "name":"exec_command", "input":{"cmd":"build"}}),
                ],
            ),
            result(
                2,
                json!({"callId":"exec", "status":"completed", "output":{"sessionId":"7"}}),
            ),
            result(
                3,
                json!({"callId":"orphan", "name":"parse_file", "input":{"path":"saved.txt"},
                    "status":"completed", "output":{"source":{"path":"saved.txt"}}}),
            ),
        ],
        &[],
    );
    let thread = thread(&rows);
    assert_eq!(thread.len(), 1);
    let tools = work(&rows, &thread[0].id);
    assert_eq!(
        tools.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
        [
            "tool:run:calls:0",
            "tool:run:calls:1",
            "tool:run:result:3:0"
        ]
    );
    assert!(tools.iter().all(|row| status(row) == ToolStatus::Completed));
    assert!(
        matches!(&tools[2].body, TranscriptRowBody::Tool { display, .. } if display.action == Some(ToolDisplayAction::OpenFile { path: "saved.txt".into() }))
    );
    let exec = rows
        .iter()
        .find(|row| row.id == "tool:run:calls:1")
        .unwrap();
    assert_eq!(exec.parts().collect::<Vec<_>>(), [1, 2]);
}

#[test]
fn poll_rows_use_one_summary_for_previews_and_details() {
    let rows = fold(
        &[
            completion(
                0,
                "poll",
                vec![json!({
                    "type":"tool-call", "callId":"poll", "name":"poll_cmd",
                    "input":{"sessionIds":["7","missing","8"]}
                })],
            ),
            result(
                1,
                json!({"name":"poll_cmd", "callId":"poll", "status":"completed", "output":[
                    {"sessionId":"7", "command":"bun run build", "workdir":"/repo"},
                    {"sessionId":"missing", "error":"Unknown session."},
                    {"sessionId":"8", "command":"echo done"}
                ]}),
            ),
        ],
        &[],
    );
    let preview = work(&rows, "work:run:poll:0");
    let TranscriptRowBody::Tool {
        display, has_more, ..
    } = &preview[0].body
    else {
        panic!("expected multi-target tool");
    };
    assert!(*has_more);
    assert_eq!(display.summary, "bun run build");
    let details = item(&rows, &preview[0].id);
    let TranscriptRowBody::Tool {
        display, has_more, ..
    } = &details.body
    else {
        panic!("expected multi-target details");
    };
    assert!(!has_more);
    assert_eq!(
        display.summary,
        "bun run build\nSession missing: Unknown session.\necho done"
    );
    assert_eq!(display.status, ToolStatus::Completed);
    assert_eq!(display.commands, ["bun run build", "echo done"]);
}

#[test]
fn tools_only_send_display_summaries_and_item_scope_returns_the_full_summary() {
    let command = format!("{}\nsecond line", "x".repeat(350));
    let rows = fold(
        &[completion(
            0,
            "completion:run:stream",
            vec![json!({
                "type":"tool-call", "callId":"call", "toolInvocationId":"invocation", "name":"exec_cmd",
                "input":{"cmd":command, "secret":"private input"}
            })],
        )],
        &[],
    );
    let row = &work(&rows, "work:run:completion:run:stream:0")[0];
    let wire = serde_json::to_value(row).unwrap();
    assert_eq!(wire["summary"], "x".repeat(300));
    assert_eq!(wire["hasMore"], true);
    assert!(wire.get("commands").is_none());
    assert!(!wire.to_string().contains("private input"));
    let full = serde_json::to_value(item(&rows, &row.id)).unwrap();
    assert_eq!(full["summary"], command);
    assert_eq!(full["commands"], json!([command]));
}

#[test]
fn a_live_call_with_reused_provider_id_waits_for_its_own_saved_result() {
    let parts = [
        completion(
            0,
            "old",
            vec![
                json!({
                    "type":"tool-call", "callId":"reused", "toolInvocationId":"old-invocation",
                    "name":"parse_file", "input":{"path":"old.txt"}
                }),
                json!({"type":"text", "text":"done"}),
            ],
        ),
        result(
            1,
            json!({"callId":"reused", "toolInvocationId":"old-invocation", "status":"completed",
                "output":{"source":{"path":"old.txt"}}}),
        ),
    ];
    let live = overlay(vec![json!({
        "type":"tool-call", "partId":"stream:tool:0", "callId":"reused", "name":"parse_file",
        "input":{"path":"new.txt"}
    })]);
    let rows = fold(&parts, &[live]);
    let row = item(&rows, "tool:run:completion:run:stream:0");
    assert!(
        matches!(row.body, TranscriptRowBody::Tool { ref display, .. } if display.status == ToolStatus::Running && display.action.is_none())
    );
}

#[test]
fn live_and_saved_rows_keep_ids_despite_empty_items_and_live_arrival_order() {
    let reason =
        json!({"type":"reasoning", "id":"stream:reasoning:1", "text":"Plan", "completedAt":10});
    let text = json!({"type":"text", "id":"stream:text:2", "text":"Answer", "completedAt":20});
    let live = overlay(vec![text.clone(), reason.clone()]);
    let streamed = thread(&fold(&[], std::slice::from_ref(&live)));
    let saved = completion(
        7,
        &completion_source_key(&live),
        vec![
            json!({"type":"reasoning", "id":"stream:reasoning:0", "text":""}),
            reason,
            text,
        ],
    );
    let persisted = thread(&fold(&[saved], &[live]));
    assert_eq!(streamed, persisted);
    assert!(matches!(
        persisted[0].body,
        TranscriptRowBody::Work { running: false, .. }
    ));
    assert!(matches!(
        persisted[1].body,
        TranscriptRowBody::Text { running: true, .. }
    ));
    assert_eq!(
        persisted
            .iter()
            .map(|row| row.id.as_str())
            .collect::<Vec<_>>(),
        [
            "work:run:completion:run:stream:1",
            "text:run:completion:run:stream:2",
        ]
    );
}

#[test]
fn reasoning_streams_only_in_the_item_scope_and_finishes_before_the_next_tool() {
    let reason = json!({"type":"reasoning", "id":"stream:reasoning:0", "text":"# Plan\nPrivate details", "completedAt":10});
    let mut live = overlay(vec![reason]);
    let rows = fold(&[], std::slice::from_ref(&live));
    let block = &thread(&rows)[0];
    assert!(matches!(
        block.body,
        TranscriptRowBody::Work { running: true, .. }
    ));
    let items = work(&rows, &block.id);
    assert!(matches!(
        items[0].body,
        TranscriptRowBody::Reasoning {
            running: true,
            text: None,
            ref label,
        } if label == "Thinking"
    ));
    assert!(matches!(
        item(&rows, &items[0].id).body,
        TranscriptRowBody::Reasoning { text: Some(ref text), .. } if text == "# Plan\nPrivate details"
    ));
    live.parts.push(
        serde_json::from_value(json!({
            "type":"tool-call", "partId":"stream:tool:1", "callId":"call", "name":"exec_cmd",
            "input":{"cmd":"ls"}, "completedAt":20
        }))
        .unwrap(),
    );
    let items = work(&fold(&[], &[live]), &block.id);
    assert!(matches!(
        items[0].body,
        TranscriptRowBody::Reasoning {
            running: false,
            text: None,
            ref label,
        } if label == "Plan"
    ));
    assert_eq!(status(&items[1]), ToolStatus::Running);
}

#[test]
fn unresolved_saved_calls_stay_running_until_their_result() {
    let call = json!({"type":"tool-call", "partId":"stream:tool:0", "callId":"same", "name":"exec_cmd", "input":{"cmd":"ls"}, "completedAt":10});
    let live = overlay(vec![call.clone()]);
    let mut saved_call = call;
    saved_call["toolInvocationId"] = "invocation".into();
    let saved = completion(0, &completion_source_key(&live), vec![saved_call]);
    let id = "work:run:completion:run:stream:0";
    let active = fold(std::slice::from_ref(&saved), std::slice::from_ref(&live));
    assert!(matches!(
        thread(&active)[0].body,
        TranscriptRowBody::Work { running: true, .. }
    ));
    assert_eq!(status(&work(&active, id)[0]), ToolStatus::Running);
    let stopped = fold(std::slice::from_ref(&saved), &[]);
    assert_eq!(status(&work(&stopped, id)[0]), ToolStatus::Running);
    let mut done = result(
        1,
        json!({"toolInvocationId":"invocation", "status":"completed", "output":{"stdout":"private output"}}),
    );
    done.source_key = "tool:invocation:finished".into();
    let done = fold(&[saved, done], &[]);
    assert_eq!(status(&work(&done, id)[0]), ToolStatus::Completed);
}

#[test]
fn page_start_moves_to_the_newest_runs_visible_prompt() {
    let prompt = |number: u32, run: &str, hidden: Option<&str>| -> TranscriptPart {
        serde_json::from_value(json!({
            "number":number, "sourceKey":format!("prompt:{run}:{number}"), "runId":run, "kind":"prompt",
            "prompt":{"text":"prompt", "imageUploads":[], "hidden":hidden}
        }))
        .unwrap()
    };
    let mut reply = completion(3, "reply", vec![json!({"type":"text", "text":"done"})]);
    reply.run_id = "new".into();
    let page = [
        prompt(0, "old", None),
        prompt(1, "new", Some("environment")),
        prompt(2, "new", None),
        reply,
        prompt(4, "after", Some("continuation")),
    ];
    assert_eq!(page_start(&page, 0), 2);
    assert_eq!(page_start(&page[3..], 3), 3);
}
