use serde_json::json;

use super::*;
use crate::transcript::types::{TranscriptPart, TranscriptPartKind, TranscriptToolBody};

fn prompt_part(number: u32, text: &str) -> TranscriptPart {
    serde_json::from_value(json!({
        "number": number,
        "sourceKey": format!("prompt:{number}"),
        "kind": "prompt",
        "runId": "run",
        "prompt": { "text": text, "imageUploads": [] }
    }))
    .unwrap()
}

fn completion_part(number: u32, items: Vec<JsonValue>) -> TranscriptPart {
    serde_json::from_value(json!({
        "number": number,
        "sourceKey": format!("completion:run:{number}"),
        "kind": "completion",
        "runId": "run",
        "completion": { "streamId": number.to_string(), "items": items }
    }))
    .unwrap()
}

fn tool_part(
    number: u32,
    invocation: Option<&str>,
    call_id: &str,
    name: &str,
    status: &str,
    output: Option<JsonValue>,
) -> TranscriptPart {
    tool_part_in_run(number, "run", invocation, call_id, name, status, output)
}

#[allow(clippy::too_many_arguments)]
fn tool_part_in_run(
    number: u32,
    run: &str,
    invocation: Option<&str>,
    call_id: &str,
    name: &str,
    status: &str,
    output: Option<JsonValue>,
) -> TranscriptPart {
    TranscriptPart {
        number,
        source_key: format!("tool:{}:{status}:{number}", invocation.unwrap_or(call_id)),
        kind: TranscriptPartKind::Tool,
        run_id: run.into(),
        created_at: Some(u64::from(number) * 10),
        prompt: None,
        completion: None,
        tool: Some(TranscriptToolBody {
            job_id: None,
            tool_invocation_id: invocation.map(str::to_owned),
            call_id: call_id.into(),
            name: name.into(),
            output,
            status: status.into(),
        }),
        work: Default::default(),
    }
}

fn completion_part_in_run(number: u32, run: &str, items: Vec<JsonValue>) -> TranscriptPart {
    let mut part = completion_part(number, items);
    part.run_id = run.into();
    part.source_key = format!("completion:{run}:{number}");
    part
}

fn patch_call_item(call_id: &str) -> JsonValue {
    json!({
        "type": "tool-call",
        "callId": call_id,
        "name": "apply_patch",
        "input": { "patch": "*** Begin Patch\n*** End Patch" }
    })
}

fn open_replica() -> (tempfile::TempDir, WorkReplica) {
    let dir = tempfile::tempdir().unwrap();
    let replica = WorkReplica::open(dir.path().to_owned()).unwrap();
    (dir, replica)
}

fn page(
    replica: &WorkReplica,
    cursor: Option<&str>,
    max_chars: usize,
) -> anyhow::Result<MonitorPage> {
    read_page(
        replica,
        "thread",
        cursor.map(parse_cursor).transpose()?,
        max_chars,
    )
}

fn collect_all(
    replica: &WorkReplica,
    mut current: MonitorPage,
    max_chars: usize,
) -> Vec<MonitorEntry> {
    let mut entries = Vec::new();
    for _ in 0..64 {
        let cost: usize = current
            .entries
            .iter()
            .map(|entry| match entry {
                MonitorEntry::Prompt { text, .. } | MonitorEntry::Text { text, .. } => {
                    text.chars().count()
                }
                MonitorEntry::Patch { changes, .. } => changes.iter().map(patch_change_cost).sum(),
            })
            .sum();
        assert!(cost <= max_chars, "monitor page exceeded the char budget");
        entries.append(&mut current.entries);
        if !current.has_more {
            return entries;
        }
        current = page(replica, Some(&current.next_cursor), max_chars).unwrap();
    }
    panic!("monitor paging did not terminate");
}

fn texts(entries: &[MonitorEntry]) -> Vec<&str> {
    entries
        .iter()
        .map(|entry| match entry {
            MonitorEntry::Prompt { text, .. } | MonitorEntry::Text { text, .. } => text.as_str(),
            MonitorEntry::Patch { .. } => "<patch>",
        })
        .collect()
}

