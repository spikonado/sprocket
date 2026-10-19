use std::collections::{HashMap, HashSet};

use rig::completion::Message;
use rig::message::{AssistantContent, Origin};

use crate::context_handoff::context_summary_text;
use crate::reasoning::opaque_encrypted;
use crate::types::{
    AgentHistoryContent, AgentHistoryMessage, AgentHistoryRole, AgentHistoryToolResultItem,
};
use sprocket_transcript::{
    TranscriptPart, TranscriptPartKind, TranscriptState, TranscriptToolBody,
};

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

pub fn current_run_has_finished_turns(parts: &[TranscriptPart], run_id: &str) -> bool {
    parts
        .iter()
        .any(|part| part.run_id == run_id && part.kind == TranscriptPartKind::Completion)
}

/// The prompt a run should answer, kept out of its history. A continuation
/// whose earlier runs ended without output re-answers the last user prompt
/// instead of being told to "continue" work that never started.
pub(crate) fn pending_prompt_part<'a>(
    state: &TranscriptState,
    parts: &'a [TranscriptPart],
    run_id: &str,
) -> Option<&'a TranscriptPart> {
    if current_run_has_finished_turns(parts, run_id) {
        return None;
    }
    parts
        .iter()
        .find(|part| part.run_id == run_id && part.kind == TranscriptPartKind::Prompt)
        .or_else(|| {
            parts
                .iter()
                .filter(|part| part.number >= state.history_from_number)
                .max_by_key(|part| part.number)
                .filter(|part| part.kind == TranscriptPartKind::Prompt)
        })
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
    tool_result_text_message(&tool.call_id, output)
}

fn tool_result_text_message(call_id: &str, text: String) -> AgentHistoryMessage {
    AgentHistoryMessage {
        role: AgentHistoryRole::User,
        origin: None,
        contents: vec![AgentHistoryContent::ToolResult {
            id: call_id.to_string(),
            call_id: Some(call_id.to_string()),
            items: vec![AgentHistoryToolResultItem::Text { text }],
        }],
    }
}

/// Providers reject a tool call without a result, and a run can stop before
/// its tools settle, so those calls are answered before the next turn.
fn answer_unsettled_calls(
    awaiting_results: &mut Vec<String>,
    emitted_results: &mut HashSet<String>,
    history: &mut Vec<AgentHistoryMessage>,
) {
    for call_id in awaiting_results.drain(..) {
        if emitted_results.insert(call_id.clone()) {
            history.push(tool_result_text_message(
                &call_id,
                serde_json::json!({
                    "error": "The run was interrupted before this tool call returned a result.",
                    "status": "interrupted",
                })
                .to_string(),
            ));
        }
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
    let pending_prompt_number = skip_run_id
        .and_then(|run_id| pending_prompt_part(state, parts, run_id))
        .map(|part| part.number);
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
    let mut awaiting_results = Vec::new();

    for part in parts {
        if part.number < state.history_from_number {
            continue;
        }
        if part.kind != TranscriptPartKind::Tool {
            answer_unsettled_calls(&mut awaiting_results, &mut emitted_results, &mut history);
        }
        if pending_prompt_number == Some(part.number) {
            continue;
        }
        match part.kind {
            TranscriptPartKind::Prompt => {
                if let Some(prompt) = &part.prompt {
                    let mut contents = Vec::new();
                    let text = prompt.text_with_attachments();
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
                    let call_ids: Vec<_> = contents
                        .iter()
                        .filter_map(|content| match content {
                            AgentHistoryContent::ToolCall { call_id, .. } => Some(call_id.clone()),
                            _ => None,
                        })
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
                    awaiting_results.extend(call_ids);
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
    answer_unsettled_calls(&mut awaiting_results, &mut emitted_results, &mut history);
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
mod tests;
