use std::collections::{HashMap, HashSet};

use rig::completion::Message;
use rig::message::{AssistantContent, Origin};

use crate::context_handoff::context_summary_text;
use crate::reasoning::opaque_encrypted;
use crate::types::{
    AgentHistoryContent, AgentHistoryMessage, AgentHistoryRole, AgentHistoryToolResultItem,
};
use crate::workspace_context::HiddenPrompt;
use sprocket_transcript::{
    HiddenPromptKind, TranscriptPart, TranscriptPartKind, TranscriptState, TranscriptToolBody,
};

const LEGACY_REASONING_ISSUER: &str = "openai";
const ANTHROPIC_MESSAGES_API: &str = "anthropic.messages";

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

fn hidden_kind(part: &TranscriptPart) -> Option<&HiddenPromptKind> {
    part.prompt.as_ref()?.hidden.as_ref()
}

fn is_user_prompt(part: &TranscriptPart) -> bool {
    part.kind == TranscriptPartKind::Prompt && hidden_kind(part).is_none()
}

fn is_workspace_context_part(part: &TranscriptPart) -> bool {
    matches!(
        hidden_kind(part),
        Some(HiddenPromptKind::Instructions | HiddenPromptKind::Environment)
    )
}

pub(crate) fn shown_workspace_context(
    state: &TranscriptState,
    parts: &[TranscriptPart],
) -> Vec<HiddenPrompt> {
    let mut shown: Vec<HiddenPrompt> = Vec::new();
    let calls = ToolCallIndex::new(parts);
    for part in parts
        .iter()
        .filter(|part| part.number >= state.history_from_number)
    {
        if part.tool.as_ref().is_some_and(|tool| {
            tool.status == "completed"
                && calls
                    .tool_details(part)
                    .is_some_and(|(name, _)| name == "set_cwd")
        }) {
            shown.retain(|prompt| prompt.kind != HiddenPromptKind::Environment);
        } else if is_workspace_context_part(part)
            && let Some(prompt) = &part.prompt
            && let Some(kind) = &prompt.hidden
        {
            shown.push(HiddenPrompt {
                kind: kind.clone(),
                text: prompt.text.clone(),
            });
        }
    }
    shown
}

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
        .find(|part| part.run_id == run_id && is_user_prompt(part))
        .or_else(|| {
            parts
                .iter()
                .filter(|part| {
                    part.number >= state.history_from_number && hidden_kind(part).is_none()
                })
                .max_by_key(|part| part.number)
                .filter(|part| part.kind == TranscriptPartKind::Prompt)
        })
}

fn completion_item_call_id(item: &serde_json::Value) -> Option<&str> {
    if item.get("type").and_then(|value| value.as_str()) != Some("tool-call") {
        return None;
    }
    non_empty_str(item.get("callId"))
        .or_else(|| non_empty_str(openai_field(item, "itemId")))
        .or_else(|| item.get("callId")?.as_str())
}

#[derive(Clone, Copy)]
pub(crate) struct TranscriptToolCall<'a> {
    part_number: u32,
    item_index: usize,
    item: &'a serde_json::Value,
}

impl TranscriptToolCall<'_> {
    pub(crate) fn history_id(&self) -> String {
        format!(
            "transcript-tool-call:{}:{}",
            self.part_number, self.item_index
        )
    }

    fn call_id(&self) -> &str {
        completion_item_call_id(self.item).expect("indexed tool call")
    }
}

pub(crate) struct ToolCallIndex<'a> {
    by_item: HashMap<(u32, usize), TranscriptToolCall<'a>>,
    by_invocation: HashMap<&'a str, TranscriptToolCall<'a>>,
    by_call_id: HashMap<(&'a str, &'a str), Vec<TranscriptToolCall<'a>>>,
}

impl<'a> ToolCallIndex<'a> {
    pub(crate) fn new(parts: &'a [TranscriptPart]) -> Self {
        let mut index = Self {
            by_item: HashMap::new(),
            by_invocation: HashMap::new(),
            by_call_id: HashMap::new(),
        };
        for part in parts {
            let Some(completion) = &part.completion else {
                continue;
            };
            for (item_index, item) in completion.items.iter().enumerate() {
                let Some(call_id) = completion_item_call_id(item) else {
                    continue;
                };
                if item
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .is_none()
                {
                    continue;
                }
                let call = TranscriptToolCall {
                    part_number: part.number,
                    item_index,
                    item,
                };
                index.by_item.insert((part.number, item_index), call);
                if let Some(invocation_id) = non_empty_str(item.get("toolInvocationId")) {
                    index.by_invocation.insert(invocation_id, call);
                }
                index
                    .by_call_id
                    .entry((&part.run_id, call_id))
                    .or_default()
                    .push(call);
            }
        }
        for calls in index.by_call_id.values_mut() {
            calls.sort_by_key(|call| (call.part_number, call.item_index));
        }
        index
    }