#[test]
fn first_prompt_and_canonical_ordering_with_patch_sources() {
    let (_dir, mut replica) = open_replica();
    replica
        .save_parts(
            "thread",
            &[
                prompt_part(0, "first task"),
                completion_part(
                    1,
                    vec![
                        json!({"type":"reasoning","text":"secret chain of thought"}),
                        json!({"type":"text","text":"working on it","startedAt":10.0,"completedAt":11.0}),
                        patch_call_item("c1"),
                        json!({"type":"text","text":"done","startedAt":20.0,"completedAt":21.0}),
                    ],
                ),
                tool_part(
                    2,
                    Some("inv-1"),
                    "c1",
                    "apply_patch",
                    "completed",
                    Some(json!({"changes":[
                        {"operation":"renamed","path":"new.txt","source":"old.txt"},
                        {"operation":"copied","path":"b.txt","source":"a.txt"},
                        {"operation":"updated","path":"c.txt"}
                    ]})),
                ),
                prompt_part(3, "second task"),
            ],
        )
        .unwrap();

    let page = page(&replica, None, MONITOR_PAGE_CHAR_LIMIT).unwrap();
    assert!(!page.has_more);
    let kinds: Vec<&str> = page
        .entries
        .iter()
        .map(|entry| match entry {
            MonitorEntry::Prompt { .. } => "prompt",
            MonitorEntry::Text { .. } => "text",
            MonitorEntry::Patch { .. } => "patch",
        })
        .collect();
    assert_eq!(kinds, ["prompt", "text", "patch", "text", "prompt"]);
    let MonitorEntry::Prompt { id, text } = &page.entries[0] else {
        panic!()
    };
    assert_eq!(id, "prompt-0");
    assert_eq!(text, "first task");
    let MonitorEntry::Patch { ok, changes, .. } = &page.entries[2] else {
        panic!()
    };
    assert!(ok);
    assert_eq!(changes.len(), 3);
    assert_eq!(changes[0].operation, "renamed");
    assert_eq!(changes[0].path, "new.txt");
    assert_eq!(changes[0].source_path.as_deref(), Some("old.txt"));
    assert_eq!(changes[1].source_path.as_deref(), Some("a.txt"));
    assert_eq!(changes[2].source_path, None);
}

#[test]
fn excludes_reasoning_other_tools_patch_inputs_and_started_events() {
    let (_dir, mut replica) = open_replica();
    replica
        .save_parts(
            "thread",
            &[
                completion_part(
                    0,
                    vec![
                        json!({"type":"reasoning","text":"do not leak"}),
                        json!({"type":"tool-call","callId":"r1","name":"read_file","input":{"path":"x"}}),
                        patch_call_item("c1"),
                    ],
                ),
                tool_part(1, Some("inv-r"), "r1", "read_file", "completed", Some(json!({"content":"file body"}))),
                tool_part(2, Some("inv-c"), "c1", "apply_patch", "started", None),
            ],
        )
        .unwrap();
    let page = page(&replica, None, MONITOR_PAGE_CHAR_LIMIT).unwrap();
    assert!(page.entries.is_empty(), "only a started patch exists");
    assert!(!page.has_more);
    let wire = serde_json::to_value(&page).unwrap();
    assert_eq!(wire["entries"], json!([]));
    assert!(!wire.to_string().contains("Begin Patch"));
}

#[test]
fn failed_patch_reports_failure_without_claiming_changes() {
    let (_dir, mut replica) = open_replica();
    replica
        .save_parts(
            "thread",
            &[
                completion_part(0, vec![patch_call_item("c1")]),
                tool_part(
                    1,
                    Some("inv-c"),
                    "c1",
                    "apply_patch",
                    "failed",
                    Some(json!({"error":"failed to parse","status":"failed"})),
                ),
            ],
        )
        .unwrap();
    let page = page(&replica, None, MONITOR_PAGE_CHAR_LIMIT).unwrap();
    assert_eq!(page.entries.len(), 1);
    let MonitorEntry::Patch { ok, changes, .. } = &page.entries[0] else {
        panic!()
    };
    assert!(!ok);
    assert!(changes.is_empty());
}

