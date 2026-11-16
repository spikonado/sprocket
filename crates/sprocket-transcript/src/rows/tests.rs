use serde_json::json;
use sprocket_convex::RunStatus;

use super::*;

#[test]
fn reasoning_labels_use_the_first_line_and_mark_cuts() {
    assert_eq!(reasoning_label("\n# Plan\nDetails"), "Plan");
    assert_eq!(
        reasoning_label(&format!("{} tail", "a".repeat(119))),
        format!("{}…", "a".repeat(119))
    );
}

#[tokio::test]
async fn legacy_calls_and_orphan_results_keep_status_and_actions() {
    let call = completion(
        0,
        "exec",
        vec![json!({
            "type":"tool-call", "callId":"exec", "name":"exec_command", "input":{"cmd":"legacy build"}
        })],
    );
    let result = |number, name: &str, call: &str, input: Value, output: Value| {
        serde_json::from_value(json!({
            "number":number, "runId":"run", "sourceKey":format!("result:{number}"), "kind":"tool",
            "tool":{"name":name, "callId":call, "input":input, "output":output, "status":"completed"}
        })).unwrap()
    };
    let parts = vec![
        call,
        result(
            1,
            "exec_command",
            "exec",
            Value::Null,
            json!({"sessionId":"7"}),
        ),
        result(
            2,
            "poll_command",
            "poll",
            json!({"sessionId":"7"}),
            json!({"output":"private"}),
        ),
        result(
            3,
            "parse_file",
            "parse",
            json!({"path":"saved.txt"}),
            json!({"source":{"path":"saved.txt"}}),
        ),
    ];
    let thread = project(parts.clone(), &[], ProjectionScope::Thread).await;
    assert_eq!(thread.len(), 1);
    let work = project(parts, &[], ProjectionScope::Work(thread[0].id.clone())).await;
    assert_eq!(work.len(), 3);
    for row in &work {
        assert!(
            matches!(row.body, TranscriptRowBody::Tool { ref display, .. } if display.status == ToolStatus::Completed)
        );
    }
    assert!(
        matches!(work[2].body, TranscriptRowBody::Tool { ref display, .. } if matches!(&display.action, Some(crate::tool_display::ToolDisplayAction::OpenFile { path }) if path == "saved.txt"))
    );
}

#[test]
fn streaming_borrows_saved_parts_instead_of_copying_tool_outputs() {
    let saved = vec![completion(
        0,
        "saved",
        vec![json!({"type":"text", "text":"saved"})],
    )];
    let (merged, _) = merge_live(
        &saved,
        &[overlay(vec![
            json!({"type":"text", "id":"stream:text:0", "text":"live"}),
        ])],
    );
    assert!(std::ptr::eq(merged[0].as_ref(), &saved[0]));
    assert!(matches!(merged[1], Cow::Owned(_)));
}

#[tokio::test]
async fn a_live_call_with_reused_provider_id_waits_for_its_own_saved_result() {
    let parts = vec![
        completion(
            0,
            "old",
            vec![
                json!({
                    "type":"tool-call", "callId":"reused", "toolInvocationId":"old-invocation", "name":"parse_file", "input":{"path":"old.txt"}
                }),
                json!({"type":"text", "text":"done"}),
            ],
        ),
        serde_json::from_value(json!({
            "number":1, "sourceKey":"old-result", "runId":"run", "kind":"tool",
            "tool":{"callId":"reused", "toolInvocationId":"old-invocation", "status":"completed",
                "output":{"source":{"path":"old.txt"}}}
        }))
        .unwrap(),
    ];
    let live = overlay(vec![json!({
        "type":"tool-call", "partId":"stream:tool:0", "callId":"reused", "name":"parse_file", "input":{"path":"new.txt"}
    })]);
    let snapshot = project(
        parts,
        &[live],
        ProjectionScope::Item("tool:run:completion:run:stream:0".into()),
    )
    .await;
    assert!(
        matches!(snapshot[0].body, TranscriptRowBody::Tool { ref display, .. } if display.status == ToolStatus::Running && display.action.is_none())
    );
}