    fn for_item(&self, part_number: u32, item_index: usize) -> Option<TranscriptToolCall<'a>> {
        self.by_item.get(&(part_number, item_index)).copied()
    }

    pub(crate) fn for_result(&self, part: &TranscriptPart) -> Option<TranscriptToolCall<'a>> {
        let tool = part.tool.as_ref()?;
        if let Some(call) = tool
            .tool_invocation_id
            .as_deref()
            .and_then(|id| self.by_invocation.get(id))
        {
            return Some(*call);
        }
        let calls = self
            .by_call_id
            .get(&(part.run_id.as_str(), tool.call_id.as_str()))?;
        let mut candidates = calls.iter().filter(|call| {
            tool.tool_invocation_id.is_none()
                || non_empty_str(call.item.get("toolInvocationId")).is_none()
        });
        candidates
            .clone()
            .rev()
            .find(|call| call.part_number < part.number)
            .or_else(|| candidates.next())
            .copied()
    }

    pub(crate) fn tool_details(
        &self,
        part: &'a TranscriptPart,
    ) -> Option<(&'a str, Option<&'a serde_json::Value>)> {
        let tool = part.tool.as_ref()?;
        let call = self.for_result(part);
        Some((
            call.and_then(|call| call.item.get("name")?.as_str())
                .unwrap_or(&tool.name),
            call.and_then(|call| call.item.get("input"))
                .or(tool.input.as_ref()),
        ))
    }
}

fn tool_result_message(
    call: TranscriptToolCall<'_>,
    tool: &TranscriptToolBody,
) -> AgentHistoryMessage {
    let output = tool
        .output
        .as_ref()
        .unwrap_or(&serde_json::Value::Null)
        .to_string();
    tool_result_text_message(call.history_id(), call.call_id(), output)
}

fn tool_result_text_message(id: String, call_id: &str, text: String) -> AgentHistoryMessage {
    AgentHistoryMessage {
        role: AgentHistoryRole::User,
        origin: None,
        contents: vec![AgentHistoryContent::ToolResult {
            id,
            call_id: Some(call_id.to_string()),
            items: vec![AgentHistoryToolResultItem::Text { text }],
        }],
    }
}

/// Providers reject a tool call without a result, and a run can stop before
/// its tools settle, so those calls are answered before the next turn.
fn answer_unsettled_calls(
    awaiting_results: &mut Vec<TranscriptToolCall<'_>>,
    emitted_results: &mut HashSet<String>,
    history: &mut Vec<AgentHistoryMessage>,
) {
    for call in awaiting_results.drain(..) {
        let id = call.history_id();
        if emitted_results.insert(id.clone()) {
            history.push(tool_result_text_message(
                format!("interrupted:{id}"),
                call.call_id(),
                serde_json::json!({
                    "error": "The run was interrupted before this tool call returned a result. Only the wait for its result ended. Work it started, such as a command or subagent, may still be running, so check before assuming it stopped.",
                    "status": "interrupted",
                })
                .to_string(),
            ));
        }
    }
}

fn take_matching_tool<'a>(
    call: TranscriptToolCall<'_>,
    tool: &'a TranscriptToolBody,
    opened_call_ids: &HashSet<String>,
    emitted_results: &mut HashSet<String>,
    pending_tools: &mut HashMap<String, &'a TranscriptToolBody>,
) -> Option<&'a TranscriptToolBody> {
    let id = call.history_id();
    if tool.status == "started" || emitted_results.contains(&id) {
        return None;
    }
    if opened_call_ids.contains(&id) {
        emitted_results.insert(id);
        return Some(tool);
    }
    pending_tools.entry(id).or_insert(tool);
    None
}

