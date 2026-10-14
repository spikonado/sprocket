use std::collections::{HashMap, HashSet};

use rig::completion::Message;
use rig::message::{AssistantContent, Origin};

use crate::context_handoff::context_summary_text;
use crate::reasoning::opaque_encrypted;
use crate::transcript::types::{TranscriptPart, TranscriptPartKind, TranscriptToolBody};
use crate::types::{
    AgentHistoryContent, AgentHistoryMessage, AgentHistoryRole, AgentHistoryToolResultItem,
};

use super::types::{TranscriptPromptBody, TranscriptState};

pub(crate) fn without_reasoning_traces(history: Vec<Message>) -> Vec<Message> {
    history
        .into_iter()
        .filter_map(|message| match message {
            Message::Assistant(mut assistant) => {
                assistant.content.retain(|part| {
                    !matches!(
                        part,
                        AssistantContent::Reasoning(_) | AssistantContent::Opaque(_)
                    )
                });
                for part in &mut assistant.content {
                    match part {
                        AssistantContent::ToolCall(call) => {
                            call.native = None;
                        }
                        AssistantContent::Text(text) => text.native = None,
                        _ => {}
                    }
                }
                assistant.origin = None;
                (!assistant.content.is_empty()).then_some(Message::Assistant(assistant))
            }
            other => Some(other),
        })
        .collect()
}

pub(crate) fn prompt_text_with_attachments(prompt: &TranscriptPromptBody) -> String {
    if prompt.image_uploads.is_empty() {
        return prompt.text.clone();
    }
    let attachments = prompt
        .image_uploads
        .iter()
        .map(|attachment| {
            serde_json::json!({
                "name": attachment.name,
                "mediaType": attachment.media_type,
                "path": attachment.local_path,
            })
        })
        .collect::<Vec<_>>();
    format!(
        "{}\n\nAttached files in the local transcript cache:\n{}",
        prompt.text,
        serde_json::json!(attachments)
    )
}

pub fn current_run_has_finished_turns(parts: &[TranscriptPart], run_id: &str) -> bool {
    parts
        .iter()
        .any(|part| part.run_id == run_id && part.kind == TranscriptPartKind::Completion)
}

fn completion_item_call_id(item: &serde_json::Value) -> Option<&str> {
    if item.get("type").and_then(|value| value.as_str()) != Some("tool-call") {
        return None;
    }
    item.get("callId").and_then(|value| value.as_str())
}

fn completion_call_ids(parts: &[TranscriptPart]) -> HashSet<&str> {
    let mut ids = HashSet::new();
    for part in parts {
        let Some(completion) = &part.completion else {
            continue;
        };
        for item in &completion.items {
            if let Some(call_id) = completion_item_call_id(item) {
                ids.insert(call_id);
            }
        }
    }
    ids
}

fn is_started_tool(tool: &TranscriptToolBody) -> bool {
    tool.status == "started"
}

fn tool_result_message(tool: &TranscriptToolBody) -> AgentHistoryMessage {
    let output = tool
        .output
        .as_ref()
        .unwrap_or(&serde_json::Value::Null)
        .to_string();
    AgentHistoryMessage {
        role: AgentHistoryRole::User,
        origin: None,
        contents: vec![AgentHistoryContent::ToolResult {
            id: tool.call_id.clone(),
            call_id: Some(tool.call_id.clone()),
            items: vec![AgentHistoryToolResultItem::Text { text: output }],
        }],
    }
}

fn take_matching_tool<'a>(
    tool: &'a TranscriptToolBody,
    protocol_call_ids: &HashSet<&str>,
    opened_call_ids: &HashSet<String>,
    emitted_results: &mut HashSet<String>,
    pending_tools: &mut HashMap<String, &'a TranscriptToolBody>,
) -> Option<&'a TranscriptToolBody> {
    if is_started_tool(tool) || !protocol_call_ids.contains(tool.call_id.as_str()) {
        return None;
    }
    if emitted_results.contains(&tool.call_id) {
        return None;
    }
    if opened_call_ids.contains(&tool.call_id) {
        emitted_results.insert(tool.call_id.clone());
        return Some(tool);
    }
    pending_tools.entry(tool.call_id.clone()).or_insert(tool);
    None
}

fn flush_pending_tools_for_completion(
    items: &[serde_json::Value],
    opened_call_ids: &mut HashSet<String>,
    emitted_results: &mut HashSet<String>,
    pending_tools: &mut HashMap<String, &TranscriptToolBody>,
    history: &mut Vec<AgentHistoryMessage>,
) {
    for item in items {
        let Some(call_id) = completion_item_call_id(item) else {
            continue;
        };
        opened_call_ids.insert(call_id.to_string());
        if emitted_results.contains(call_id) {
            continue;
        }
        let Some(tool) = pending_tools.remove(call_id) else {
            continue;
        };
        emitted_results.insert(call_id.to_string());
        history.push(tool_result_message(tool));
    }
}