fn completion(number: u32, source: &str, items: Vec<Value>) -> TranscriptPart {
    serde_json::from_value(json!({
        "number": number, "sourceKey": source, "kind": "completion", "runId": "run",
        "completion": { "items": items }
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

async fn project(
    parts: Vec<TranscriptPart>,
    live: &[LiveCompletionOverlay],
    scope: ProjectionScope,
) -> Vec<TranscriptRow> {
    project_rows(
        &parts,
        live,
        &scope,
        0..100,
        Path::new("/unused-transcript"),
    )
    .await
}

#[tokio::test]
async fn live_and_saved_rows_keep_ids_despite_empty_items_and_live_arrival_order() {
    let reason =
        json!({"type":"reasoning", "id":"stream:reasoning:1", "text":"Plan", "completedAt":10});
    let text = json!({"type":"text", "id":"stream:text:2", "text":"Answer", "completedAt":20});
    let live = overlay(vec![text.clone(), reason.clone()]);
    let streamed = project(
        Vec::new(),
        std::slice::from_ref(&live),
        ProjectionScope::Thread,
    )
    .await;
    let live_work_id = derive_work_blocks(
        merge_live(&[], std::slice::from_ref(&live))
            .0
            .iter()
            .map(AsRef::as_ref),
    )[0]
    .id
    .clone();
    assert_eq!(streamed[0].id, live_work_id);
    let saved = completion(
        7,
        &completion_source_key(&live),
        vec![
            json!({"type":"reasoning", "id":"stream:reasoning:0", "text":""}),
            reason,
            text,
        ],
    );
    let persisted = project(vec![saved], &[live], ProjectionScope::Thread).await;
    assert_eq!(streamed, persisted);
    assert!(matches!(
        persisted[0].body,
        TranscriptRowBody::Work { running: false, .. }
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

#[tokio::test]
async fn reasoning_streams_only_in_the_item_scope_and_finishes_before_the_next_tool() {
    let reason = json!({"type":"reasoning", "id":"stream:reasoning:0", "text":"# Plan\nPrivate details", "completedAt":10});
    let mut live = overlay(vec![reason]);
    let thread = project(
        Vec::new(),
        std::slice::from_ref(&live),
        ProjectionScope::Thread,
    )
    .await;
    assert!(matches!(
        thread[0].body,
        TranscriptRowBody::Work { running: true, .. }
    ));
    let work = project(
        Vec::new(),
        std::slice::from_ref(&live),
        ProjectionScope::Work(thread[0].id.clone()),
    )
    .await;
    assert!(matches!(
        work[0].body,
        TranscriptRowBody::Reasoning {
            running: true,
            text: None,
            ..
        }
    ));
    let item = project(
        Vec::new(),
        std::slice::from_ref(&live),
        ProjectionScope::Item(work[0].id.clone()),
    )
    .await;
    assert_eq!(item[0].text(), Some("# Plan\nPrivate details"));
    live.parts.push(
        serde_json::from_value(json!({
            "type":"tool-call", "partId":"stream:tool:1", "callId":"call", "name":"exec_cmd",
            "input":{"cmd":"ls"}, "completedAt":20
        }))
        .unwrap(),
    );
    let work = project(
        Vec::new(),
        &[live],
        ProjectionScope::Work(thread[0].id.clone()),
    )
    .await;
    assert!(matches!(
        work[0].body,
        TranscriptRowBody::Reasoning {
            running: false,
            text: None,
            ..
        }
    ));
    assert!(
        matches!(work[1].body, TranscriptRowBody::Tool { ref display, .. } if display.status == ToolStatus::Running)
    );
}

#[tokio::test]
async fn unresolved_saved_calls_stay_running_without_a_local_overlay() {
    let call = json!({"type":"tool-call", "partId":"stream:tool:0", "callId":"same", "name":"exec_cmd", "input":{"cmd":"ls"}, "completedAt":10});
    let live = overlay(vec![call.clone()]);
    let mut saved_call = call;
    saved_call["toolInvocationId"] = "invocation".into();
    let saved = completion(0, &completion_source_key(&live), vec![saved_call]);
    let thread = project(
        vec![saved.clone()],
        std::slice::from_ref(&live),
        ProjectionScope::Thread,
    )
    .await;
    assert!(matches!(
        thread[0].body,
        TranscriptRowBody::Work { running: true, .. }
    ));
    let scope = ProjectionScope::Work(thread[0].id.clone());
    let active = project(vec![saved.clone()], &[live], scope.clone()).await;
    assert!(
        matches!(active[0].body, TranscriptRowBody::Tool { ref display, .. } if display.status == ToolStatus::Running)
    );
    let stopped = project(vec![saved.clone()], &[], scope.clone()).await;
    assert!(
        matches!(stopped[0].body, TranscriptRowBody::Tool { ref display, .. } if display.status == ToolStatus::Running)
    );
    let result: TranscriptPart = serde_json::from_value(json!({
        "number":1, "sourceKey":"tool:invocation:finished", "runId":"run", "kind":"tool",
        "tool":{"toolInvocationId":"invocation", "status":"completed", "output":{"stdout":"private output"}}
    })).unwrap();
    let done = project(vec![saved, result], &[], scope).await;
    assert!(
        matches!(done[0].body, TranscriptRowBody::Tool { ref display, .. } if display.status == ToolStatus::Completed)
    );
}

#[tokio::test]
async fn tools_only_send_display_summaries_and_item_scope_returns_the_full_summary() {
    let command = format!("{}\nsecond line", "x".repeat(350));
    let saved = completion(
        0,
        "completion:run:stream",
        vec![json!({
            "type":"tool-call", "callId":"call", "toolInvocationId":"invocation", "name":"exec_cmd",
            "input":{"cmd":command, "secret":"private input"}
        })],
    );
    let work = project(
        vec![saved.clone()],
        &[],
        ProjectionScope::Work("work:run:completion:run:stream:0".into()),
    )
    .await;
    let wire = serde_json::to_value(&work[0]).unwrap();
    assert_eq!(wire["summary"], "x".repeat(300));
    assert_eq!(wire["hasMore"], true);
    assert!(!wire.to_string().contains("private input"));
    assert!(wire.get("input").is_none());
    assert!(wire.get("output").is_none());
    let item = project(vec![saved], &[], ProjectionScope::Item(work[0].id.clone())).await;
    assert_eq!(serde_json::to_value(&item[0]).unwrap()["summary"], command);
}

#[tokio::test]
async fn work_groups_continue_across_parts_and_result_only_windows_keep_the_work_row() {
    let first = completion(
        0,
        "completion:first",
        vec![json!({
            "type":"tool-call", "callId":"call", "toolInvocationId":"invocation", "name":"exec_cmd", "input":{"cmd":"ls"}
        })],
    );
    let second = completion(
        1,
        "completion:second",
        vec![json!({"type":"reasoning", "text":"Next"})],
    );
    let result = serde_json::from_value(json!({
        "number":2, "sourceKey":"tool:invocation:finished", "runId":"run", "kind":"tool",
        "tool":{"toolInvocationId":"invocation", "status":"completed"}
    }))
    .unwrap();
    let page = project_rows(
        &[first, second, result],
        &[],
        &ProjectionScope::Thread,
        2..3,
        Path::new("/unused-transcript"),
    )
    .await;
    assert_eq!(page.len(), 1);
    assert_eq!(page[0].id, "work:run:completion:first:0");
    assert!(
        matches!(page[0].body, TranscriptRowBody::Work { ref tool_counts, running: true } if tool_counts["exec_cmd"] == 1)
    );
}
