use super::*;
use crate::tools::async_tools::{DEFAULT_YIELD_MS, MIN_POLL_YIELD_MS};

const MAX_YIELD_MS: u64 = 1_770_000;

#[test]
fn exec_command_schema_does_not_expose_the_preview_limit() {
    let schema = exec_command_parameters(MAX_YIELD_MS);
    let properties = schema["properties"].as_object().unwrap();
    assert_eq!(properties.len(), 4);
    assert!(!properties.contains_key("maxOutputChars"));
    assert_eq!(schema["required"], json!(["cmd"]));
    assert!(properties["timeoutMs"].get("default").is_none());
}

#[test]
fn control_schema_requires_session_and_action_with_action_constraints() {
    let schema = control_command_parameters(MAX_YIELD_MS);
    assert_eq!(schema["required"], json!(["sessionId", "action"]));
    assert_eq!(schema["additionalProperties"], json!(false));
    assert_eq!(schema["properties"]["sessionId"]["type"], "string");
    assert_eq!(
        schema["properties"]["sessionId"]["description"],
        "Session returned by exec_cmd."
    );
    assert_eq!(
        schema["properties"]["action"]["enum"],
        json!(["write", "terminate"])
    );
    assert_eq!(schema["properties"]["chars"]["default"], json!(""));
    assert_eq!(
        schema["anyOf"],
        json!([
            {
                "properties": {
                    "action": { "type": "string", "enum": ["write"] },
                    "chars": { "type": "string", "minLength": 1 }
                },
                "required": ["chars"]
            },
            {
                "properties": {
                    "action": { "type": "string", "enum": ["terminate"] },
                    "chars": { "type": "string", "enum": [""] }
                }
            }
        ])
    );
    assert!(serde_json::from_value::<ControlCommandArgs>(json!({})).is_err());
    assert!(
        serde_json::from_value::<ControlCommandArgs>(json!({"sessionId": "42"})).is_err(),
        "action is required"
    );
}

#[test]
fn control_args_deserialize_strictly() {
    let write: ControlCommandArgs = serde_json::from_value(json!({
        "sessionId": "42",
        "action": "write",
        "chars": "yes\n",
    }))
    .unwrap();
    assert_eq!(write.action, CommandActionArg::Write);
    assert_eq!(write.chars, "yes\n");

    let terminate: ControlCommandArgs =
        serde_json::from_value(json!({"sessionId": "42", "action": "terminate"})).unwrap();
    assert_eq!(terminate.action, CommandActionArg::Terminate);
    assert!(terminate.chars.is_empty());

    assert!(
        serde_json::from_value::<ControlCommandArgs>(
            json!({"sessionId": "42", "action": "write", "terminate": true})
        )
        .is_err(),
        "legacy write_stdin fields are rejected"
    );
    assert!(
        serde_json::from_value::<ControlCommandArgs>(
            json!({"sessionId": "42", "action": "signal"})
        )
        .is_err(),
        "unknown actions are rejected"
    );
}

#[test]
fn control_action_and_chars_are_validated_before_dispatch() {
    let write_without_chars: ControlCommandArgs =
        serde_json::from_value(json!({"sessionId": "42", "action": "write"})).unwrap();
    assert!(write_without_chars.chars.is_empty());
    let error = write_without_chars
        .action
        .action()
        .validate(&write_without_chars.chars)
        .expect_err("write requires nonempty chars");
    assert!(error.to_string().contains("nonempty chars"));

    let write: ControlCommandArgs =
        serde_json::from_value(json!({"sessionId": "42", "action": "write", "chars": "input\n"}))
            .unwrap();
    write
        .action
        .action()
        .validate(&write.chars)
        .expect("nonempty write is valid");

    let terminate: ControlCommandArgs =
        serde_json::from_value(json!({"sessionId": "42", "action": "terminate"})).unwrap();
    terminate
        .action
        .action()
        .validate(&terminate.chars)
        .expect("terminate defaults to empty chars");

    let terminate_with_chars: ControlCommandArgs = serde_json::from_value(
        json!({"sessionId": "42", "action": "terminate", "chars": "leftover"}),
    )
    .unwrap();
    terminate_with_chars
        .action
        .action()
        .validate(&terminate_with_chars.chars)
        .expect_err("terminate requires empty chars");
}

#[test]
fn poll_schema_only_takes_sessions_and_a_yield_window() {
    let schema = poll_command_parameters(MAX_YIELD_MS);
    assert_eq!(schema["required"], json!(["sessionIds"]));
    assert_eq!(schema["properties"]["sessionIds"]["minItems"], json!(1));
    assert_eq!(schema["additionalProperties"], json!(false));
    let properties = schema["properties"].as_object().unwrap();
    assert_eq!(properties.len(), 2);
    let yield_time = &properties["yieldTimeMs"];
    assert_eq!(yield_time["default"], json!(DEFAULT_YIELD_MS));
    assert_eq!(
        yield_time["anyOf"],
        json!([
            { "type": "integer", "enum": [0] },
            { "type": "integer", "minimum": MIN_POLL_YIELD_MS, "maximum": MAX_YIELD_MS }
        ])
    );
    assert_eq!(
        yield_time["description"],
        "Maximum time to wait for completion before returning the tool call. Zero returns an immediate status/output snapshot."
    );
}

#[test]
fn poll_args_deserialize_strictly() {
    let poll: PollCommandArgs =
        serde_json::from_value(json!({"sessionIds": ["42", "43"]})).unwrap();
    assert_eq!(poll.session_ids, ["42", "43"]);
    assert_eq!(poll.yield_time_ms, DEFAULT_YIELD_MS);

    assert!(
        serde_json::from_value::<PollCommandArgs>(json!({"sessionIds": ["42"], "chars": "x"}))
            .is_err(),
        "poll takes no action fields"
    );
}