#[test]
fn legacy_patch_results_without_source_paths_stay_sourceless() {
    let (_dir, mut replica) = open_replica();
    replica
        .save_parts(
            "thread",
            &[
                completion_part(0, vec![patch_call_item("c1")]),
                tool_part(
                    1,
                    Some("inv-c"),
                    "c1",
                    "apply_patch",
                    "completed",
                    Some(json!({"changes":[{"operation":"renamed","path":"new.txt"}]})),
                ),
            ],
        )
        .unwrap();
    let page = page(&replica, None, MONITOR_PAGE_CHAR_LIMIT).unwrap();
    let MonitorEntry::Patch { ok, changes, .. } = &page.entries[0] else {
        panic!()
    };
    assert!(ok);
    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0].source_path, None);
    assert!(
        serde_json::to_value(&changes[0])
            .unwrap()
            .get("sourcePath")
            .is_none()
    );
}

#[test]
fn late_patch_completion_blocks_until_result_lands() {
    let (_dir, mut replica) = open_replica();
    replica
        .save_parts(
            "thread",
            &[
                completion_part(0, vec![patch_call_item("c1")]),
                tool_part(1, Some("inv-c"), "c1", "apply_patch", "started", None),
                completion_part(
                    2,
                    vec![json!({"type":"reasoning","text":"excluded but advances coverage"})],
                ),
                prompt_part(3, "later prompt"),
            ],
        )
        .unwrap();

    let first = page(&replica, None, MONITOR_PAGE_CHAR_LIMIT).unwrap();
    assert!(
        first.entries.is_empty(),
        "unfinished patch pins the boundary"
    );
    assert!(!first.has_more);

    replica
        .save_parts(
            "thread",
            &[tool_part(
                4,
                Some("inv-r"),
                "r1",
                "read_file",
                "completed",
                Some(json!({"content":"noise"})),
            )],
        )
        .unwrap();
    let second = page(&replica, Some(&first.next_cursor), MONITOR_PAGE_CHAR_LIMIT).unwrap();
    assert!(second.entries.is_empty());
    assert!(!second.has_more);

    replica
        .save_parts(
            "thread",
            &[tool_part(
                5,
                Some("inv-c"),
                "c1",
                "apply_patch",
                "completed",
                Some(json!({"changes":[{"operation":"created","path":"made.txt"}]})),
            )],
        )
        .unwrap();
    let third = page(&replica, Some(&second.next_cursor), MONITOR_PAGE_CHAR_LIMIT).unwrap();
    let kinds: Vec<&str> = third
        .entries
        .iter()
        .map(|entry| match entry {
            MonitorEntry::Patch { .. } => "patch",
            MonitorEntry::Prompt { .. } => "prompt",
            MonitorEntry::Text { .. } => "text",
        })
        .collect();
    assert_eq!(kinds, ["patch", "prompt"]);
    let MonitorEntry::Patch { id, changes, .. } = &third.entries[0] else {
        panic!()
    };
    // Canonical call sequence (part 0, item 0), not the result event part.
    assert_eq!(id, "patch-0");
    assert_eq!(changes[0].path, "made.txt");
    let fourth = page(&replica, Some(&third.next_cursor), MONITOR_PAGE_CHAR_LIMIT).unwrap();
    assert!(fourth.entries.is_empty());
    assert!(!fourth.has_more);
}

