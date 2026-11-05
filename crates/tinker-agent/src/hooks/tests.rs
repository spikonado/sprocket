use super::*;

fn tools() -> Vec<String> {
    AGENT_TOOL_NAMES
        .iter()
        .map(|name| (*name).to_string())
        .collect()
}

fn assert_repaired(tool_name: &str, expected: &str) {
    match resolve_invalid_tool_name(tool_name, &tools()) {
        InvalidToolCallAction::Repair { tool_name } => assert_eq!(tool_name, expected),
        other => panic!("expected repair, got {other:?}"),
    }
}

#[test]
fn repairs_near_miss_tool_names() {
    assert_repaired("exec-cmd", "exec_cmd");
    assert_repaired("apply-patch", "apply_patch");
    assert_repaired("controlcmd", "control_cmd");
    assert_repaired("poll-cmd", "poll_cmd");
    assert_repaired("control-subagent", "control_subagent");
    assert_repaired("poll-subagent", "poll_subagent");
    assert_repaired("parse-file", "parse_file");
}

#[test]
fn retries_unknown_tool_names() {
    match resolve_invalid_tool_name("launch_missiles", &tools()) {
        InvalidToolCallAction::Retry { feedback } => {
            assert!(feedback.contains("exec_cmd"));
            assert!(feedback.contains("control_cmd"));
            assert!(feedback.contains("poll_cmd"));
            assert!(feedback.contains("apply_patch"));
        }
        other => panic!("expected retry, got {other:?}"),
    }
}

#[test]
fn malformed_arguments_retry_without_repairing_a_valid_tool_name() {
    let context = serde_json::from_value(serde_json::json!({
        "tool_name": "exec_command",
        "tool_call_id": null,
        "args": "{broken",
        "available_tools": ["exec_command"],
        "allowed_tools": ["exec_command"],
        "tool_choice": null,
        "chat_history": [],
        "is_streaming": true,
        "reason": {
            "reason": "malformed_arguments",
            "error": "expected quoted key"
        }
    }))
    .unwrap();
    let action = resolve_invalid_tool_call(&context);
    let InvalidToolCallAction::Retry { feedback } = action else {
        panic!("malformed arguments must be retried, not repaired");
    };
    assert!(feedback.contains("valid JSON"));
    assert!(feedback.contains("expected quoted key"));
}

#[test]
fn tracker_associates_parallel_calls_by_dispatch_identity() {
    let tracker = ToolCallTracker::new("run", "claim");
    tracker.record_turn(&[
        OrderedContent::Tool {
            call_id: "call-1".into(),
        },
        OrderedContent::Tool {
            call_id: "call-2".into(),
        },
    ]);

    let second = tracker
        .assignment_for_dispatch("internal-2", Some("call-2"))
        .unwrap();
    let first = tracker
        .assignment_for_dispatch("internal-1", Some("call-1"))
        .unwrap();
    assert_eq!(second.call_id, "call-2");
    assert_eq!(first.call_id, "call-1");
    assert_ne!(first.tool_invocation_id, second.tool_invocation_id);
    assert_eq!(first.section_key, second.section_key);

    tracker.prepare_dispatch(
        "exec_cmd",
        "internal-1",
        Some("call-1"),
        r#"{"cmd":"first"}"#,
    );
    tracker.prepare_dispatch(
        "exec_cmd",
        "internal-2",
        Some("call-2"),
        r#"{"cmd":"second"}"#,
    );
    let second_dispatch = tracker
        .claim_dispatch("exec_cmd", &serde_json::json!({"cmd":"second"}))
        .unwrap();
    let first_dispatch = tracker
        .claim_dispatch("exec_cmd", &serde_json::json!({"cmd":"first"}))
        .unwrap();
    assert_eq!(second_dispatch.call_id, "call-2");
    assert_eq!(first_dispatch.call_id, "call-1");

    let original_ids = tracker
        .completion_assignments()
        .tool_invocations
        .into_iter()
        .map(|invocation| invocation.tool_invocation_id)
        .collect::<Vec<_>>();
    tracker.record_turn(&[
        OrderedContent::Tool {
            call_id: "call-1".into(),
        },
        OrderedContent::Tool {
            call_id: "call-2".into(),
        },
    ]);
    let retry_ids = tracker
        .completion_assignments()
        .tool_invocations
        .into_iter()
        .map(|invocation| invocation.tool_invocation_id)
        .collect::<Vec<_>>();
    assert_eq!(retry_ids, original_ids);
}

#[test]
fn grouping_survives_turns_and_text_closes_the_current_section() {
    let tracker = ToolCallTracker::new("run", "claim");
    tracker.record_turn(&[
        OrderedContent::Reasoning(true),
        OrderedContent::Tool {
            call_id: "one".into(),
        },
    ]);
    let first = tracker.completion_assignments();
    let first_key = first.work.ranges[0].section_key.clone();
    assert_eq!(first.work.ranges[0].start, 0);
    assert_eq!(first.work.ranges[0].end, 2);

    tracker.begin_attempt(2, "stream-2");
    tracker.record_turn(&[
        OrderedContent::Reasoning(true),
        OrderedContent::Text(true),
        OrderedContent::Reasoning(true),
        OrderedContent::Tool {
            call_id: "two".into(),
        },
    ]);
    let second = tracker.completion_assignments();
    assert_eq!(second.work.ranges[0].section_key, first_key);
    assert_ne!(second.work.ranges[1].section_key, first_key);
    assert!(second.sections[0].closed);
    assert!(!second.sections[1].closed);
    assert_eq!(second.work.ranges[1].end, 4);
    assert_eq!(
        second.tool_invocations[0].section_key,
        second.work.ranges[1].section_key
    );
}
