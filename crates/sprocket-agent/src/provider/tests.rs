use std::collections::HashMap;

use super::{
    ProviderErrorDisposition, RUN_NO_LONGER_ACTIVE, apply_completed_text, classify_provider_error,
    durable_items_json, visible_live_parts,
};
use sprocket_transcript::LiveAssistantPart;

#[test]
fn generation_options_keep_gateway_fast_tier_separate() {
    let (options, params) = super::completion_parameters("xhigh", true).unwrap();
    assert_eq!(
        options.reasoning,
        Some(rig::completion::Effort::XHigh.into())
    );
    assert_eq!(params, serde_json::json!({ "service_tier": "fast" }));
    let (options, params) = super::completion_parameters("none", false).unwrap();
    assert_eq!(options.reasoning, Some(rig::completion::Reasoning::Off));
    assert_eq!(params, serde_json::json!({}));
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
    let mut parts = super::LiveAssistantParts::default();
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
    let mut parts = super::LiveAssistantParts::default();
    let mut metadata = HashMap::new();
    super::apply_completed_tool_call(
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
    let mut parts = super::LiveAssistantParts::default();
    let mut metadata = HashMap::new();
    super::apply_completed_tool_call(&mut parts, &mut metadata, "stream", None, call);
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

#[test]
fn classifies_superseded_completion_without_treating_it_as_failure() {
    let error =
        anyhow::anyhow!("completion provider failed: SPROCKET_COMPLETION_STREAM_SUPERSEDED");

    assert_eq!(
        classify_provider_error(&error),
        ProviderErrorDisposition::Superseded
    );
}

#[test]
fn classifies_stopped_workspace_tool_as_cancellation() {
    let error = anyhow::anyhow!("tool execution failed: {RUN_NO_LONGER_ACTIVE}");

    assert_eq!(
        classify_provider_error(&error),
        ProviderErrorDisposition::Cancelled
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