#[test]
fn patch_result_pairs_by_canonical_identity_without_started_event() {
    // No `started` event: the result arrives first/only, and the call first
    // appears when its completion part is downloaded.
    let (_dir, mut replica) = open_replica();
    replica
        .save_parts(
            "thread",
            &[
                tool_part(
                    0,
                    Some("inv-c"),
                    "c1",
                    "apply_patch",
                    "completed",
                    Some(json!({"changes":[{"operation":"deleted","path":"gone.txt"}]})),
                ),
                completion_part(1, vec![patch_call_item("c1")]),
            ],
        )
        .unwrap();
    let page = page(&replica, None, MONITOR_PAGE_CHAR_LIMIT).unwrap();
    assert_eq!(page.entries.len(), 1);
    let MonitorEntry::Patch { id, ok, changes } = &page.entries[0] else {
        panic!()
    };
    // Projects at the call's canonical position (part 1, item 0).
    assert_eq!(id, &format!("patch-{}", POSITION_STRIDE));
    assert!(ok);
    assert_eq!(changes[0].operation, "deleted");
}

#[test]
fn reused_call_ids_pair_within_their_own_run() {
    let (_dir, mut replica) = open_replica();
    replica
        .save_parts(
            "thread",
            &[
                completion_part_in_run(0, "run-a", vec![patch_call_item("dup")]),
                tool_part_in_run(
                    1,
                    "run-a",
                    Some("inv-a"),
                    "dup",
                    "apply_patch",
                    "completed",
                    Some(json!({"changes":[{"operation":"created","path":"a.txt"}]})),
                ),
                completion_part_in_run(2, "run-b", vec![patch_call_item("dup")]),
                tool_part_in_run(
                    3,
                    "run-b",
                    Some("inv-b"),
                    "dup",
                    "apply_patch",
                    "started",
                    None,
                ),
            ],
        )
        .unwrap();
    let page = page(&replica, None, MONITOR_PAGE_CHAR_LIMIT).unwrap();
    assert_eq!(page.entries.len(), 1, "run-b's patch is still running");
    let MonitorEntry::Patch { id, changes, .. } = &page.entries[0] else {
        panic!()
    };
    assert_eq!(id, "patch-0");
    assert_eq!(changes[0].path, "a.txt");
    assert!(!page.has_more);
}

#[test]
fn invocation_assignments_disambiguate_reused_call_ids_in_one_run() {
    let (_dir, mut replica) = open_replica();
    let mut first = completion_part(0, vec![patch_call_item("dup")]);
    first
        .work
        .tool_invocations
        .push(crate::transcript::types::WorkInvocation {
            item: 0,
            tool_invocation_id: "inv-a".into(),
        });
    let mut second = completion_part(2, vec![patch_call_item("dup")]);
    second
        .work
        .tool_invocations
        .push(crate::transcript::types::WorkInvocation {
            item: 0,
            tool_invocation_id: "inv-b".into(),
        });
    replica
        .save_parts(
            "thread",
            &[
                first,
                tool_part(
                    1,
                    Some("inv-a"),
                    "dup",
                    "apply_patch",
                    "completed",
                    Some(json!({"changes":[{"operation":"created","path":"a.txt"}]})),
                ),
                second,
                tool_part(
                    3,
                    Some("inv-b"),
                    "dup",
                    "apply_patch",
                    "completed",
                    Some(json!({"changes":[{"operation":"created","path":"b.txt"}]})),
                ),
            ],
        )
        .unwrap();
    let result = page(&replica, None, 1000).unwrap();
    let paths: Vec<_> = result
        .entries
        .iter()
        .map(|entry| {
            let MonitorEntry::Patch { changes, .. } = entry else {
                panic!()
            };
            changes[0].path.as_str()
        })
        .collect();
    assert_eq!(paths, ["a.txt", "b.txt"]);
    assert!(!result.has_more);
}

