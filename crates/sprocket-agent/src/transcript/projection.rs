use std::collections::{HashMap, HashSet};

use serde_json::Value as JsonValue;

use super::types::{
    TranscriptMessage, TranscriptPart, TranscriptPartKind, TranscriptPartRecord,
    UNKNOWN_RUN_STARTED_AT,
};

pub(super) fn project_messages(
    user_id: &str,
    thread_id: &str,
    mut parts: Vec<TranscriptPart>,
    include_details: bool,
) -> Vec<TranscriptMessage> {
    parts.sort_by_key(|part| part.number);
    let mut messages = Vec::new();
    let mut applied_terminal_tools = HashSet::new();
    for part in parts {
        match part.kind {
            TranscriptPartKind::Prompt => {
                if let Some(prompt) = part.prompt {
                    messages.push(TranscriptMessage {
                        id: format!("prompt:{}", part.run_id),
                        thread_id: thread_id.to_string(),
                        run_id: part.run_id,
                        user_id: user_id.to_string(),
                        message_type: "prompt".to_string(),
                        text: prompt.text,
                        attachments: prompt.image_uploads,
                        parts: Vec::new(),
                        run_status: "completed".to_string(),
                        run_started_at: UNKNOWN_RUN_STARTED_AT,
                        source_numbers: vec![part.number],
                        stream_ids: Vec::new(),
                        details_loaded: true,
                    });
                }
            }
            TranscriptPartKind::Completion | TranscriptPartKind::Tool => {
                let response_id = format!("response:{}", part.run_id);
                let response = match messages.last_mut() {
                    Some(message) if message.id == response_id => message,
                    _ => {
                        messages.push(TranscriptMessage {
                            id: response_id,
                            thread_id: thread_id.to_string(),
                            run_id: part.run_id.clone(),
                            user_id: user_id.to_string(),
                            message_type: "response".to_string(),
                            text: String::new(),
                            attachments: Vec::new(),
                            parts: Vec::new(),
                            run_status: "completed".to_string(),
                            run_started_at: UNKNOWN_RUN_STARTED_AT,
                            source_numbers: Vec::new(),
                            stream_ids: Vec::new(),
                            details_loaded: include_details,
                        });
                        messages.last_mut().expect("message was just pushed")
                    }
                };
                response.source_numbers.push(part.number);
                if let Some(completion) = part.completion {
                    if let Some(stream_id) = completion.stream_id {
                        response.stream_ids.push(stream_id);
                    }
                    // Tool events can be persisted before the completion that ordered their calls.
                    let call_ids = completion
                        .items
                        .iter()
                        .filter_map(|item| {
                            (json_type(item) == Some("tool-call")).then(|| json_call_id(item))
                        })
                        .flatten()
                        .collect::<HashSet<_>>();
                    let mut results = HashMap::new();
                    let mut placeholder_calls = HashMap::new();
                    response.parts.retain(|item| {
                        let Some(call_id) = json_call_id(item) else {
                            return true;
                        };
                        if !call_ids.contains(call_id) {
                            return true;
                        }
                        match json_type(item) {
                            Some("tool-call") => {
                                placeholder_calls.insert(call_id.to_string(), item.clone());
                                false
                            }
                            Some("tool-result") => {
                                results.insert(call_id.to_string(), item.clone());
                                false
                            }
                            _ => true,
                        }
                    });
                    for item in &completion.items {
                        if json_type(item) == Some("tool-result") {
                            if let Some(call_id) = json_call_id(item) {
                                results.remove(call_id);
                            }
                        }
                    }
                    for mut item in completion.items {
                        // Released UIs understand omitted timestamps, but not explicit nulls.
                        if let Some(object) = item.as_object_mut() {
                            object.remove("providerMetadata");
                            for key in ["startedAt", "completedAt"] {
                                if object.get(key).is_some_and(JsonValue::is_null) {
                                    object.remove(key);
                                }
                            }
                        }
                        match json_type(&item) {
                            Some("text") => {
                                if let Some(text) = item.get("text").and_then(JsonValue::as_str) {
                                    response.text.push_str(text);
                                }
                            }
                            Some("reasoning") => {
                                if item
                                    .get("text")
                                    .and_then(JsonValue::as_str)
                                    .is_none_or(|text| text.trim().is_empty())
                                {
                                    continue;
                                }
                                if let Some(object) = item.as_object_mut() {
                                    if !include_details {
                                        object.insert(
                                            "text".to_string(),
                                            JsonValue::String(String::new()),
                                        );
                                    }
                                }
                            }
                            Some("tool-call") if !include_details => {
                                if let Some(object) = item.as_object_mut() {
                                    object.insert("input".to_string(), JsonValue::Null);
                                }
                            }
                            Some("tool-result") if !include_details => {
                                if let Some(object) = item.as_object_mut() {
                                    let output = object.remove("output").unwrap_or(JsonValue::Null);
                                    object
                                        .insert("output".to_string(), tool_output_summary(output));
                                }
                            }
                            _ => {}
                        }
                        if json_type(&item) == Some("tool-call") {
                            if let Some(call_id) = json_call_id(&item) {
                                if let Some(placeholder) = placeholder_calls.get(call_id) {
                                    copy_missing_timing(&mut item, placeholder);
                                }
                            }
                        }
                        let result =
                            json_call_id(&item).and_then(|call_id| results.remove(call_id));
                        response.parts.push(item);
                        if let Some(result) = result {
                            response.parts.push(result);
                        }
                    }
                }
                let created_at = part.created_at;
                if let Some(tool) = part.tool {
                    let existing_call = response
                        .parts
                        .iter_mut()
                        .find(|item| is_typed_call(item, "tool-call", &tool.call_id));
                    let started_at = created_at.filter(|_| tool.status == "started");
                    if let Some(call) = existing_call {
                        if call.get("startedAt").is_none() {
                            if let Some(object) = call.as_object_mut() {
                                insert_ms(object, "startedAt", started_at);
                            }
                        }
                    } else {
                        response.parts.push(tool_call_placeholder(
                            &tool.call_id,
                            &tool.name,
                            if include_details {
                                serde_json::json!({})
                            } else {
                                JsonValue::Null
                            },
                            started_at,
                        ));
                    }
                    let terminal_key = tool
                        .tool_invocation_id
                        .as_deref()
                        .or(tool.job_id.as_deref())
                        .unwrap_or(tool.call_id.as_str());
                    if tool.status != "started"
                        && applied_terminal_tools.insert(terminal_key.to_string())
                    {
                        let mut result = serde_json::json!({
                            "type": "tool-result", "callId": tool.call_id, "name": tool.name
                        });
                        let object = result.as_object_mut().expect("object");
                        let output = tool.output.unwrap_or(JsonValue::Null);
                        object.insert(
                            "output".to_string(),
                            if include_details {
                                output
                            } else {
                                tool_output_summary(output)
                            },
                        );
                        insert_ms(object, "completedAt", created_at);
                        if let Some(index) = response
                            .parts
                            .iter()
                            .position(|item| is_typed_call(item, "tool-result", &tool.call_id))
                        {
                            response.parts[index] = result;
                        } else if let Some(index) = response
                            .parts
                            .iter()
                            .position(|item| is_typed_call(item, "tool-call", &tool.call_id))
                        {
                            response.parts.insert(index + 1, result);
                        } else {
                            response.parts.push(result);
                        }
                    }
                }
            }
        }
    }
    messages
}