fn flush_pending_tools_for_completion(
    calls: &[TranscriptToolCall<'_>],
    opened_call_ids: &mut HashSet<String>,
    emitted_results: &mut HashSet<String>,
    pending_tools: &mut HashMap<String, &TranscriptToolBody>,
    history: &mut Vec<AgentHistoryMessage>,
) {
    for call in calls {
        let id = call.history_id();
        opened_call_ids.insert(id.clone());
        if emitted_results.contains(&id) {
            continue;
        }
        let Some(tool) = pending_tools.remove(&id) else {
            continue;
        };
        emitted_results.insert(id);
        history.push(tool_result_message(*call, tool));
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
    let calls = ToolCallIndex::new(parts);
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
                        .filter_map(|item| {
                            completion_item_to_history(item, origin.as_ref(), omit_reasoning)
                        })
                        .collect();
                    let completion_calls: Vec<_> = completion
                        .items
                        .iter()
                        .enumerate()
                        .filter_map(|(item_index, _)| calls.for_item(part.number, item_index))
                        .collect();
                    if !contents.is_empty() {
                        history.push(AgentHistoryMessage {
                            role: AgentHistoryRole::Assistant,
                            origin,
                            contents,
                        });
                    }
                    flush_pending_tools_for_completion(
                        &completion_calls,
                        &mut opened_call_ids,
                        &mut emitted_results,
                        &mut pending_tools,
                        &mut history,
                    );
                    awaiting_results.extend(completion_calls);
                }
            }
            TranscriptPartKind::Tool => {
                if let Some(tool) = &part.tool
                    && let Some(call) = calls.for_result(part)
                    && let Some(ready) = take_matching_tool(
                        call,
                        tool,
                        &opened_call_ids,
                        &mut emitted_results,
                        &mut pending_tools,
                    )
                {
                    history.push(tool_result_message(call, ready));
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

fn non_empty_str(value: Option<&serde_json::Value>) -> Option<&str> {
    value?.as_str().filter(|value| !value.is_empty())
}

fn completion_item_to_history(
    item: &serde_json::Value,
    origin: Option<&Origin>,
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
        "reasoning" => reasoning_history(item, origin),
        "tool-call" => {
            let item_id = non_empty_str(openai_field(item, "itemId"));
            let call_id = completion_item_call_id(item)?;
            let name = item.get("name")?.as_str()?;
            let arguments = item.get("input").cloned().unwrap_or(serde_json::json!({}));
            Some(AgentHistoryContent::ToolCall {
                // Omitted turns lose their origin, so a native item here would be
                // replayed as the current provider's legacy history.
                native_item: (!omit_reasoning).then(|| {
                    tool_call_native_item(
                        metadata,
                        item_id.unwrap_or(call_id),
                        call_id,
                        name,
                        &arguments,
                    )
                }),
                call_id: call_id.to_string(),
                name: name.to_string(),
                arguments,
            })
        }
        _ => None,
    }
}

fn text_native_item(text: &str, metadata: &serde_json::Value) -> Option<serde_json::Value> {
    let Some(native) = metadata.get("rigNative") else {
        return legacy_text_native_item(text, metadata);
    };
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
    Some(native)
}

fn legacy_text_native_item(text: &str, metadata: &serde_json::Value) -> Option<serde_json::Value> {
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

fn reasoning_history(
    item: &serde_json::Value,
    origin: Option<&Origin>,
) -> Option<AgentHistoryContent> {
    let summary = item
        .get("text")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let metadata = item.get("providerMetadata");
    if let Some(native) = metadata.and_then(|metadata| metadata.get("rigNative")) {
        let mut native = native.clone();
        if native.get("type").and_then(serde_json::Value::as_str) == Some("thinking")
            && native.get("thinking").is_none()
        {
            native["thinking"] = serde_json::json!(summary);
        }
        return Some(AgentHistoryContent::Reasoning {
            summary: summary.to_string(),
            native_item: Some(native),
        });
    }
    let item_id = non_empty_str(openai_field(item, "itemId"));
    let encrypted = opaque_encrypted(
        openai_field(item, "reasoningEncryptedContent").and_then(|value| value.as_str()),
    );
    if summary.is_empty() && encrypted.is_none() && item_id.is_none() {
        return None;
    }
    if origin.is_some_and(|origin| origin.api.as_str() == ANTHROPIC_MESSAGES_API) {
        return Some(AgentHistoryContent::Reasoning {
            summary: summary.to_string(),
            native_item: legacy_anthropic_thinking(summary, encrypted),
        });
    }
    let issuer = metadata
        .and_then(|metadata| metadata.get("reasoningIssuer"))
        .and_then(|value| value.as_str())
        .unwrap_or(LEGACY_REASONING_ISSUER);
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

fn legacy_anthropic_thinking(text: &str, signature: Option<&str>) -> Option<serde_json::Value> {
    let signature = signature.filter(|_| !text.is_empty())?;
    Some(serde_json::json!({ "type": "thinking", "thinking": text, "signature": signature }))
}

fn tool_call_native_item(
    metadata: Option<&serde_json::Value>,
    item_id: &str,
    call_id: &str,
    name: &str,
    arguments: &serde_json::Value,
) -> serde_json::Value {
    if let Some(native) = metadata.and_then(|metadata| metadata.get("rigNative")) {
        let mut native = native.clone();
        if native.get("arguments").is_none() {
            native["arguments"] = serde_json::json!(arguments.to_string());
        }
        return native;
    }
    let mut native = serde_json::json!({
        "type": "function_call", "id": item_id, "call_id": call_id,
        "name": name, "arguments": arguments.to_string(), "status": "completed"
    });
    if let Some(metadata) = metadata {
        legacy_tool_call_fields(&mut native, metadata);
    }
    native
}

fn legacy_tool_call_fields(native: &mut serde_json::Value, metadata: &serde_json::Value) {
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

#[cfg(test)]
mod tests;