#[test]
fn committed_completion_text_does_not_require_optional_timing() {
    let (_dir, mut replica) = open_replica();
    replica
        .save_parts(
            "thread",
            &[completion_part(
                0,
                vec![
                    json!({"type":"text","text":"without timing"}),
                    json!({"type":"text","text":"committed","startedAt":10.0,"completedAt":12.0}),
                ],
            )],
        )
        .unwrap();
    let first = page(&replica, None, MONITOR_PAGE_CHAR_LIMIT).unwrap();
    assert_eq!(texts(&first.entries), ["without timing", "committed"]);
    assert!(!first.has_more);
}

#[test]
fn tool_only_patch_events_use_one_stable_source_position() {
    let (_dir, mut replica) = open_replica();
    replica
        .save_parts(
            "thread",
            &[
                tool_part(0, Some("inv-c"), "c1", "apply_patch", "started", None),
                tool_part(
                    1,
                    Some("inv-c"),
                    "c1",
                    "apply_patch",
                    "completed",
                    Some(json!({"changes":[{"operation":"updated","path":"a.txt"}]})),
                ),
                prompt_part(2, "next"),
            ],
        )
        .unwrap();
    let first = page(&replica, None, 1000).unwrap();
    assert_eq!(first.entries.len(), 2);
    let MonitorEntry::Patch { id, ok, changes } = &first.entries[0] else {
        panic!()
    };
    assert_eq!(id, "patch-0");
    assert!(*ok);
    assert_eq!(changes[0].path, "a.txt");
    let next = page(&replica, Some(&first.next_cursor), 1000).unwrap();
    assert!(next.entries.is_empty());
    assert!(!next.has_more);
}

#[test]
fn late_canonical_call_does_not_repeat_an_observed_tool_only_result() {
    let (_dir, mut replica) = open_replica();
    replica
        .save_parts(
            "thread",
            &[tool_part(
                0,
                Some("inv-c"),
                "c1",
                "apply_patch",
                "completed",
                Some(json!({"changes":[{"operation":"updated","path":"a.txt"}]})),
            )],
        )
        .unwrap();
    let first = page(&replica, None, 1000).unwrap();
    assert_eq!(first.entries.len(), 1);
    replica
        .save_parts(
            "thread",
            &[
                completion_part(1, vec![patch_call_item("c1")]),
                prompt_part(2, "tail"),
            ],
        )
        .unwrap();
    let second = page(&replica, Some(&first.next_cursor), 1000).unwrap();
    assert_eq!(texts(&second.entries), ["tail"]);
    assert!(!second.has_more);
    let fresh = page(&replica, None, 1000).unwrap();
    assert_eq!(fresh.entries.len(), 2);
}

#[test]
fn patch_result_beyond_a_download_gap_waits_for_contiguous_coverage() {
    let (_dir, mut replica) = open_replica();
    replica
        .save_parts(
            "thread",
            &[
                completion_part(0, vec![patch_call_item("c1")]),
                tool_part(
                    2,
                    Some("inv-c"),
                    "c1",
                    "apply_patch",
                    "completed",
                    Some(json!({"changes":[{"operation":"updated","path":"a.txt"}]})),
                ),
            ],
        )
        .unwrap();
    let first = page(&replica, None, 1000).unwrap();
    assert!(first.entries.is_empty());
    replica
        .save_parts("thread", &[prompt_part(1, "middle")])
        .unwrap();
    let second = page(&replica, Some(&first.next_cursor), 1000).unwrap();
    assert_eq!(second.entries.len(), 2);
    assert!(matches!(second.entries[0], MonitorEntry::Patch { .. }));
    assert_eq!(texts(&second.entries)[1], "middle");
    assert!(!second.has_more);
}

