use super::*;

#[test]
fn integral_floats_decode_as_integers() {
    let value = Value::Array(vec![Value::Float64(5.0), Value::Float64(0.5)]);
    assert_eq!(value_to_plain_json(value).to_string(), "[5,0.5]");
}

#[test]
fn cleans_masking_lines_prefixes_and_stack_frames() {
    let raw = concat!(
        "[Request ID: 84f5068c0836218d] Server Error\n",
        "Uncaught ConvexError: The webpage is too complex and could not be parsed as Markdown.\n",
        "    at handler (../src/convex/webTools.ts:130:2)"
    );
    assert_eq!(
        clean_function_error_message(raw),
        "The webpage is too complex and could not be parsed as Markdown."
    );
}

#[test]
fn falls_back_when_production_masks_the_whole_error() {
    assert_eq!(
        clean_function_error_message("[Request ID: 0d45611fde71c0f2] Server Error"),
        "The server failed without a readable error."
    );
}

#[test]
fn convex_error_uses_string_data_when_production_redacts_the_message() {
    let err = decode_function_result::<serde_json::Value>(
        FunctionResult::ConvexError(ConvexError {
            message: "[Request ID: 0d45611fde71c0f2] Server Error".to_string(),
            data: Value::String(
                "Finish or cancel the active run before sending another message.".to_string(),
            ),
        }),
        "subagents:createOrSend",
    )
    .expect_err("should fail");
    assert_eq!(
        err.to_string(),
        "Finish or cancel the active run before sending another message."
    );
}

#[test]
fn convex_error_falls_back_to_message_when_data_is_not_a_string() {
    let err = decode_function_result::<serde_json::Value>(
        FunctionResult::ConvexError(ConvexError {
            message: "Uncaught ConvexError: boom\n    at handler (../src/convex/webTools.ts:1:0)"
                .to_string(),
            data: Value::Object(Default::default()),
        }),
        "webTools:search",
    )
    .expect_err("should fail");
    assert_eq!(err.to_string(), "boom");
}

#[test]
fn coded_convex_errors_keep_their_code_and_message() {
    let err = decode_labeled_function_result::<serde_json::Value>(
        FunctionResult::ConvexError(ConvexError {
            message: "[Request ID: 0d45611fde71c0f2] Server Error".to_string(),
            data: Value::Object(
                [("code", "RUN_CANCELLED"), ("message", "Run is cancelled.")]
                    .into_iter()
                    .map(|(key, value)| (key.to_string(), value.into()))
                    .collect(),
            ),
        }),
        "agentRuntime:registerCompletionAttempt",
    )
    .expect_err("should fail")
    .context("model call failed");
    assert_eq!(convex_error_code(&err), Some(ConvexErrorCode::RunCancelled));
    assert_eq!(
        format!("{err:#}"),
        "model call failed: agentRuntime:registerCompletionAttempt: Run is cancelled."
    );
}

#[test]
fn legacy_string_data_carries_its_code() {
    let err = decode_function_result::<serde_json::Value>(
        FunctionResult::ConvexError(ConvexError {
            message: "[Request ID: 0d45611fde71c0f2] Server Error".to_string(),
            data: Value::String("SPROCKET_SUBMISSION_WAITING".to_string()),
        }),
        "agentRuntime:createGatewayRun",
    )
    .expect_err("should fail")
    .context("create run");
    assert_eq!(
        convex_error_code(&err),
        Some(ConvexErrorCode::SubmissionWaiting)
    );
    assert_eq!(err.root_cause().to_string(), "SPROCKET_SUBMISSION_WAITING");
}

#[test]
fn every_convex_agent_error_message_maps_to_its_code() {
    let codes: serde_json::Map<String, serde_json::Value> = serde_json::from_str(include_str!(
        "../../../../apps/web/convex/lib/agentErrorCodes.json"
    ))
    .unwrap();
    for (code, message) in codes {
        let expected =
            serde_json::from_value::<ConvexErrorCode>(serde_json::Value::String(code.clone()))
                .unwrap_or_else(|error| panic!("{code}: {error}"));
        assert_eq!(
            code_for_message(message.as_str().unwrap()),
            Some(expected),
            "{code}"
        );
    }
}

#[test]
fn labeled_errors_include_the_function_path() {
    let err = decode_labeled_function_result::<serde_json::Value>(
        FunctionResult::ErrorMessage("Uncaught Error: boom".to_string()),
        "transcript:getState",
    )
    .expect_err("should fail");
    assert_eq!(err.to_string(), "transcript:getState: boom");
}

#[test]
fn labeled_convex_error_uses_string_data_when_production_redacts_the_message() {
    let err = decode_labeled_function_result::<serde_json::Value>(
        FunctionResult::ConvexError(ConvexError {
            message: "[Request ID: 0d45611fde71c0f2] Server Error".to_string(),
            data: Value::String(
                "Finish or cancel the active run before sending another message.".to_string(),
            ),
        }),
        "subagents:createOrSend",
    )
    .expect_err("should fail");
    assert_eq!(
        err.to_string(),
        "subagents:createOrSend: Finish or cancel the active run before sending another message."
    );
}

#[test]
fn deserialize_convex_u64_accepts_integer_floats() {
    #[derive(Deserialize)]
    struct Row {
        #[serde(deserialize_with = "deserialize_convex_u64")]
        n: u64,
    }
    let row: Row = serde_json::from_value(serde_json::json!({ "n": 12.0 })).unwrap();
    assert_eq!(row.n, 12);
}

#[test]
fn deserialize_convex_u64_rejects_fractions() {
    assert!(deserialize_convex_u64(serde_json::json!(1.5)).is_err());
}

#[test]
fn deserialize_convex_u32_rejects_overflow() {
    assert!(deserialize_convex_u32(serde_json::json!((u32::MAX as f64) + 1.0)).is_err());
}