pub fn agent_history_from_parts(
    state: &TranscriptState,
    parts: &[TranscriptPart],
    skip_run_id: Option<&str>,
) -> Vec<AgentHistoryMessage> {
    let include_current_prompt =
        skip_run_id.is_some_and(|run_id| current_run_has_finished_turns(parts, run_id));
    let protocol_call_ids = completion_call_ids(parts);
    let mut history = Vec::new();
    if let Some(summary) = state
        .context_summary
        .as_deref()
        .filter(|text| !text.is_empty())
    {
        history.push(AgentHistoryMessage {
            role: AgentHistoryRole::User,
            origin: None,
            contents: vec![AgentHistoryContent::Text {
                text: context_summary_text(summary),
                native_item: None,
            }],
        });
    }

    let mut opened_call_ids = HashSet::new();
    let mut emitted_results = HashSet::new();
    let mut pending_tools: HashMap<String, &TranscriptToolBody> = HashMap::new();

    for part in parts {
        if part.number < state.history_from_number {
            continue;
        }
        if skip_run_id.is_some_and(|run_id| part.run_id == run_id)
            && part.kind == TranscriptPartKind::Prompt
            && !include_current_prompt
        {
            continue;
        }
        match part.kind {
            TranscriptPartKind::Prompt => {
                if let Some(prompt) = &part.prompt {
                    let mut contents = Vec::new();
                    let text = prompt_text_with_attachments(prompt);
                    if !text.trim().is_empty() {
                        contents.push(AgentHistoryContent::Text {
                            text,
                            native_item: None,
                        });
                    }
                    if !contents.is_empty() {
                        history.push(AgentHistoryMessage {
                            role: AgentHistoryRole::User,
                            origin: None,
                            contents,
                        });
                    }
                }
            }
            TranscriptPartKind::Completion => {
                if let Some(completion) = &part.completion {
                    let omit_reasoning = state
                        .reasoning_stripped_through_part_number
                        .is_some_and(|cutoff| i64::from(part.number) <= cutoff);
                    let origin = completion
                        .items
                        .iter()
                        .filter(|_| !omit_reasoning)
                        .find_map(|item| {
                            serde_json::from_value::<Origin>(
                                item.get("providerMetadata")?.get("origin")?.clone(),
                            )
                            .ok()
                        });
                    let contents: Vec<_> = completion
                        .items
                        .iter()
                        .filter_map(|item| completion_item_to_history(item, omit_reasoning))
                        .collect();
                    if !contents.is_empty() {
                        history.push(AgentHistoryMessage {
                            role: AgentHistoryRole::Assistant,
                            origin,
                            contents,
                        });
                    }
                    flush_pending_tools_for_completion(
                        &completion.items,
                        &mut opened_call_ids,
                        &mut emitted_results,
                        &mut pending_tools,
                        &mut history,
                    );
                }
            }
            TranscriptPartKind::Tool => {
                if let Some(tool) = &part.tool {
                    if let Some(ready) = take_matching_tool(
                        tool,
                        &protocol_call_ids,
                        &opened_call_ids,
                        &mut emitted_results,
                        &mut pending_tools,
                    ) {
                        history.push(tool_result_message(ready));
                    }
                }
            }
        }
    }
    history
}

fn openai_field<'a>(item: &'a serde_json::Value, key: &str) -> Option<&'a serde_json::Value> {
    item.get("providerMetadata")?.get("openai")?.get(key)
}

fn non_empty_str<'a>(value: Option<&'a serde_json::Value>) -> Option<&'a str> {
    value?.as_str().filter(|value| !value.is_empty())
}

fn completion_item_to_history(
    item: &serde_json::Value,
    omit_reasoning: bool,
) -> Option<AgentHistoryContent> {
    let metadata = item.get("providerMetadata").filter(|_| !omit_reasoning);
    match item.get("type")?.as_str()? {
        "reasoning" if omit_reasoning => None,
        "text" => {
            let text = item.get("text")?.as_str()?;
            Some(AgentHistoryContent::Text {
                native_item: metadata.and_then(|metadata| text_native_item(text, metadata)),
                text: text.to_string(),
            })
        }
        "reasoning" => reasoning_history(item),
        "tool-call" => {
            let item_id = non_empty_str(openai_field(item, "itemId"));
            let call_id = non_empty_str(item.get("callId"))
                .or(item_id)
                .or_else(|| item.get("callId")?.as_str())?;
            let name = item.get("name")?.as_str()?;
            let arguments = item.get("input").cloned().unwrap_or(serde_json::json!({}));
            Some(AgentHistoryContent::ToolCall {
                native_item: Some(tool_call_native_item(
                    metadata,
                    item_id.unwrap_or(call_id),
                    call_id,
                    name,
                    &arguments,
                )),
                call_id: call_id.to_string(),
                name: name.to_string(),
                arguments,
            })
        }
        _ => None,
    }
}