#[test]
fn exec_and_control_advertise_the_same_yield_window() {
    for schema in [
        exec_command_parameters(MAX_YIELD_MS),
        control_command_parameters(MAX_YIELD_MS),
    ] {
        let yield_time = &schema["properties"]["yieldTimeMs"];
        assert_eq!(yield_time["default"], json!(DEFAULT_YIELD_MS));
        assert_eq!(yield_time["type"], "integer");
        assert_eq!(yield_time["minimum"], 0);
        assert_eq!(yield_time["maximum"], MAX_YIELD_MS);
        assert!(yield_time.get("anyOf").is_none());
        assert_eq!(
            yield_time["description"],
            "Maximum time to wait for completion before returning the tool call."
        );
    }
}

#[test]
fn removed_arguments_are_not_replayed_as_tool_arguments() {
    let args: ExecCommandArgs = serde_json::from_value(json!({
        "cmd": "pwd",
        "maxOutputChars": 1,
        "workdir": "apps/web",
    }))
    .unwrap();
    assert_eq!(serde_json::to_value(args).unwrap(), json!({"cmd": "pwd"}));
}

fn command_part(
    number: u32,
    name: &str,
    status: &str,
    input: serde_json::Value,
    output: serde_json::Value,
) -> TranscriptPart {
    serde_json::from_value(json!({
        "number": number,
        "sourceKey": format!("tool:{number}"),
        "kind": "tool",
        "runId": "run",
        "tool": {
            "callId": format!("call-{number}"),
            "name": name,
            "input": input,
            "output": output,
            "status": status,
        },
    }))
    .unwrap()
}

async fn read_from(cursors: &CommandCursors, session_id: &str, next: u64) -> u64 {
    let mut seen = None;
    cursors
        .read(session_id, |from| {
            seen = Some(from);
            async move { Ok(json!({ "nextOffset": next })) }
        })
        .await
        .unwrap();
    seen.unwrap()
}

#[tokio::test]
async fn cursors_restore_session_inputs_from_each_invocation() {
    let completion = |number, invocation, name, input| {
        serde_json::from_value(json!({
            "number": number, "sourceKey": format!("completion:{number}"), "kind": "completion", "runId": "run",
            "completion": {"items": [{"type": "tool-call", "toolInvocationId": invocation, "callId": "repeated", "name": name, "input": input}]}
        })).unwrap()
    };
    let result = |number, invocation, next| {
        serde_json::from_value(json!({
            "number": number, "sourceKey": format!("tool:{number}"), "kind": "tool", "runId": "run",
            "tool": {"toolInvocationId": invocation, "status": "completed", "output": {"nextOffset": next}}
        })).unwrap()
    };
    let parts: [TranscriptPart; 4] = [
        completion(0, "inv-a", "poll_cmd", json!({"sessionId": "a"})),
        result(1, "inv-a", 12),
        completion(
            2,
            "inv-b",
            "control_cmd",
            json!({"sessionId": "b", "action": "write", "chars": "x"}),
        ),
        result(3, "inv-b", 25),
    ];
    let cursors = CommandCursors::from_parts(&parts);
    assert_eq!(read_from(&cursors, "a", 12).await, 12);
    assert_eq!(read_from(&cursors, "b", 25).await, 25);
}

#[tokio::test]
async fn cursors_resume_from_the_furthest_recorded_read_of_each_session() {
    let parts = [
        command_part(
            4,
            "poll_cmd",
            "completed",
            json!({"sessionId": "a"}),
            json!({"nextOffset": 5.0, "running": false}),
        ),
        command_part(
            1,
            "exec_cmd",
            "completed",
            json!({"cmd": "build"}),
            json!({"sessionId": "a", "nextOffset": 2}),
        ),
        command_part(
            2,
            "exec_cmd",
            "completed",
            json!({"cmd": "test"}),
            json!({"sessionId": "b", "nextOffset": 3}),
        ),
        command_part(
            5,
            "poll_cmd",
            "completed",
            json!({"sessionId": "b"}),
            json!({"running": false}),
        ),
        command_part(
            6,
            "poll_cmd",
            "failed",
            json!({"sessionId": "b"}),
            json!({"nextOffset": 9}),
        ),
        command_part(
            7,
            "poll_cmd",
            "completed",
            json!({"sessionIds": ["d", "c"]}),
            json!([
                {"sessionId": "d", "nextOffset": 7},
                {"sessionId": "c", "error": "unknown command session: c"}
            ]),
        ),
    ];
    let cursors = CommandCursors::from_parts(&parts);
    assert_eq!(read_from(&cursors, "a", 6).await, 5);
    assert_eq!(read_from(&cursors, "b", 4).await, 3);
    assert_eq!(read_from(&cursors, "d", 8).await, 7);
    assert_eq!(read_from(&cursors, "c", 1).await, 0);
    assert_eq!(read_from(&cursors, "new", 1).await, 0);
}

#[tokio::test]
async fn failed_reads_keep_the_cursor() {
    let cursors = CommandCursors::default();
    assert_eq!(read_from(&cursors, "a", 2).await, 0);
    cursors
        .read("a", |_| async {
            Err(tool_error(anyhow::anyhow!("offline")))
        })
        .await
        .unwrap_err();
    assert_eq!(read_from(&cursors, "a", 3).await, 2);
}
