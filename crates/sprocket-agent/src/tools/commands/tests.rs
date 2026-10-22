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
fn exec_command_schema_shell_has_no_default() {
    let schema = exec_command_parameters(MAX_YIELD_MS);
    let shell = &schema["properties"]["shell"];
    assert_eq!(
        shell["description"],
        "Shell binary to launch, e.g. bash or pwsh. Defaults to the machine's shell."
    );
    assert!(shell.get("default").is_none());
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
fn poll_schema_only_takes_a_session_and_a_yield_window() {
    let schema = poll_command_parameters(MAX_YIELD_MS);
    assert_eq!(schema["required"], json!(["sessionId"]));
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
    let poll: PollCommandArgs = serde_json::from_value(json!({"sessionId": "42"})).unwrap();
    assert_eq!(poll.yield_time_ms, DEFAULT_YIELD_MS);

    assert!(
        serde_json::from_value::<PollCommandArgs>(json!({"sessionId": "42", "chars": "x"}))
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
fn yield_time_defaults_apply_and_zero_is_preserved() {
    let exec_default: ExecCommandArgs = serde_json::from_value(json!({"cmd": "pwd"})).unwrap();
    assert_eq!(exec_default.yield_time_ms, DEFAULT_YIELD_MS);

    let control_default: ControlCommandArgs =
        serde_json::from_value(json!({"sessionId": "abc", "action": "terminate"})).unwrap();
    assert_eq!(control_default.yield_time_ms, DEFAULT_YIELD_MS);

    let exec_zero: ExecCommandArgs =
        serde_json::from_value(json!({"cmd": "pwd", "yieldTimeMs": 0})).unwrap();
    assert_eq!(exec_zero.yield_time_ms, 0);
    assert_eq!(
        serde_json::to_value(exec_zero).unwrap(),
        json!({"cmd": "pwd", "yieldTimeMs": 0})
    );

    let control_zero: ControlCommandArgs = serde_json::from_value(
        json!({"sessionId": "abc", "action": "terminate", "yieldTimeMs": 0}),
    )
    .unwrap();
    assert_eq!(control_zero.yield_time_ms, 0);
    assert_eq!(
        serde_json::to_value(control_zero).unwrap(),
        json!({"sessionId": "abc", "action": "terminate", "yieldTimeMs": 0})
    );
}

#[test]
fn historical_numeric_yield_values_round_trip() {
    let exec_legacy: ExecCommandArgs =
        serde_json::from_value(json!({"cmd": "pwd", "yieldTimeMs": 10_000})).unwrap();
    assert_eq!(exec_legacy.yield_time_ms, 10_000);
    let serialized = serde_json::to_value(&exec_legacy).unwrap();
    let restored: ExecCommandArgs = serde_json::from_value(serialized).unwrap();
    assert_eq!(restored.yield_time_ms, 10_000);

    let control_legacy: ControlCommandArgs = serde_json::from_value(
        json!({"sessionId": "abc", "action": "terminate", "yieldTimeMs": 5_000}),
    )
    .unwrap();
    assert_eq!(control_legacy.yield_time_ms, 5_000);
    assert_eq!(
        serde_json::to_value(&control_legacy).unwrap(),
        json!({"sessionId": "abc", "action": "terminate", "yieldTimeMs": 5_000})
    );
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

#[test]
fn timeout_is_optional_and_preserved_when_set() {
    let without_timeout: ExecCommandArgs =
        serde_json::from_value(json!({"cmd": "sleep 120"})).unwrap();
    assert_eq!(without_timeout.timeout_ms, None);

    let with_timeout: ExecCommandArgs = serde_json::from_value(json!({
        "cmd": "sleep 120",
        "timeoutMs": 1_000,
    }))
    .unwrap();
    assert_eq!(with_timeout.timeout_ms, Some(1_000));
    assert_eq!(
        serde_json::to_value(with_timeout).unwrap(),
        json!({"cmd": "sleep 120", "timeoutMs": 1_000})
    );
}