fn text_native_item(text: &str, metadata: &serde_json::Value) -> Option<serde_json::Value> {
    if let Some(native) = metadata.get("rigNative") {
        let mut native = native.clone();
        if let Some(content) = native
            .get_mut("content")
            .and_then(serde_json::Value::as_array_mut)
        {
            for part in content {
                if part.get("type").and_then(serde_json::Value::as_str) == Some("output_text") {
                    part["text"] = serde_json::json!(text);
                }
            }
        }
        return Some(native);
    }
    let extras = metadata.get("openai_responses")?;
    let mut native = serde_json::json!({
        "type": "message", "role": "assistant", "status": "completed",
        "content": [{"type": "output_text", "text": text, "annotations": []}]
    });
    for (key, value) in extras.as_object().into_iter().flatten() {
        match key.as_str() {
            "message_id" => {
                if let Some(id) = non_empty_str(Some(value)) {
                    native["id"] = serde_json::json!(id);
                }
            }
            "phase" => native["phase"] = value.clone(),
            _ => native["content"][0][key] = value.clone(),
        }
    }
    Some(native)
}

fn reasoning_history(item: &serde_json::Value) -> Option<AgentHistoryContent> {
    let summary = item
        .get("text")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let item_id = non_empty_str(openai_field(item, "itemId"));
    let encrypted = opaque_encrypted(
        openai_field(item, "reasoningEncryptedContent").and_then(|value| value.as_str()),
    );
    if summary.is_empty() && encrypted.is_none() && item_id.is_none() {
        return None;
    }
    // Released transcripts omit the issuer for OpenAI reasoning.
    let issuer = item
        .get("providerMetadata")
        .and_then(|metadata| metadata.get("reasoningIssuer"))
        .and_then(|value| value.as_str())
        .unwrap_or("openai");
    let native_item = (issuer == "openai").then(|| {
        let summary_parts: Vec<_> = (!summary.is_empty())
            .then(|| serde_json::json!({ "type": "summary_text", "text": summary }))
            .into_iter()
            .collect();
        let mut native = serde_json::json!({ "type": "reasoning", "summary": summary_parts });
        if let Some(id) = item_id {
            native["id"] = serde_json::json!(id);
        }
        if let Some(encrypted) = encrypted {
            native["encrypted_content"] = serde_json::json!(encrypted);
        }
        native
    });
    Some(AgentHistoryContent::Reasoning {
        summary: summary.to_string(),
        native_item,
    })
}

