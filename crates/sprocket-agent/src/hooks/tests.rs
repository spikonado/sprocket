use super::*;

impl ToolCallTracker {
    pub(crate) fn completion_invocations(&self) -> Vec<ToolInvocationAssignment> {
        self.0
            .lock()
            .map(|state| state.completion.clone())
            .unwrap_or_default()
    }
}

fn tools() -> Vec<String> {
    AGENT_TOOLS
        .iter()
        .map(|(name, _)| (*name).to_string())
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
    tracker.record_turn([Some("call-1"), Some("call-2")]);

    let second = tracker
        .assignment_for_dispatch("internal-2", Some("call-2"))
        .unwrap();
    let first = tracker
        .assignment_for_dispatch("internal-1", Some("call-1"))
        .unwrap();
    assert_eq!(second.call_id, "call-2");
    assert_eq!(first.call_id, "call-1");
    assert_ne!(first.tool_invocation_id, second.tool_invocation_id);

    tracker.prepare_dispatch(
        "exec_cmd",
        "internal-2",
        Some("call-2"),
        r#"{"cmd":"same","shell":"bash"}"#,
    );
    tracker.prepare_dispatch(
        "exec_cmd",
        "internal-1",
        Some("call-1"),
        r#"{"cmd":"same","shell":null}"#,
    );
    let first_dispatch = tracker
        .claim_dispatch("exec_cmd", &serde_json::json!({"cmd":"same"}))
        .unwrap();
    let second_dispatch = tracker
        .claim_dispatch(
            "exec_cmd",
            &serde_json::json!({"cmd":"same","shell":"bash"}),
        )
        .unwrap();
    assert_eq!(second_dispatch.call_id, "call-2");
    assert_eq!(first_dispatch.call_id, "call-1");

    let original_ids = tracker
        .completion_invocations()
        .into_iter()
        .map(|invocation| invocation.tool_invocation_id)
        .collect::<Vec<_>>();
    tracker.record_turn([Some("call-1"), Some("call-2")]);
    let retry_ids = tracker
        .completion_invocations()
        .into_iter()
        .map(|invocation| invocation.tool_invocation_id)
        .collect::<Vec<_>>();
    assert_eq!(retry_ids, original_ids);
}

#[test]
fn durable_call_ids_match_dispatches_and_change_when_provider_ids_repeat() {
    let tracker = ToolCallTracker::new("run", "claim");
    tracker.record_turn([None, Some("same"), None, Some("same")]);
    let mut items = vec![
        serde_json::json!({"type": "reasoning", "text": "plan"}),
        serde_json::json!({"type": "tool-call", "callId": "same"}),
        serde_json::json!({"type": "text", "text": "working"}),
        serde_json::json!({"type": "tool-call", "callId": "same"}),
    ];
    tracker.annotate_items(&mut items);
    let first = tracker
        .assignment_for_dispatch("first", Some("same"))
        .unwrap();
    let second = tracker
        .assignment_for_dispatch("second", Some("same"))
        .unwrap();
    assert_eq!(items[1]["toolInvocationId"], first.tool_invocation_id);
    assert_eq!(items[3]["toolInvocationId"], second.tool_invocation_id);
    assert_ne!(first.tool_invocation_id, second.tool_invocation_id);

    tracker.begin_attempt(2, "stream-2");
    tracker.record_turn([None, Some("same")]);
    let next = tracker
        .assignment_for_dispatch("first", Some("same"))
        .unwrap();
    assert_ne!(next.tool_invocation_id, first.tool_invocation_id);
    assert_eq!(next.attempt_seq, 2);
    assert_eq!(next.stream_id, "stream-2");
}