#[test]
fn paged_tool_only_patch_resumes_after_its_canonical_call_arrives() {
    let (_dir, mut replica) = open_replica();
    let changes: Vec<JsonValue> = (0..20)
        .map(|index| json!({"operation":"updated","path":format!("file-{index}.txt")}))
        .collect();
    replica
        .save_parts(
            "thread",
            &[tool_part(
                0,
                Some("inv-c"),
                "c1",
                "apply_patch",
                "completed",
                Some(json!({"changes": changes})),
            )],
        )
        .unwrap();
    let first = page(&replica, None, 30).unwrap();
    assert!(first.has_more);
    replica
        .save_parts(
            "thread",
            &[
                completion_part(1, vec![patch_call_item("c1")]),
                prompt_part(2, "tail"),
            ],
        )
        .unwrap();
    let entries = collect_all(&replica, first, 30);
    let paths: Vec<_> = entries
        .iter()
        .flat_map(|entry| match entry {
            MonitorEntry::Patch { changes, .. } => {
                changes.iter().map(|change| change.path.clone()).collect()
            }
            _ => Vec::new(),
        })
        .collect();
    assert_eq!(
        paths,
        (0..20)
            .map(|index| format!("file-{index}.txt"))
            .collect::<Vec<_>>()
    );
    let text_entries: Vec<_> = entries
        .iter()
        .filter_map(|entry| match entry {
            MonitorEntry::Prompt { text, .. } | MonitorEntry::Text { text, .. } => {
                Some(text.as_str())
            }
            MonitorEntry::Patch { .. } => None,
        })
        .collect();
    assert_eq!(text_entries, ["tail"]);
}

#[test]
fn full_page_defers_the_next_entry_without_empty_fragments() {
    let (_dir, mut replica) = open_replica();
    replica
        .save_parts("thread", &[prompt_part(0, "12345"), prompt_part(1, "tail")])
        .unwrap();
    let first = page(&replica, None, 5).unwrap();
    assert_eq!(texts(&first.entries), ["12345"]);
    assert!(first.has_more);
    let second = page(&replica, Some(&first.next_cursor), 5).unwrap();
    assert_eq!(texts(&second.entries), ["tail"]);
    assert!(!second.has_more);
}

#[test]
fn patch_paths_are_kept_whole_when_text_uses_the_page_budget() {
    let (_dir, mut replica) = open_replica();
    replica
        .save_parts(
            "thread",
            &[
                prompt_part(0, "123"),
                completion_part(1, vec![patch_call_item("c1")]),
                tool_part(
                    2,
                    Some("inv-c"),
                    "c1",
                    "apply_patch",
                    "completed",
                    Some(json!({"changes":[{"operation":"renamed","path":"new","source":"old"}]})),
                ),
            ],
        )
        .unwrap();
    let first = page(&replica, None, 8).unwrap();
    assert_eq!(texts(&first.entries), ["123"]);
    assert!(first.has_more);
    let second = page(&replica, Some(&first.next_cursor), 8).unwrap();
    let [MonitorEntry::Patch { ok, changes, .. }] = second.entries.as_slice() else {
        panic!()
    };
    assert!(ok);
    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0].path, "new");
    assert_eq!(changes[0].source_path.as_deref(), Some("old"));
    assert!(!second.has_more);
}

#[test]
fn multiple_oversized_entries_page_in_order_without_loss() {
    let (_dir, mut replica) = open_replica();
    let first_text: String = "a".repeat(600);
    let second_text: String = "b".repeat(600);
    replica
        .save_parts(
            "thread",
            &[
                prompt_part(0, &first_text),
                completion_part(
                    1,
                    vec![json!({"type":"text","text":second_text,"completedAt":5.0})],
                ),
                prompt_part(2, "tail"),
            ],
        )
        .unwrap();

    let entries = collect_all(&replica, page(&replica, None, 500).unwrap(), 500);
    let kinds: Vec<&str> = entries
        .iter()
        .map(|entry| match entry {
            MonitorEntry::Prompt { .. } => "prompt",
            MonitorEntry::Text { .. } => "text",
            MonitorEntry::Patch { .. } => "patch",
        })
        .collect();
    assert_eq!(kinds, ["prompt", "prompt", "text", "text", "prompt"]);
    let reassembled_first = format!("{}{}", texts(&entries)[0], texts(&entries)[1]);
    let reassembled_second = format!("{}{}", texts(&entries)[2], texts(&entries)[3]);
    assert_eq!(reassembled_first, first_text);
    assert_eq!(reassembled_second, second_text);
    assert_eq!(texts(&entries)[4], "tail");
}

