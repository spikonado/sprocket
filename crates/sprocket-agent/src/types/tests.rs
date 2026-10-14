use rig::completion::Message;
use rig::message::{AssistantContent, DocumentSourceKind, ImageMediaType, UserContent};

use super::{
    AgentHistoryContent, AgentHistoryMessage, AgentHistoryRole, AgentHistoryToolResultItem,
    deserialize_agent_history,
};

#[test]
fn legacy_origin_fallback_preserves_known_origins() {
    let original = rig::message::Origin::new("openai.responses", "openai", "old-model");
    let history = serde_json::from_value(serde_json::json!([
        {
            "role": "assistant", "origin": original, "contents": [{
                "type": "reasoning", "summary": "",
                "nativeItem": {"type": "reasoning", "id": "rs_1", "summary": []}
            }]
        },
        {"role": "assistant", "contents": [{"type": "text", "text": "legacy"}]}
    ]))
    .unwrap();
    let mut messages = deserialize_agent_history(history).unwrap();
    let selected = rig::message::Origin::new("openai.responses", "openai", "selected-model");
    super::assign_unidentified_legacy_history_origin(&mut messages, &selected);
    let Message::Assistant(first) = &messages[0] else {
        panic!("expected assistant")
    };
    let Message::Assistant(second) = &messages[1] else {
        panic!("expected assistant")
    };
    assert_eq!(first.origin.as_ref(), Some(&original));
    assert_eq!(second.origin.as_ref(), Some(&selected));
}

#[test]
fn deserializes_tool_history_into_rig_messages_with_matching_ids() {
    let history = vec![
        AgentHistoryMessage {
            role: AgentHistoryRole::Assistant,
            origin: None,
            contents: vec![AgentHistoryContent::ToolCall {
                call_id: "call_1".to_string(),
                name: "exec_command".to_string(),
                arguments: serde_json::json!({"cmd": "cat src/lib.rs"}),
                native_item: None,
            }],
        },
        AgentHistoryMessage {
            role: AgentHistoryRole::User,
            origin: None,
            contents: vec![AgentHistoryContent::ToolResult {
                id: "tool_call_1".to_string(),
                call_id: Some("call_1".to_string()),
                items: vec![AgentHistoryToolResultItem::Text {
                    text: "{\"ok\":true}".to_string(),
                }],
            }],
        },
    ];

    let messages = deserialize_agent_history(history).expect("messages");

    match &messages[0] {
        Message::Assistant(assistant) => match assistant.content.first() {
            Some(AssistantContent::ToolCall(tool_call)) => {
                assert_eq!(tool_call.id.wire(), "call_1");
                assert_eq!(
                    tool_call.id.provider().map(|id| id.as_str()),
                    Some("call_1")
                );
            }
            other => panic!("expected assistant tool call, got {other:?}"),
        },
        other => panic!("expected assistant message, got {other:?}"),
    }

    match &messages[1] {
        Message::User { content } => match content.iter().next() {
            Some(UserContent::ToolResult(tool_result)) => {
                assert_eq!(tool_result.call.wire(), "call_1");
                assert_eq!(tool_result.name, "exec_command");
                assert_eq!(
                    tool_result.call.provider().map(|id| id.as_str()),
                    Some("call_1")
                );
            }
            other => panic!("expected user tool result, got {other:?}"),
        },
        other => panic!("expected user message, got {other:?}"),
    }
}

#[test]
fn resolves_tool_result_name_from_call_id_when_result_id_differs() {
    let history = vec![
        AgentHistoryMessage {
            role: AgentHistoryRole::Assistant,
            origin: None,
            contents: vec![AgentHistoryContent::ToolCall {
                call_id: "call_1".to_string(),
                name: "exec_command".to_string(),
                arguments: serde_json::json!({"cmd": "pwd"}),
                native_item: None,
            }],
        },
        AgentHistoryMessage {
            role: AgentHistoryRole::User,
            origin: None,
            contents: vec![AgentHistoryContent::ToolResult {
                id: "fr_1".to_string(),
                call_id: Some("call_1".to_string()),
                items: vec![AgentHistoryToolResultItem::Text {
                    text: "ok".to_string(),
                }],
            }],
        },
    ];

    let messages = deserialize_agent_history(history).expect("messages");
    match &messages[1] {
        Message::User { content } => match content.iter().next() {
            Some(UserContent::ToolResult(tool_result)) => {
                assert_eq!(tool_result.name, "exec_command");
                assert_eq!(tool_result.call.wire(), "call_1");
                assert_eq!(
                    tool_result.call.provider().map(|id| id.as_str()),
                    Some("call_1")
                );
            }
            other => panic!("expected user tool result, got {other:?}"),
        },
        other => panic!("expected user message, got {other:?}"),
    }
}