pub(super) fn project_part(
    user_id: &str,
    thread_id: &str,
    part: TranscriptPart,
    include_details: bool,
) -> TranscriptPartRecord {
    let number = part.number;
    let kind = part.kind;
    let mut messages = project_messages(user_id, thread_id, vec![part], include_details);
    debug_assert!(
        messages.len() <= 1,
        "a single transcript part should project to at most one message"
    );
    TranscriptPartRecord {
        number,
        kind,
        message: messages.pop(),
    }
}

fn json_str<'a>(item: &'a JsonValue, key: &str) -> Option<&'a str> {
    item.get(key).and_then(JsonValue::as_str)
}

fn json_type(item: &JsonValue) -> Option<&str> {
    json_str(item, "type")
}

fn json_call_id(item: &JsonValue) -> Option<&str> {
    json_str(item, "callId")
}

fn is_typed_call(item: &JsonValue, type_name: &str, call_id: &str) -> bool {
    json_type(item) == Some(type_name) && json_call_id(item) == Some(call_id)
}

fn insert_ms(object: &mut serde_json::Map<String, JsonValue>, key: &str, value: Option<u64>) {
    if let Some(ms) = value {
        object.insert(key.to_string(), JsonValue::from(ms));
    }
}

fn copy_missing_timing(target: &mut JsonValue, source: &JsonValue) {
    let Some(object) = target.as_object_mut() else {
        return;
    };
    for key in ["startedAt", "completedAt"] {
        if object.get(key).is_none() {
            if let Some(value) = source.get(key) {
                object.insert(key.to_string(), value.clone());
            }
        }
    }
}