#[test]
fn unicode_text_resumes_cumulatively_on_char_boundaries() {
    let (_dir, mut replica) = open_replica();
    let long: String = "ab\u{1f600}".repeat(4000); // 12k chars, multibyte
    replica
        .save_parts(
            "thread",
            &[
                completion_part(
                    0,
                    vec![json!({"type":"text","text":long,"completedAt":5.0})],
                ),
                prompt_part(1, "tail"),
            ],
        )
        .unwrap();

    let first = page(&replica, None, 5000).unwrap();
    assert_eq!(first.entries.len(), 1);
    let MonitorEntry::Text { id, text } = &first.entries[0] else {
        panic!()
    };
    assert_eq!(text.chars().count(), 5000);
    assert_eq!(id, "text-0-0");
    assert!(first.has_more);

    let second = page(&replica, Some(&first.next_cursor), 5000).unwrap();
    assert_eq!(second.entries.len(), 1);
    let MonitorEntry::Text { text, .. } = &second.entries[0] else {
        panic!()
    };
    assert_eq!(text.chars().count(), 5000);

    let third = page(&replica, Some(&second.next_cursor), 5000).unwrap();
    assert_eq!(third.entries.len(), 1);
    let MonitorEntry::Text {
        text: tail_text, ..
    } = &third.entries[0]
    else {
        panic!()
    };
    assert_eq!(tail_text.chars().count(), 2000);
    assert!(
        third.has_more,
        "tail prompt remains after the final text fragment"
    );

    let fourth = page(&replica, Some(&third.next_cursor), 5000).unwrap();
    assert_eq!(fourth.entries.len(), 1);
    let MonitorEntry::Prompt { text, .. } = &fourth.entries[0] else {
        panic!()
    };
    assert_eq!(text, "tail");
    assert!(!fourth.has_more);

    let MonitorEntry::Text { text: a, .. } = &first.entries[0] else {
        panic!()
    };
    let MonitorEntry::Text { text: b, .. } = &second.entries[0] else {
        panic!()
    };
    assert_eq!(format!("{a}{b}{tail_text}"), long);
}

#[test]
fn long_patch_change_lists_page_without_dropping_paths() {
    let (_dir, mut replica) = open_replica();
    let changes: Vec<JsonValue> = (0..200)
        .map(|index| {
            json!({
                "operation":"renamed",
                "path":format!("dir/file-{index}.txt"),
                "source":format!("old/file-{index}.txt")
            })
        })
        .collect();
    replica
        .save_parts(
            "thread",
            &[
                completion_part(0, vec![patch_call_item("c1")]),
                tool_part(
                    1,
                    Some("inv-c"),
                    "c1",
                    "apply_patch",
                    "completed",
                    Some(json!({"changes":changes})),
                ),
            ],
        )
        .unwrap();

    let entries = collect_all(&replica, page(&replica, None, 1000).unwrap(), 1000);
    let collected: Vec<_> = entries
        .into_iter()
        .flat_map(|entry| {
            let MonitorEntry::Patch { changes, .. } = entry else {
                panic!()
            };
            assert!(
                !changes.is_empty(),
                "over-budget patch must not emit empties"
            );
            changes
                .into_iter()
                .map(|change| (change.path, change.source_path))
        })
        .collect();
    assert_eq!(
        collected,
        (0..200)
            .map(|index| (
                format!("dir/file-{index}.txt"),
                Some(format!("old/file-{index}.txt"))
            ))
            .collect::<Vec<_>>()
    );
}

