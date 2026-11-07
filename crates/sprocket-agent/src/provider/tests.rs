use std::collections::HashMap;

use super::transcript_sink::{
    apply_completed_text, apply_completed_tool_call, durable_items_json, visible_live_parts,
};
use super::{ProviderErrorDisposition, RunNoLongerActive, classify_provider_error};
use sprocket_transcript::{LiveAssistantPart, LiveAssistantParts};

#[test]
fn generation_options_map_reasoning_effort() {
    let options = super::generation_options("xhigh").unwrap();
    assert_eq!(
        options.reasoning,
        Some(rig::completion::Effort::XHigh.into())
    );
    let options = super::generation_options("none").unwrap();
    assert_eq!(options.reasoning, Some(rig::completion::Reasoning::Off));
}

#[test]
fn live_projection_omits_empty_reasoning_without_removing_durable_state() {
    let parts = vec![
        LiveAssistantPart::Reasoning {
            id: "empty".into(),
            text: " \n".into(),
            started_at: None,
            completed_at: None,
            turn_id: None,
        },
        LiveAssistantPart::Reasoning {
            id: "visible".into(),
            text: "plan".into(),
            started_at: None,
            completed_at: None,
            turn_id: None,
        },
    ];
    let metadata = HashMap::from([("reasoning:empty".into(), reasoning_envelope())]);
    let live = visible_live_parts(&parts);
    assert_eq!(live.len(), 1);
    assert!(matches!(&live[0], LiveAssistantPart::Reasoning { id, .. } if id == "visible"));
    let durable = durable_items_json(&parts, &metadata);
    assert_eq!(durable.len(), 2);
    assert_eq!(durable[0]["providerMetadata"], reasoning_envelope());
}

#[test]
fn consecutive_text_parts_preserve_their_own_phase_and_authoritative_text() {
    let mut parts = LiveAssistantParts::default();
    let mut metadata = HashMap::new();
    parts.apply_text_delta(
        "text",
        "stream:text:0".into(),
        "partial",
        Some("stream".into()),
        1,
    );
    let rig::message::AssistantContent::Text(commentary) =
        rig::message::AssistantContent::text("Working").with_native(serde_json::json!({
            "type": "message", "id": "msg_commentary", "phase": "commentary",
            "role": "assistant", "content": [{"type": "output_text", "text": "Working"}]
        }))
    else {
        unreachable!();
    };
    assert_eq!(
        apply_completed_text(&mut parts, &mut metadata, "stream", 0, &commentary),
        "partial"
    );
    let rig::message::AssistantContent::Text(answer) = rig::message::AssistantContent::text("Done")
        .with_native(serde_json::json!({
            "type": "message", "id": "msg_answer", "phase": "final_answer",
            "role": "assistant", "content": [{"type": "output_text", "text": "Done"}]
        }))
    else {
        unreachable!();
    };
    assert_eq!(
        apply_completed_text(&mut parts, &mut metadata, "stream", 1, &answer),
        ""
    );
    let durable = durable_items_json(&parts.parts, &metadata);
    assert_eq!(durable.len(), 2);
    assert_eq!(durable[0]["text"], "Working");
    assert!(
        durable[0]["providerMetadata"]["rigNative"]["content"][0]
            .get("text")
            .is_none()
    );
    assert_eq!(
        durable[0]["providerMetadata"]["rigNative"]["phase"],
        "commentary"
    );
    assert_eq!(durable[1]["text"], "Done");
    assert_eq!(
        durable[1]["providerMetadata"]["rigNative"]["phase"],
        "final_answer"
    );

    let part = serde_json::from_value(serde_json::json!({
        "number": 0, "sourceKey": "completion", "kind": "completion", "runId": "run",
        "completion": {"streamId": "stream", "items": durable}
    }))
    .unwrap();
    let history =
        crate::types::deserialize_agent_history(crate::history::agent_history_from_parts(
            &sprocket_transcript::TranscriptState::new("user".into(), "thread".into()),
            &[part],
            None,
        ))
        .unwrap();
    let rig::message::Message::Assistant(message) = &history[0] else {
        panic!("expected assistant text");
    };
    assert_eq!(
        message.content,
        vec![
            rig::message::AssistantContent::Text(commentary),
            rig::message::AssistantContent::Text(answer),
        ]
    );
}