fn tool_call_placeholder(
    call_id: &str,
    name: &str,
    input: JsonValue,
    started_at: Option<u64>,
) -> JsonValue {
    let mut call = serde_json::json!({
        "type": "tool-call",
        "callId": call_id,
        "name": name,
        "input": input
    });
    if let Some(object) = call.as_object_mut() {
        insert_ms(object, "startedAt", started_at);
    }
    call
}

fn tool_output_summary(output: JsonValue) -> JsonValue {
    let JsonValue::Object(mut object) = output else {
        return JsonValue::Null;
    };
    object.retain(|key, _| {
        matches!(
            key.as_str(),
            "status"
                | "error"
                | "sessionId"
                | "running"
                | "command"
                | "exitCode"
                | "mandateId"
                | "approvalUrl"
        )
    });
    JsonValue::Object(object)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transcript::types::{
        TranscriptCompletionBody, TranscriptPromptBody, TranscriptToolBody,
    };

    fn prompt(number: u32, text: &str) -> TranscriptPart {
        TranscriptPart {
            number,
            source_key: format!("prompt:{number}"),
            kind: TranscriptPartKind::Prompt,
            run_id: format!("run-{number}"),
            created_at: None,
            prompt: Some(TranscriptPromptBody {
                text: text.to_string(),
                image_uploads: Vec::new(),
            }),
            completion: None,
            tool: None,
        }
    }

    fn completion(number: u32) -> TranscriptPart {
        TranscriptPart {
            number,
            source_key: format!("completion:{number}"),
            kind: TranscriptPartKind::Completion,
            run_id: "run-1".to_string(),
            created_at: None,
            prompt: None,
            completion: Some(TranscriptCompletionBody {
                stream_id: Some("stream-1".to_string()),
                items: vec![
                    serde_json::json!({ "type": "reasoning", "id": "r1", "text": "secret" }),
                    serde_json::json!({ "type": "tool-call", "callId": "c1", "name": "exec_command", "input": { "cmd": "pwd" } }),
                    serde_json::json!({ "type": "tool-result", "callId": "c1", "name": "exec_command", "output": "secret output" }),
                    serde_json::json!({ "type": "text", "id": "t1", "text": "answer" }),
                ],
            }),
            tool: None,
        }
    }

    fn completion_for_run(number: u32, run_id: &str, text: &str) -> TranscriptPart {
        TranscriptPart {
            number,
            source_key: format!("completion:{number}"),
            kind: TranscriptPartKind::Completion,
            run_id: run_id.to_string(),
            created_at: None,
            prompt: None,
            completion: Some(TranscriptCompletionBody {
                stream_id: Some(format!("stream-{number}")),
                items: vec![
                    serde_json::json!({ "type": "text", "id": format!("t-{number}"), "text": text }),
                ],
            }),
            tool: None,
        }
    }

    #[test]
    fn projection_omits_disclosure_payloads_until_requested() {
        let mut part = completion(0);
        let reasoning = &mut part.completion.as_mut().unwrap().items[0];
        reasoning["startedAt"] = serde_json::json!(1_000);
        reasoning["completedAt"] = serde_json::json!(2_000);
        let summary = project_messages("user", "thread", vec![part.clone()], false);
        assert_eq!(summary[0].text, "answer");
        assert_eq!(summary[0].parts[0]["text"], "");
        assert_eq!(summary[0].parts[0]["startedAt"], 1_000);
        assert_eq!(summary[0].parts[0]["completedAt"], 2_000);
        assert!(summary[0].parts[1]["input"].is_null());
        assert!(summary[0].parts[2]["output"].is_null());
        assert!(!summary[0].details_loaded);

        let details = project_messages("user", "thread", vec![part], true);
        assert_eq!(details[0].parts[0]["text"], "secret");
        assert_eq!(details[0].parts[0]["startedAt"], 1_000);
        assert_eq!(details[0].parts[0]["completedAt"], 2_000);
        assert_eq!(details[0].parts[1]["input"]["cmd"], "pwd");
        assert_eq!(details[0].parts[2]["output"], "secret output");
        assert!(details[0].details_loaded);
    }

    #[test]
    fn projections_strip_all_completion_metadata_without_changing_replay_items() {
        let metadata = serde_json::json!({
            "openai": { "itemId": "provider-item", "reasoningEncryptedContent": "opaque" }
        });
        let mut part = completion(0);
        let items = vec![
            serde_json::json!({
                "type": "text", "id": "t", "text": "answer", "startedAt": 10,
                "completedAt": 20, "providerMetadata": metadata
            }),
            serde_json::json!({
                "type": "tool-call", "callId": "c", "name": "read", "input": {},
                "providerMetadata": metadata
            }),
            serde_json::json!({
                "type": "tool-result", "callId": "c", "name": "read", "output": "ok",
                "providerMetadata": metadata
            }),
        ];
        part.completion.as_mut().unwrap().items = items.clone();

        for include_details in [false, true] {
            let messages = project_messages("user", "thread", vec![part.clone()], include_details);
            assert_eq!(messages[0].text, "answer");
            assert_eq!(messages[0].parts.len(), 3);
            assert_eq!(messages[0].parts[0]["startedAt"], 10);
            assert_eq!(messages[0].parts[0]["completedAt"], 20);
            for item in &messages[0].parts {
                assert!(item.get("providerMetadata").is_none());
            }
            let rendered = serde_json::to_string(&messages).unwrap();
            assert!(!rendered.contains("provider-item"));
            assert!(!rendered.contains("opaque"));
        }
        assert_eq!(part.completion.unwrap().items, items);
    }

    #[test]
    fn detailed_projection_keeps_reasoning_summary_and_drops_ciphertext() {
        const ENVELOPE: &str = "opaque-envelope-bytes";
        let mut part = completion(0);
        part.completion.as_mut().unwrap().items[0] = serde_json::json!({
            "type": "reasoning",
            "id": "r1",
            "text": "visible plan",
            "turnId": "stream-1",
            "providerMetadata": {
                "openai": {
                    "itemId": "rs_123",
                    "reasoningEncryptedContent": ENVELOPE
                }
            }
        });

        let summary = project_messages("user", "thread", vec![part.clone()], false);
        let details = project_messages("user", "thread", vec![part.clone()], true);

        assert_eq!(summary[0].text, "answer");
        assert_eq!(details[0].text, "answer");
        assert_eq!(summary[0].parts[0]["text"], "");
        assert_eq!(details[0].parts[0]["text"], "visible plan");
        assert_eq!(details[0].parts[0]["id"], "r1");
        assert_eq!(details[0].parts[0]["turnId"], "stream-1");

        for message in [&summary[0], &details[0]] {
            assert!(message.parts[0].get("providerMetadata").is_none());
            let rendered = serde_json::to_string(message).unwrap();
            assert!(
                !rendered.contains(ENVELOPE),
                "renderer projection leaked ciphertext: {rendered}"
            );
            assert!(!rendered.contains("reasoningEncryptedContent"));
            assert!(!rendered.contains("rs_123"));
        }

        assert_eq!(
            part.completion.as_ref().unwrap().items[0]["providerMetadata"]["openai"]["reasoningEncryptedContent"],
            ENVELOPE
        );
    }

    #[test]
    fn lightweight_projection_keeps_only_reasoning_with_a_summary_to_load() {
        let mut part = completion(0);
        part.completion.as_mut().unwrap().items = vec![
            serde_json::json!({ "type": "reasoning", "id": "empty", "text": "" }),
            serde_json::json!({ "type": "reasoning", "id": "blank", "text": " \n" }),
            serde_json::json!({ "type": "reasoning", "id": "visible", "text": "plan" }),
            serde_json::json!({ "type": "text", "id": "answer", "text": "done" }),
        ];

        let messages = project_messages("user", "thread", vec![part], false);
        assert_eq!(messages[0].parts.len(), 2);
        assert_eq!(messages[0].parts[0]["id"], "visible");
        assert_eq!(messages[0].parts[0]["text"], "");
        assert!(!messages[0].details_loaded);
    }

    #[test]
    fn completion_order_replaces_early_tool_placeholders() {
        let tool = |number, call_id: &str, status: &str, created_at: Option<u64>| TranscriptPart {
            number,
            source_key: format!("tool:{number}"),
            kind: TranscriptPartKind::Tool,
            run_id: "run-1".to_string(),
            created_at,
            prompt: None,
            completion: None,
            tool: Some(TranscriptToolBody {
                job_id: None,
                tool_invocation_id: None,
                call_id: call_id.to_string(),
                name: "exec_command".to_string(),
                output: Some(serde_json::json!({"status": "completed", "output": "done"})),
                status: status.to_string(),
            }),
        };
        let mut turn = completion(4);
        turn.completion.as_mut().unwrap().items = vec![
            serde_json::json!({"type": "reasoning", "id": "r", "text": "plan"}),
            serde_json::json!({"type": "text", "id": "t", "text": "checking"}),
            serde_json::json!({"type": "tool-call", "callId": "a", "name": "exec_command", "input": {}}),
            serde_json::json!({"type": "tool-call", "callId": "b", "name": "exec_command", "input": {}, "startedAt": null, "completedAt": null}),
        ];
        for include_details in [false, true] {
            let messages = project_messages(
                "user",
                "thread",
                vec![
                    completion_for_run(0, "run-1", "previous turn"),
                    tool(1, "b", "started", Some(1_100)),
                    tool(2, "a", "started", Some(1_200)),
                    tool(3, "a", "completed", Some(1_800)),
                    turn.clone(),
                    tool(5, "b", "completed", Some(2_400)),
                    completion_for_run(6, "run-1", "answer"),
                ],
                include_details,
            );
            let parts = &messages[0].parts;
            assert_eq!(
                parts
                    .iter()
                    .map(|part| part["type"].as_str().unwrap())
                    .collect::<Vec<_>>(),
                [
                    "text",
                    "reasoning",
                    "text",
                    "tool-call",
                    "tool-result",
                    "tool-call",
                    "tool-result",
                    "text"
                ]
            );
            assert_eq!(parts[3]["callId"], "a");
            assert_eq!(parts[4]["callId"], "a");
            assert_eq!(parts[5]["callId"], "b");
            assert_eq!(parts[6]["callId"], "b");
            assert_eq!(parts[4]["output"]["status"], "completed");
            assert_eq!(parts[1]["text"], if include_details { "plan" } else { "" });
            assert_eq!(parts[1].get("startedAt"), None);
            assert_eq!(parts[3]["startedAt"], 1_200);
            assert_eq!(parts[4]["completedAt"], 1_800);
            assert_eq!(parts[5]["startedAt"], 1_100);
            assert_eq!(parts[6]["completedAt"], 2_400);
        }
    }

    #[test]
    fn projected_messages_use_unknown_run_start_instead_of_sequence() {
        let messages = project_messages("user", "thread", vec![prompt(7, "hi")], true);
        assert_eq!(messages[0].run_started_at, UNKNOWN_RUN_STARTED_AT);
        assert_eq!(messages[0].source_numbers, vec![7]);
    }

    #[test]
    fn finished_tool_without_start_does_not_invent_zero_duration() {
        let part = TranscriptPart {
            number: 1,
            source_key: "tool:finished".into(),
            kind: TranscriptPartKind::Tool,
            run_id: "run-1".into(),
            created_at: Some(5_000),
            prompt: None,
            completion: None,
            tool: Some(TranscriptToolBody {
                job_id: None,
                tool_invocation_id: None,
                call_id: "c1".into(),
                name: "exec_command".into(),
                output: None,
                status: "completed".into(),
            }),
        };
        let messages = project_messages("user", "thread", vec![part], false);
        assert!(messages[0].parts[0].get("startedAt").is_none());
        assert_eq!(messages[0].parts[1]["completedAt"], 5_000);
    }

    #[test]
    fn does_not_fabricate_reasoning_timing_from_part_created_at() {
        let mut part = completion(4);
        part.created_at = Some(9_000);
        let messages = project_messages("user", "thread", vec![part], true);
        assert!(messages[0].parts[0].get("startedAt").is_none());
        assert!(messages[0].parts[0].get("completedAt").is_none());
        assert_eq!(messages[0].run_started_at, UNKNOWN_RUN_STARTED_AT);
    }

    #[test]
    fn migrated_null_timing_projects_as_missing_for_released_clients() {
        let mut part = completion(4);
        for item in &mut part.completion.as_mut().unwrap().items {
            item["startedAt"] = JsonValue::Null;
            item["completedAt"] = JsonValue::Null;
        }
        for include_details in [false, true] {
            let messages = project_messages("user", "thread", vec![part.clone()], include_details);
            for item in &messages[0].parts {
                assert!(item.get("startedAt").is_none());
                assert!(item.get("completedAt").is_none());
            }
        }
    }

    #[test]
    fn completion_tool_call_keeps_its_own_start_over_placeholder() {
        let tool = TranscriptPart {
            number: 1,
            source_key: "tool:1".into(),
            kind: TranscriptPartKind::Tool,
            run_id: "run-1".into(),
            created_at: Some(500),
            prompt: None,
            completion: None,
            tool: Some(TranscriptToolBody {
                job_id: None,
                tool_invocation_id: None,
                call_id: "c1".into(),
                name: "exec_command".into(),
                output: None,
                status: "started".into(),
            }),
        };
        let turn = TranscriptPart {
            number: 2,
            source_key: "completion:2".into(),
            kind: TranscriptPartKind::Completion,
            run_id: "run-1".into(),
            created_at: Some(900),
            prompt: None,
            completion: Some(TranscriptCompletionBody {
                stream_id: Some("s".into()),
                items: vec![serde_json::json!({
                    "type": "tool-call",
                    "callId": "c1",
                    "name": "exec_command",
                    "input": {},
                    "startedAt": 700
                })],
            }),
            tool: None,
        };
        let messages = project_messages("user", "thread", vec![tool, turn], true);
        assert_eq!(messages[0].parts[0]["startedAt"], 700);
    }

    #[test]
    fn lightweight_tools_keep_terminal_state_sessions_and_approvals() {
        let mut part = completion(0);
        part.completion.as_mut().unwrap().items[2]["output"] = serde_json::json!({
            "sessionId": "session", "running": true, "command": "sleep 10",
            "status": "failed", "error": "failure", "output": "large log",
            "mandateId": "mandate", "approvalUrl": "https://example.com/approve"
        });
        let messages = project_messages("user", "thread", vec![part], false);
        let output = &messages[0].parts[2]["output"];
        assert_eq!(output["running"], true);
        assert_eq!(output["sessionId"], "session");
        assert_eq!(output["error"], "failure");
        assert_eq!(output["approvalUrl"], "https://example.com/approve");
        assert!(output.get("output").is_none());
    }
}