#[test]
fn mints_one_identity_for_an_empty_tool_call_and_its_result() {
    let history = serde_json::from_value(serde_json::json!([
        {
            "role": "assistant",
            "contents": [{
                "type": "toolCall", "callId": "",
                "name": "exec_command", "arguments": {}
            }]
        },
        {
            "role": "user",
            "contents": [{
                "type": "toolResult", "id": "", "callId": "",
                "items": [{"type": "text", "text": "ok"}]
            }]
        }
    ]))
    .unwrap();
    let messages = deserialize_agent_history(history).unwrap();
    let Message::Assistant(assistant) = &messages[0] else {
        panic!("expected assistant message");
    };
    let AssistantContent::ToolCall(call) = &assistant.content[0] else {
        panic!("expected tool call");
    };
    let Message::User { content } = &messages[1] else {
        panic!("expected user message");
    };
    let UserContent::ToolResult(result) = &content[0] else {
        panic!("expected tool result");
    };
    assert!(call.id.is_local());
    assert_eq!(call.id, result.call);
    assert_eq!(call.function.name, result.name);
}

#[test]
fn rejects_orphaned_tool_results_before_provider_replay() {
    let history = vec![AgentHistoryMessage {
        role: AgentHistoryRole::User,
        origin: None,
        contents: vec![AgentHistoryContent::ToolResult {
            id: "missing-call".to_string(),
            call_id: None,
            items: vec![AgentHistoryToolResultItem::Text {
                text: "output".to_string(),
            }],
        }],
    }];
    let error = deserialize_agent_history(history).unwrap_err();
    assert!(error.to_string().contains("no matching call: missing-call"));
}

#[test]
fn deserializes_create_run_response_gateway_fields_from_convex_numbers() {
    use super::CreateRunResponse;

    let created: CreateRunResponse = serde_json::from_value(serde_json::json!({
        "created": true,
        "runId": "jd7run",
        "threadId": "jd7thread",
        "userId": "user_1",
        "promptPart": {
            "number": 0.0,
            "sourceKey": "prompt:jd7run",
            "kind": "prompt",
            "runId": "jd7run",
            "prompt": {
                "text": "hello",
                "imageUploads": [{
                    "name": "robot.png",
                    "mediaType": "image/png",
                    "size": 42.0,
                    "storageId": "storage_1",
                    "url": "https://example.com/robot.png"
                }]
            }
        },
        "gatewayUrl": "https://preview.gateway.example",
        "protocolVersion": 1.0
    }))
    .expect("create run response");

    assert_eq!(created.gateway_url, "https://preview.gateway.example");
    assert_eq!(created.protocol_version, 1);
    let prompt_part = created.prompt_part.expect("prompt transcript part");
    let parts = crate::transcript::parse_remote_parts(serde_json::json!({
        "parts": [prompt_part]
    }))
    .expect("prompt transcript part");
    assert_eq!(parts[0].number, 0);
    let attachment = &parts[0].prompt.as_ref().expect("prompt body").image_uploads[0];
    assert_eq!(attachment.name, "robot.png");
    assert_eq!(attachment.size, 42);
    assert_eq!(attachment.storage_id, "storage_1");
}

#[test]
fn context_handoff_budget_preserves_the_released_wire_field() {
    let budget: super::ContextBudget = serde_json::from_value(serde_json::json!({
        "contextWindowTokens": 272000.0,
        "autoCompactTokenLimit": 258000.0
    }))
    .expect("released context budget");

    assert_eq!(budget.auto_handoff_token_limit, 258000);
    assert_eq!(
        serde_json::to_value(budget).expect("serialized context budget"),
        serde_json::json!({
            "contextWindowTokens": 272000,
            "autoCompactTokenLimit": 258000
        })
    );
}

#[test]
fn deserializes_a_continuation_create_run_response_without_a_prompt() {
    use super::CreateRunResponse;

    let created: CreateRunResponse = serde_json::from_value(serde_json::json!({
        "created": true,
        "runId": "jd7cont",
        "threadId": "jd7thread",
        "userId": "user_1",
        "gatewayUrl": "https://preview.gateway.example",
        "protocolVersion": 1.0
    }))
    .expect("continuation create run response");

    assert_eq!(created.run_id, "jd7cont");
    assert!(created.prompt_part.is_none());
}

#[test]
fn deserializes_url_images_from_convex_history() {
    let image_json = serde_json::json!({
        "data": { "type": "url", "value": "https://example.com/robot.png" },
        "media_type": "png"
    })
    .to_string();
    let history = vec![AgentHistoryMessage {
        role: AgentHistoryRole::User,
        origin: None,
        contents: vec![AgentHistoryContent::Image { image_json }],
    }];

    let messages = deserialize_agent_history(history).expect("messages");
    let Message::User { content } = &messages[0] else {
        panic!("expected user message");
    };
    let Some(UserContent::Image(image)) = content.iter().next() else {
        panic!("expected user image");
    };
    assert_eq!(
        image.data,
        DocumentSourceKind::Url("https://example.com/robot.png".to_string())
    );
    assert_eq!(image.media_type, Some(ImageMediaType::PNG));
}