#[test]
fn persisted_tool_turn_reloads_native_identity_and_replay_metadata() {
    use rig::message::{AssistantContent, ToolCall, ToolFunction, UserContent};
    use serde_json::json;

    let call = ToolCall::from_wire(
        "call_1",
        ToolFunction::new("exec_cmd".try_into().unwrap(), json!({"cmd": "pwd"})),
    );
    let AssistantContent::ToolCall(call) = AssistantContent::ToolCall(call).with_native(json!({
        "type": "function_call", "id": "fc_1", "call_id": "call_1",
        "name": "exec_cmd", "arguments": "{\"cmd\": \"pwd\"}", "futureField": "opaque"
    })) else {
        unreachable!();
    };
    let mut parts = LiveAssistantParts::default();
    let mut metadata = HashMap::new();
    apply_completed_tool_call(
        &mut parts,
        &mut metadata,
        "stream",
        Some("stream:tool:0".into()),
        call.clone(),
    );
    let durable = durable_items_json(&parts.parts, &metadata);
    assert_eq!(durable[0]["callId"], "call_1");
    assert_eq!(
        durable[0]["providerMetadata"]["rigNative"]["arguments"],
        "{\"cmd\": \"pwd\"}"
    );

    let transcript = serde_json::from_value::<Vec<sprocket_transcript::TranscriptPart>>(json!([
        {
            "number": 0, "sourceKey": "completion", "kind": "completion", "runId": "run",
            "completion": {"streamId": "stream", "items": durable}
        },
        {
            "number": 1, "sourceKey": "tool", "kind": "tool", "runId": "run",
            "tool": {"callId": "call_1", "name": "exec_cmd", "status": "completed", "output": "/workspace"}
        }
    ])).unwrap();
    let history = crate::history::agent_history_from_parts(
        &sprocket_transcript::TranscriptState::new("user".into(), "thread".into()),
        &transcript,
        None,
    );
    let messages = crate::types::deserialize_agent_history(history).unwrap();
    let rig::message::Message::Assistant(message) = &messages[0] else {
        panic!("expected assistant call");
    };
    assert_eq!(
        message.content,
        vec![AssistantContent::ToolCall(call.clone())]
    );
    let rig::message::Message::User { content } = &messages[1] else {
        panic!("expected tool result");
    };
    let UserContent::ToolResult(result) = &content[0] else {
        panic!("expected tool result content");
    };
    assert_eq!(result.call, call.id);
    assert_eq!(result.name, call.function.name);
}

#[test]
fn edited_calls_reload_the_edited_fields_without_stale_native_data() {
    use rig::message::{AssistantContent, ToolCall, ToolFunction};
    use serde_json::json;
    let AssistantContent::ToolCall(mut call) = AssistantContent::ToolCall(ToolCall::from_wire(
        "call_edited",
        ToolFunction::new("old_tool".try_into().unwrap(), json!({"old": true})),
    ))
    .with_native(json!({
        "type": "function_call", "id": "fc_old", "call_id": "call_edited",
        "name": "old_tool", "arguments": "{\"old\":true}", "secret": "stale"
    })) else {
        unreachable!()
    };
    call.function = ToolFunction::new("new_tool".try_into().unwrap(), json!({"new": true}));
    let mut parts = LiveAssistantParts::default();
    let mut metadata = HashMap::new();
    apply_completed_tool_call(&mut parts, &mut metadata, "stream", None, call);
    let items = durable_items_json(&parts.parts, &metadata);
    assert!(items[0]["providerMetadata"]["rigNative"].is_null());
    let part = serde_json::from_value(json!({
        "number": 0, "sourceKey": "completion", "kind": "completion", "runId": "run",
        "completion": {"items": items}
    }))
    .unwrap();
    let messages =
        crate::types::deserialize_agent_history(crate::history::agent_history_from_parts(
            &sprocket_transcript::TranscriptState::new("user".into(), "thread".into()),
            &[part],
            None,
        ))
        .unwrap();
    let rig::message::Message::Assistant(message) = &messages[0] else {
        unreachable!()
    };
    let AssistantContent::ToolCall(call) = &message.content[0] else {
        unreachable!()
    };
    assert_eq!(call.function.name, "new_tool");
    assert_eq!(call.function.arguments_value(), json!({"new": true}));
    assert!(call.native.as_ref().unwrap().item.get("secret").is_none());
}

fn coded_convex_error(code: &str) -> anyhow::Error {
    let data = [("code", code), ("message", "Convex failure.")]
        .into_iter()
        .map(|(key, value)| (key.to_string(), value.into()))
        .collect();
    sprocket_convex::decode_function_result::<()>(
        convex::FunctionResult::ConvexError(convex::ConvexError {
            message: String::new(),
            data: convex::Value::Object(data),
        }),
        "agentRuntime:registerCompletionAttempt",
    )
    .unwrap_err()
    .context("completion provider failed")
}

#[test]
fn classifies_superseded_completion_without_treating_it_as_failure() {
    assert_eq!(
        classify_provider_error(&coded_convex_error("COMPLETION_STREAM_SUPERSEDED")),
        ProviderErrorDisposition::Superseded
    );
}

#[test]
fn classifies_ended_runs_as_cancellation() {
    for error in [
        coded_convex_error("RUN_CANCELLED"),
        coded_convex_error("RUN_NO_LONGER_ACTIVE"),
        anyhow::Error::new(RunNoLongerActive),
    ] {
        assert_eq!(
            classify_provider_error(&error),
            ProviderErrorDisposition::Cancelled
        );
    }
    assert_eq!(
        classify_provider_error(&coded_convex_error("MACHINE_NOT_ACTIVE")),
        ProviderErrorDisposition::Failed
    );
}

fn reasoning_envelope() -> serde_json::Value {
    serde_json::json!({
        "openai": {
            "itemId": "rs_1",
            "reasoningEncryptedContent": "envelope"
        }
    })
}