#[test]
fn observers_are_independent_and_repeated_reads_are_stable() {
    let (_dir, mut replica) = open_replica();
    replica
        .save_parts("thread", &[prompt_part(0, "task"), prompt_part(1, "again")])
        .unwrap();
    let first = page(&replica, None, MONITOR_PAGE_CHAR_LIMIT).unwrap();
    let repeat = page(&replica, None, MONITOR_PAGE_CHAR_LIMIT).unwrap();
    assert_eq!(first.entries, repeat.entries);
    let after = page(&replica, Some(&first.next_cursor), MONITOR_PAGE_CHAR_LIMIT).unwrap();
    assert!(after.entries.is_empty());
    assert!(!after.has_more);
    let fresh = page(&replica, None, MONITOR_PAGE_CHAR_LIMIT).unwrap();
    assert_eq!(fresh.entries.len(), 2);
}

#[test]
fn stale_and_foreign_cursors_fail_explicitly_and_reopen_resets() {
    let (dir, mut replica) = open_replica();
    replica
        .save_parts("thread", &[prompt_part(0, "x")])
        .unwrap();
    let good = page(&replica, None, MONITOR_PAGE_CHAR_LIMIT).unwrap();

    let malformed = page(
        &replica,
        Some("!!!not-a-cursor!!!"),
        MONITOR_PAGE_CHAR_LIMIT,
    )
    .unwrap_err()
    .downcast::<MonitorReadError>()
    .unwrap();
    assert_eq!(malformed, MonitorReadError::MalformedCursor);

    let foreign = read_page(
        &replica,
        "other-thread",
        parse_cursor(&good.next_cursor).ok(),
        1000,
    )
    .unwrap_err()
    .downcast::<MonitorReadError>()
    .unwrap();
    assert_eq!(foreign, MonitorReadError::WrongThread);

    // Reopening the replica (WAL checkpoint) keeps the cursor valid.
    drop(replica);
    let reopened = WorkReplica::open(dir.path().to_owned()).unwrap();
    let continued = page(&reopened, Some(&good.next_cursor), 1000).unwrap();
    assert!(continued.entries.is_empty());
    assert!(!continued.has_more);

    // A rebuilt replica (new replicaId) invalidates prior cursors.
    let rebuild_dir = tempfile::tempdir().unwrap();
    let mut fresh = WorkReplica::open(rebuild_dir.path().to_owned()).unwrap();
    fresh.save_parts("thread", &[prompt_part(0, "x")]).unwrap();
    let reset = read_page(&fresh, "thread", parse_cursor(&good.next_cursor).ok(), 1000)
        .unwrap_err()
        .downcast::<MonitorReadError>()
        .unwrap();
    assert_eq!(reset, MonitorReadError::MonitorCursorReset);
}

#[test]
fn cursor_survives_new_revisions_and_keeps_progress() {
    let (_dir, mut replica) = open_replica();
    replica
        .save_parts("thread", &[prompt_part(0, "one")])
        .unwrap();
    let first = page(&replica, None, MONITOR_PAGE_CHAR_LIMIT).unwrap();
    replica
        .save_parts("thread", &[prompt_part(1, "two")])
        .unwrap();
    let second = page(&replica, Some(&first.next_cursor), MONITOR_PAGE_CHAR_LIMIT).unwrap();
    assert_eq!(second.entries.len(), 1);
    let MonitorEntry::Prompt { text, .. } = &second.entries[0] else {
        panic!()
    };
    assert_eq!(text, "two");
}

#[test]
fn out_of_order_downloads_do_not_leak_later_entries() {
    let (_dir, mut replica) = open_replica();
    replica
        .save_parts("thread", &[prompt_part(1, "later")])
        .unwrap();
    let first = page(&replica, None, MONITOR_PAGE_CHAR_LIMIT).unwrap();
    assert!(first.entries.is_empty());
    assert!(first.has_more);
    replica
        .save_parts("thread", &[prompt_part(0, "earlier")])
        .unwrap();
    let second = page(&replica, Some(&first.next_cursor), MONITOR_PAGE_CHAR_LIMIT).unwrap();
    assert_eq!(texts(&second.entries), ["earlier", "later"]);
    assert!(!second.has_more);
}