fn tool_call_native_item(
    metadata: Option<&serde_json::Value>,
    item_id: &str,
    call_id: &str,
    name: &str,
    arguments: &serde_json::Value,
) -> serde_json::Value {
    let arguments = serde_json::json!(arguments.to_string());
    if let Some(native) = metadata.and_then(|metadata| metadata.get("rigNative")) {
        let mut native = native.clone();
        native["arguments"] = arguments;
        return native;
    }
    let mut native = serde_json::json!({
        "type": "function_call", "id": item_id, "call_id": call_id,
        "name": name, "arguments": arguments, "status": "completed"
    });
    // Released transcripts store extra native fields beside the signature.
    if let Some(metadata) = metadata {
        let params = metadata.get("toolCallAdditionalParams").unwrap_or(metadata);
        for (key, value) in params.as_object().into_iter().flatten() {
            if key != "origin" {
                native[key] = value.clone();
            }
        }
        if let Some(signature) = metadata.get("signature").and_then(|value| value.as_str()) {
            native["signature"] = serde_json::json!(signature);
        }
    }
    native
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::live::LiveAssistantParts;
    use crate::reasoning::{
        apply_completed_reasoning, merge_provider_metadata, reasoning_summary_text,
    };
    use crate::transcript::types::{
        TranscriptAttachmentMeta, TranscriptCompletionBody, TranscriptPromptBody,
        TranscriptToolBody,
    };
    use crate::types::deserialize_agent_history;
    use rig::completion::Message;
    use rig::message::{
        AssistantContent, AssistantMessage, CallId, Opaque, Origin, Reasoning, ToolCall,
        ToolFunction, ToolName,
    };

    fn prompt(number: u32, run_id: &str, text: &str) -> TranscriptPart {
        TranscriptPart {
            number,
            source_key: format!("prompt:{number}"),
            kind: TranscriptPartKind::Prompt,
            run_id: run_id.to_string(),
            created_at: None,
            prompt: Some(TranscriptPromptBody {
                text: text.to_string(),
                image_uploads: Vec::new(),
            }),
            completion: None,
            tool: None,
            work: Default::default(),
        }
    }

    fn tool_part(
        number: u32,
        source_key: &str,
        call_id: &str,
        status: &str,
        output: Option<serde_json::Value>,
        tool_invocation_id: Option<&str>,
        job_id: Option<&str>,
    ) -> TranscriptPart {
        TranscriptPart {
            number,
            source_key: source_key.into(),
            kind: TranscriptPartKind::Tool,
            run_id: "run".into(),
            created_at: None,
            prompt: None,
            completion: None,
            tool: Some(TranscriptToolBody {
                job_id: job_id.map(str::to_string),
                tool_invocation_id: tool_invocation_id.map(str::to_string),
                call_id: call_id.into(),
                name: "exec_command".into(),
                input: None,
                output,
                status: status.into(),
            }),
            work: Default::default(),
        }
    }

    fn completion_with_call(number: u32, call_id: &str) -> TranscriptPart {
        TranscriptPart {
            number,
            source_key: format!("completion:{number}"),
            kind: TranscriptPartKind::Completion,
            run_id: "run".into(),
            created_at: None,
            prompt: None,
            completion: Some(TranscriptCompletionBody {
                stream_id: Some("s".into()),
                items: vec![serde_json::json!({
                    "type": "tool-call",
                    "callId": call_id,
                    "name": "exec_command",
                    "input": {}
                })],
            }),
            tool: None,
            work: Default::default(),
        }
    }

    #[test]
    fn skips_the_current_run_prompt_until_that_run_has_finished_turns() {
        let mut state = TranscriptState::new("user".into(), "thread".into());
        state.history_from_number = 1;
        state.context_summary = Some("Prior work is done.".into());
        let before_resume = agent_history_from_parts(
            &state,
            &[
                prompt(0, "old", "covered"),
                prompt(1, "keep", "continue"),
                prompt(2, "current", "this turn"),
            ],
            Some("current"),
        );
        let before = format!("{before_resume:?}");
        assert!(before.contains("Prior work is done."));
        assert!(before.contains("continue"));
        assert!(!before.contains("covered"));
        assert!(!before.contains("this turn"));

        let after_resume = agent_history_from_parts(
            &state,
            &[
                prompt(0, "old", "covered"),
                prompt(1, "keep", "continue"),
                prompt(2, "current", "this turn"),
                TranscriptPart {
                    number: 3,
                    source_key: "completion:current".into(),
                    kind: TranscriptPartKind::Completion,
                    run_id: "current".into(),
                    created_at: None,
                    prompt: None,
                    completion: Some(TranscriptCompletionBody {
                        stream_id: Some("s".into()),
                        items: vec![serde_json::json!({ "type": "text", "text": "now" })],
                    }),
                    tool: None,
                    work: Default::default(),
                },
            ],
            Some("current"),
        );
        let after = format!("{after_resume:?}");
        assert!(after.contains("this turn"));
        assert!(after.contains("now"));
    }

    #[test]
    fn reconstructs_parent_transcript_for_a_continuation_run_without_a_prompt() {
        let mut state = TranscriptState::new("user".into(), "thread".into());
        state.history_from_number = 0;
        let history = agent_history_from_parts(
            &state,
            &[
                prompt(0, "parent", "original task"),
                TranscriptPart {
                    number: 1,
                    source_key: "completion:parent".into(),
                    kind: TranscriptPartKind::Completion,
                    run_id: "parent".into(),
                    created_at: None,
                    prompt: None,
                    completion: Some(TranscriptCompletionBody {
                        stream_id: Some("s".into()),
                        items: vec![serde_json::json!({ "type": "text", "text": "partial work" })],
                    }),
                    tool: None,
                    work: Default::default(),
                },
            ],
            Some("continuation"),
        );
        let serialized = format!("{history:?}");
        assert!(serialized.contains("original task"));
        assert!(serialized.contains("partial work"));
        assert!(!current_run_has_finished_turns(
            &[prompt(0, "parent", "original task")],
            "continuation"
        ));
    }

    #[test]
    fn skips_tool_parts_without_a_matching_completion_call() {
        let state = TranscriptState::new("user".into(), "thread".into());
        let history = agent_history_from_parts(
            &state,
            &[
                prompt(0, "run", "do it"),
                TranscriptPart {
                    number: 1,
                    source_key: "tool:orphan".into(),
                    kind: TranscriptPartKind::Tool,
                    run_id: "run".into(),
                    created_at: None,
                    prompt: None,
                    completion: None,
                    tool: Some(TranscriptToolBody {
                        job_id: None,
                        tool_invocation_id: None,
                        call_id: "orphan".into(),
                        name: "exec_command".into(),
                        input: None,
                        output: Some(serde_json::json!("orphan-output")),
                        status: "completed".into(),
                    }),
                    work: Default::default(),
                },
                TranscriptPart {
                    number: 2,
                    source_key: "completion:run".into(),
                    kind: TranscriptPartKind::Completion,
                    run_id: "run".into(),
                    created_at: None,
                    prompt: None,
                    completion: Some(TranscriptCompletionBody {
                        stream_id: Some("s".into()),
                        items: vec![serde_json::json!({
                            "type": "tool-call",
                            "callId": "keep",
                            "name": "exec_command",
                            "input": {}
                        })],
                    }),
                    tool: None,
                    work: Default::default(),
                },
                TranscriptPart {
                    number: 3,
                    source_key: "tool:keep".into(),
                    kind: TranscriptPartKind::Tool,
                    run_id: "run".into(),
                    created_at: None,
                    prompt: None,
                    completion: None,
                    tool: Some(TranscriptToolBody {
                        job_id: None,
                        tool_invocation_id: None,
                        call_id: "keep".into(),
                        name: "exec_command".into(),
                        input: None,
                        output: Some(serde_json::json!("keep-output")),
                        status: "completed".into(),
                    }),
                    work: Default::default(),
                },
            ],
            Some("run"),
        );
        let serialized = format!("{history:?}");
        assert!(serialized.contains("do it"));
        assert!(serialized.contains("keep-output"));
        assert!(!serialized.contains("orphan-output"));
    }

    #[test]
    fn skips_started_tool_progress_and_emits_one_finished_result_after_the_call() {
        let state = TranscriptState::new("user".into(), "thread".into());
        let history = agent_history_from_parts(
            &state,
            &[
                prompt(0, "run", "do it"),
                tool_part(
                    1,
                    "tool:inv-1:started",
                    "keep",
                    "started",
                    None,
                    Some("inv-1"),
                    None,
                ),
                tool_part(
                    2,
                    "tool:inv-1:finished",
                    "keep",
                    "completed",
                    Some(serde_json::json!("keep-output")),
                    Some("inv-1"),
                    None,
                ),
                completion_with_call(3, "keep"),
            ],
            Some("run"),
        );
        let serialized = format!("{history:?}");
        assert!(serialized.contains("keep-output"));
        assert_eq!(serialized.matches("keep-output").count(), 1);
        assert!(!serialized.contains("started"));
        let keep_at = serialized.find("keep-output").expect("result");
        let call_at = serialized.find("ToolCall").expect("protocol call");
        assert!(call_at < keep_at);
    }

    #[test]
    fn first_terminal_tool_event_wins() {
        let state = TranscriptState::new("user".into(), "thread".into());
        let history = agent_history_from_parts(
            &state,
            &[
                prompt(0, "run", "do it"),
                completion_with_call(1, "keep"),
                tool_part(
                    2,
                    "tool:inv-1:finished",
                    "keep",
                    "cancelled",
                    Some(serde_json::json!({"error": "stopped", "status": "cancelled"})),
                    Some("inv-1"),
                    None,
                ),
                tool_part(
                    3,
                    "tool:inv-1:finished-dup",
                    "keep",
                    "completed",
                    Some(serde_json::json!("should-not-win")),
                    Some("inv-1"),
                    None,
                ),
            ],
            Some("run"),
        );
        let serialized = format!("{history:?}");
        assert!(serialized.contains("stopped"));
        assert!(!serialized.contains("should-not-win"));
    }

    #[test]
    fn reads_legacy_job_id_tool_parts() {
        let state = TranscriptState::new("user".into(), "thread".into());
        let history = agent_history_from_parts(
            &state,
            &[
                prompt(0, "run", "do it"),
                completion_with_call(1, "keep"),
                tool_part(
                    2,
                    "tool:legacy-job",
                    "keep",
                    "completed",
                    Some(serde_json::json!("legacy-output")),
                    None,
                    Some("legacy-job"),
                ),
            ],
            Some("run"),
        );
        let serialized = format!("{history:?}");
        assert!(serialized.contains("legacy-output"));
        assert!(serialized.contains("call_id: Some(\"keep\")"));
    }

    #[test]
    fn includes_attachment_paths_not_images_and_openai_reasoning_replay_fields() {
        let state = TranscriptState::new("user".into(), "thread".into());
        let history = agent_history_from_parts(
            &state,
            &[
                TranscriptPart {
                    number: 0,
                    source_key: "prompt:0".into(),
                    kind: TranscriptPartKind::Prompt,
                    run_id: "run".into(),
                    created_at: None,
                    prompt: Some(TranscriptPromptBody {
                        text: "see this".into(),
                        image_uploads: vec![TranscriptAttachmentMeta {
                            name: "shot.png".into(),
                            media_type: "image/png".into(),
                            size: 12,
                            storage_id: "st".into(),
                            url: Some("https://files.example/shot.png".into()),
                            local_path: Some("/cache/user/blobs/st".into()),
                        }],
                    }),
                    completion: None,
                    tool: None,
                    work: Default::default(),
                },
                TranscriptPart {
                    number: 1,
                    source_key: "completion:1".into(),
                    kind: TranscriptPartKind::Completion,
                    run_id: "run".into(),
                    created_at: None,
                    prompt: None,
                    completion: Some(TranscriptCompletionBody {
                        stream_id: Some("s".into()),
                        items: vec![serde_json::json!({
                            "type": "reasoning",
                            "text": "think",
                            "providerMetadata": {
                                "openai": {
                                    "itemId": "rs_123",
                                    "reasoningEncryptedContent": "enc"
                                }
                            }
                        })],
                    }),
                    tool: None,
                    work: Default::default(),
                },
            ],
            None,
        );
        let serialized = format!("{history:?}");
        assert!(!serialized.contains("https://files.example/shot.png"));
        assert!(!serialized.contains("Image {"));
        assert!(serialized.contains("/cache/user/blobs/st"));
        assert!(serialized.contains("rs_123"));
        assert!(serialized.contains("encrypted"));
        assert!(serialized.contains("enc"));
    }

    fn reasoning_completion(number: u32, item: serde_json::Value) -> TranscriptPart {
        TranscriptPart {
            number,
            source_key: format!("completion:{number}"),
            kind: TranscriptPartKind::Completion,
            run_id: "run".into(),
            created_at: None,
            prompt: None,
            completion: Some(TranscriptCompletionBody {
                stream_id: Some("s".into()),
                items: vec![item],
            }),
            tool: None,
            work: Default::default(),
        }
    }

    #[test]
    fn completed_reasoning_roundtrips_summary_and_one_envelope() {
        let encrypted = "e".repeat(600_000);
        let summary = " first\nsummary \n\nsecond";
        let native_item = serde_json::json!({
            "type": "reasoning",
            "id": "  item\nλ  ",
            "summary": [
                { "type": "summary_text", "text": " first\nsummary " },
                { "type": "summary_text", "text": "" },
                { "type": "summary_text", "text": "second" }
            ],
            "content": [{ "type": "reasoning_text", "text": "  raw\n\0λ  " }],
            "encrypted_content": encrypted,
            "status": "completed",
            "extra": { "data": "  redacted\n\0+/=  " }
        });
        for issuer in ["openai", "anthropic", "openrouter/anthropic"] {
            let AssistantContent::Reasoning(original) =
                AssistantContent::Reasoning(Reasoning::new(summary))
                    .with_native(native_item.clone())
            else {
                unreachable!()
            };
            let mut parts = LiveAssistantParts::default();
            parts.apply_text_delta("reasoning", "s:r".into(), "partial", None, 10);
            let mut metadata = HashMap::new();
            apply_completed_reasoning(&mut parts, &mut metadata, "s", "r", &original);
            metadata.get_mut("reasoning:s:r").unwrap()["reasoningIssuer"] =
                serde_json::json!(issuer);
            let item = merge_provider_metadata(&parts.parts[0], metadata.get("reasoning:s:r"));
            assert_eq!(item["text"], summary);
            assert_eq!(
                item["providerMetadata"],
                serde_json::json!({
                    "openai": {
                        "itemId": "  item\nλ  ",
                        "reasoningEncryptedContent": encrypted
                    },
                    "reasoningIssuer": issuer
                })
            );

            let stored = reasoning_completion(0, item);
            let stored_json = serde_json::to_string(&stored).unwrap();
            assert!(stored_json.len() < encrypted.len() + 1_000);
            let stored: TranscriptPart = serde_json::from_str(&stored_json).unwrap();
            let state = TranscriptState::new("user".into(), "thread".into());
            let history = agent_history_from_parts(&state, &[stored], None);
            let reloaded = deserialize_agent_history(history).expect("reloaded durable history");
            let Message::Assistant(message) = &reloaded[0] else {
                panic!("expected assistant message");
            };
            let AssistantContent::Reasoning(restored) = &message.content[0] else {
                panic!("expected reasoning");
            };
            assert_eq!(restored.text, summary);
            if issuer == "openai" {
                assert_eq!(
                    restored.native.as_ref().unwrap().item,
                    serde_json::json!({
                        "type": "reasoning",
                        "id": "  item\nλ  ",
                        "summary": [{ "type": "summary_text", "text": summary }],
                        "encrypted_content": encrypted
                    })
                );
            } else {
                assert!(restored.native.is_none());
            }
            assert_eq!(reasoning_summary_text(restored), summary);
        }
    }

    #[test]
    fn carries_the_first_valid_origin_for_reasoning_only_and_mixed_completions() {
        let origin = Origin::new("openai.responses", "openai", "reasoning-model");
        let origin_json = serde_json::to_value(&origin).unwrap();
        let reasoning = serde_json::json!({
            "type": "reasoning",
            "text": "summary",
            "providerMetadata": {
                "origin": origin_json,
                "openai": { "itemId": "rs_origin", "reasoningEncryptedContent": "opaque" }
            }
        });
        for mixed in [false, true] {
            let mut part = reasoning_completion(0, reasoning.clone());
            if mixed {
                part.completion.as_mut().unwrap().items = vec![
                    serde_json::json!({
                        "type": "text", "text": "answer",
                        "providerMetadata": { "origin": { "invalid": true }, "signature": "text-sig" }
                    }),
                    reasoning.clone(),
                    serde_json::json!({
                        "type": "tool-call", "callId": "call_origin", "name": "exec_cmd", "input": {},
                        "providerMetadata": {
                            "origin": Origin::new("openai.responses", "openai", "other-model"),
                            "toolCallAdditionalParams": { "signature": "tool-sig" }
                        }
                    }),
                ];
            }
            let state = TranscriptState::new("user".into(), "thread".into());
            let history = agent_history_from_parts(&state, &[part], None);
            assert_eq!(history[0].contents.len(), if mixed { 3 } else { 1 });
            assert_eq!(history[0].origin.as_ref(), Some(&origin));
            let restored = deserialize_agent_history(history).unwrap();
            let Message::Assistant(message) = &restored[0] else {
                panic!("expected assistant message");
            };
            assert_eq!(message.origin.as_ref(), Some(&origin));
        }
    }

    fn reloaded_assistant(item: serde_json::Value) -> AssistantMessage {
        let state = TranscriptState::new("user".into(), "thread".into());
        let history = agent_history_from_parts(&state, &[reasoning_completion(0, item)], None);
        let Message::Assistant(message) = deserialize_agent_history(history).unwrap().remove(0)
        else {
            panic!("expected assistant message");
        };
        message
    }

    #[test]
    fn released_text_extras_reload_as_a_native_message() {
        let message = reloaded_assistant(serde_json::json!({
            "type": "text", "text": "answer",
            "providerMetadata": { "openai_responses": {
                "message_id": "msg_item", "phase": "final_answer",
                "annotations": [{"type": "url_citation", "url": "https://example.com"}]
            } }
        }));
        let item = message.content[0].native_item().unwrap();
        assert_eq!(item["id"], "msg_item");
        assert_eq!(item["phase"], "final_answer");
        assert_eq!(item["content"][0]["text"], "answer");
        assert_eq!(
            item["content"][0]["annotations"][0]["url"],
            "https://example.com"
        );
    }

    #[test]
    fn released_reasoning_reloads_verbatim_as_openai() {
        let mut item = serde_json::json!({
            "type": "reasoning",
            "text": "  summary\nλ  ",
            "providerMetadata": {
                "openai": {
                    "itemId": "  rs_legacy  ",
                    "reasoningEncryptedContent": "  opaque\n+/=  "
                }
            }
        });
        let message = reloaded_assistant(item.clone());
        let AssistantContent::Reasoning(reasoning) = &message.content[0] else {
            panic!("expected reasoning");
        };
        assert_eq!(reasoning.text, "  summary\nλ  ");
        assert_eq!(
            reasoning.native.as_ref().unwrap().item,
            serde_json::json!({
                "type": "reasoning",
                "id": "  rs_legacy  ",
                "summary": [{ "type": "summary_text", "text": "  summary\nλ  " }],
                "encrypted_content": "  opaque\n+/=  "
            })
        );

        item["providerMetadata"]["reasoningIssuer"] = serde_json::json!("anthropic");
        let message = reloaded_assistant(item);
        let AssistantContent::Reasoning(reasoning) = &message.content[0] else {
            panic!("expected reasoning");
        };
        assert_eq!(reasoning.text, "  summary\nλ  ");
        assert!(reasoning.native.is_none());
    }

    #[test]
    fn reloads_empty_opaque_reasoning_without_inventing_ciphertext() {
        let message = reloaded_assistant(serde_json::json!({
            "type": "reasoning",
            "text": "",
            "providerMetadata": {
                "openai": { "itemId": "rs_empty", "reasoningEncryptedContent": "" }
            }
        }));
        let AssistantContent::Reasoning(reasoning) = &message.content[0] else {
            panic!("expected reasoning");
        };
        assert_eq!(
            reasoning.native.as_ref().unwrap().item,
            serde_json::json!({ "type": "reasoning", "id": "rs_empty", "summary": [] })
        );
        assert!(reasoning.text.is_empty());
    }

    #[test]
    fn omitted_reasoning_replay_keeps_visible_history_and_later_reasoning() {
        let mut state = TranscriptState::new("user".into(), "thread".into());
        state.reasoning_stripped_through_part_number = Some(1);
        let mut covered = reasoning_completion(
            1,
            serde_json::json!({
                "type": "reasoning",
                "text": "secret trace",
                "providerMetadata": {
                    "openai": {
                        "itemId": "rs_old",
                        "reasoningEncryptedContent": "sgr1.secret"
                    }
                }
            }),
        );
        let items = &mut covered.completion.as_mut().unwrap().items;
        items.push(serde_json::json!({
            "type": "text",
            "text": "visible answer",
            "providerMetadata": { "thought_signature": "text-signature" }
        }));
        items.push(serde_json::json!({
            "type": "tool-call",
            "callId": "call_keep",
            "name": "exec_cmd",
            "input": { "cmd": "pwd" },
            "providerMetadata": {
                "signature": "thought-signature",
                "toolCallAdditionalParams": { "thought_signature": "nested-signature" }
            }
        }));
        let later = reasoning_completion(
            2,
            serde_json::json!({
                "type": "reasoning",
                "text": "new trace",
                "providerMetadata": {
                    "openai": {
                        "itemId": "rs_new",
                        "reasoningEncryptedContent": "sgr1.new"
                    }
                }
            }),
        );
        let history = agent_history_from_parts(&state, &[covered, later], None);
        let serialized = serde_json::to_string(&history).unwrap();
        assert!(serialized.contains("visible answer"));
        assert!(serialized.contains("call_keep"));
        assert!(serialized.contains("rs_new"));
        assert!(serialized.contains("sgr1.new"));
        assert!(!serialized.contains("secret trace"));
        assert!(!serialized.contains("rs_old"));
        assert!(!serialized.contains("sgr1.secret"));
        assert!(!serialized.contains("thought-signature"));
        assert!(!serialized.contains("text-signature"));
        assert!(!serialized.contains("nested-signature"));
    }

    #[test]
    fn strips_reasoning_opaque_items_native_data_and_origin() {
        let origin = Origin::new("openai.responses", "openai", "old-model");
        let history =
            without_reasoning_traces(vec![
            Message::user("keep the request"),
            Message::Assistant(AssistantMessage::new(vec![
                AssistantContent::Opaque(Opaque {
                    item: serde_json::json!({ "type": "compaction", "data": "opaque-secret" }),
                    replay: true,
                }),
                AssistantContent::Reasoning(Reasoning::new(""))
                    .with_native(serde_json::json!({
                        "type": "reasoning",
                        "id": "rs_old",
                        "encrypted_content": "sgr1.secret"
                    })),
            ]).with_origin(origin.clone())),
            Message::Assistant(AssistantMessage::new(vec![
                AssistantContent::Opaque(Opaque {
                    item: serde_json::json!({ "type": "compaction", "data": "opaque-secret" }),
                    replay: true,
                }),
                AssistantContent::text("visible answer").with_native(serde_json::json!({
                    "type": "text",
                    "thought_signature": "text-signature"
                })),
                AssistantContent::ToolCall(ToolCall::new(
                    CallId::from_wire("call_keep"),
                    ToolFunction::new(
                        ToolName::new("exec_cmd").expect("tool name"),
                        serde_json::json!({ "cmd": "pwd" }),
                    ),
                ))
                .with_native(serde_json::json!({
                    "signature": "thought-signature",
                    "thought_signature": "nested-signature"
                })),
            ]).with_origin(origin)),
        ]);
        let serialized = format!("{history:?}");
        assert!(serialized.contains("keep the request"));
        assert!(serialized.contains("visible answer"));
        assert!(serialized.contains("call_keep"));
        assert!(!serialized.contains("sgr1.secret"));
        assert!(!serialized.contains("rs_old"));
        assert!(!serialized.contains("thought-signature"));
        assert!(!serialized.contains("text-signature"));
        assert!(!serialized.contains("nested-signature"));
        assert!(!serialized.contains("opaque-secret"));
        assert_eq!(history.len(), 2);
        let Message::Assistant(message) = &history[1] else {
            panic!("expected visible assistant message");
        };
        assert!(message.origin.is_none());
        assert_eq!(message.content.len(), 2);
        let AssistantContent::Text(text) = &message.content[0] else {
            panic!("expected visible text");
        };
        assert_eq!(text.text, "visible answer");
        assert!(text.native.is_none());
        let AssistantContent::ToolCall(call) = &message.content[1] else {
            panic!("expected tool call");
        };
        assert_eq!(call.function.arguments["cmd"], "pwd");
        assert!(call.native.is_none());
    }
}
