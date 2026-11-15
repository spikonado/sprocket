use super::*;

#[test]
fn completion_response_decodes_the_authoritative_persisted_part() {
    let value = Value::try_from(serde_json::json!({
        "completion": {
            "_creationTime": 1_700_000_000_000.5,
            "number": 8,
            "sourceKey": "completion:run:stream",
            "kind": "completion",
            "runId": "run",
            "completion": {
                "items": [{
                    "type": "tool-call", "callId": "provider-call", "toolInvocationId": "inv-1",
                    "name": "exec_cmd", "input": {"cmd": "pwd"}
                }]
            }
        },
        "parts": [{
            "number": 9, "sourceKey": "tool:inv-1:finished", "kind": "tool", "runId": "run",
            "tool": {"toolInvocationId": "inv-1", "status": "failed", "output": {"error": "failed"}}
        }]
    }))
    .unwrap();
    let response: CompletionMutationResponse =
        decode_function_result(FunctionResult::Value(value), "finalizeCompletionCall").unwrap();
    assert_eq!(response.parts.len(), 1);
    let part: sprocket_transcript::TranscriptPart = response.completion.unwrap().into();
    assert_eq!(part.number, 8);
    assert_eq!(part.created_at, Some(1_700_000_000_000));
    assert!(part.work.ranges.is_empty());
    let completion = part.completion.unwrap();
    assert!(completion.stream_id.is_none());
    assert_eq!(completion.items[0]["toolInvocationId"], "inv-1");

    let empty: CompletionMutationResponse = decode_function_result(
        FunctionResult::Value(
            Value::try_from(serde_json::json!({"completion": null, "parts": []})).unwrap(),
        ),
        "finalizeCompletionCall",
    )
    .unwrap();
    assert!(empty.completion.is_none());
    assert!(empty.parts.is_empty());
}

#[test]
fn parts_mutation_response_decodes_prompt_and_compact_tool_results() {
    let value = Value::try_from(serde_json::json!({
        "accepted": true,
        "parts": [
            {"number": 0, "sourceKey": "prompt:run", "kind": "prompt", "runId": "run", "prompt": {"text": "hello", "imageUploads": []}},
            {"number": 1, "sourceKey": "tool:inv:finished", "kind": "tool", "runId": "run",
             "tool": {"toolInvocationId": "inv", "status": "completed", "output": {"success": true}}}
        ]
    })).unwrap();
    let response: PartsMutationResponse =
        decode_function_result(FunctionResult::Value(value), "beginRun").unwrap();
    assert!(response.accepted);
    let parts: Vec<TranscriptPart> = response.parts.into_iter().map(Into::into).collect();
    assert_eq!(parts[0].prompt.as_ref().unwrap().text, "hello");
    let tool = parts[1].tool.as_ref().unwrap();
    assert_eq!(tool.tool_invocation_id.as_deref(), Some("inv"));
    assert_eq!(tool.output.as_ref().unwrap()["success"], true);
}

#[test]
fn persisted_parts_still_decode_legacy_work_and_tool_fields() {
    let part: PersistedTranscriptPart = serde_json::from_value(serde_json::json!({
        "number": 1, "sourceKey": "legacy", "kind": "tool", "runId": "run",
        "work": {"sectionKey": "section-1"},
        "tool": {"toolInvocationId": "inv", "callId": "call", "name": "exec_cmd",
                 "input": {"cmd": "pwd"}, "status": "started"}
    }))
    .unwrap();
    let part: TranscriptPart = part.into();
    assert_eq!(part.work.section_key.as_deref(), Some("section-1"));
    let tool = part.tool.unwrap();
    assert_eq!(tool.name, "exec_cmd");
    assert_eq!(tool.call_id, "call");
}
