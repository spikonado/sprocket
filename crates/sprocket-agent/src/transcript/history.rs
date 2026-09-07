use std::collections::{HashMap, HashSet};

use crate::compaction::context_summary_text;
use crate::reasoning::{opaque_encrypted, skip_reasoning_on_reload};
use crate::transcript::types::{TranscriptPart, TranscriptPartKind, TranscriptToolBody};
use crate::types::{
    AgentHistoryContent, AgentHistoryMessage, AgentHistoryRole, AgentHistoryToolResultItem,
};

use super::types::TranscriptState;

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
        assistant_id: None,
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
            assistant_id: None,
            contents: vec![AgentHistoryContent::Text {
                text: context_summary_text(summary),
                additional_params_json: None,
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
                    if !prompt.text.trim().is_empty() {
                        contents.push(AgentHistoryContent::Text {
                            text: prompt.text.clone(),
                            additional_params_json: None,
                        });
                    }
                    for upload in &prompt.image_uploads {
                        if let Some(url) = &upload.url {
                            let media = upload
                                .media_type
                                .strip_prefix("image/")
                                .unwrap_or(&upload.media_type);
                            contents.push(AgentHistoryContent::Image {
                                image_json: serde_json::json!({
                                    "data": { "type": "url", "value": url },
                                    "media_type": media
                                })
                                .to_string(),
                            });
                        }
                    }
                    if !contents.is_empty() {
                        history.push(AgentHistoryMessage {
                            role: AgentHistoryRole::User,
                            assistant_id: None,
                            contents,
                        });
                    }
                }
            }
            TranscriptPartKind::Completion => {
                if let Some(completion) = &part.completion {
                    let mut contents = Vec::new();
                    for item in &completion.items {
                        if let Some(content) = completion_item_to_history(item) {
                            if matches!(content, AgentHistoryContent::Reasoning { .. })
                                && skip_reasoning_on_reload(state.context_summary.as_deref())
                            {
                                continue;
                            }
                            contents.push(content);
                        }
                    }
                    if !contents.is_empty() {
                        history.push(AgentHistoryMessage {
                            role: AgentHistoryRole::Assistant,
                            assistant_id: None,
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

fn completion_item_to_history(item: &serde_json::Value) -> Option<AgentHistoryContent> {
    let kind = item.get("type")?.as_str()?;
    match kind {
        "text" => Some(AgentHistoryContent::Text {
            text: item.get("text")?.as_str()?.to_string(),
            additional_params_json: item.get("providerMetadata").map(|value| value.to_string()),
        }),
        "reasoning" => {
            let text = item
                .get("text")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            let item_id = openai_field(item, "itemId")
                .and_then(|value| value.as_str())
                .and_then(|id| opaque_encrypted(Some(id)))
                .map(str::to_string);
            let encrypted = opaque_encrypted(
                openai_field(item, "reasoningEncryptedContent").and_then(|value| value.as_str()),
            );
            let mut blocks = Vec::new();
            if !text.is_empty() {
                blocks.push(serde_json::json!({ "type": "summary", "content": text }));
            }
            if let Some(content) = encrypted {
                blocks.push(serde_json::json!({ "type": "encrypted", "content": content }));
            }
            if blocks.is_empty() && item_id.is_none() {
                return None;
            }
            Some(AgentHistoryContent::Reasoning {
                id: item_id,
                blocks_json: serde_json::to_string(&blocks).unwrap_or_else(|_| "[]".to_string()),
            })
        }
        "tool-call" => Some(AgentHistoryContent::ToolCall {
            id: item.get("callId")?.as_str()?.to_string(),
            call_id: item
                .get("callId")
                .and_then(|value| value.as_str())
                .map(str::to_string),
            name: item.get("name")?.as_str()?.to_string(),
            arguments_json: item
                .get("input")
                .cloned()
                .unwrap_or(serde_json::json!({}))
                .to_string(),
            signature: None,
            additional_params_json: item.get("providerMetadata").map(|value| value.to_string()),
        }),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transcript::types::{
        TranscriptAttachmentMeta, TranscriptCompletionBody, TranscriptPromptBody,
        TranscriptToolBody,
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
                output,
                status: status.into(),
            }),
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
                        output: Some(serde_json::json!("orphan-output")),
                        status: "completed".into(),
                    }),
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
                        output: Some(serde_json::json!("keep-output")),
                        status: "completed".into(),
                    }),
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
    fn includes_prompt_images_and_openai_reasoning_replay_fields() {
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
                            image_upload_id: "up".into(),
                            name: "shot.png".into(),
                            media_type: "image/png".into(),
                            size: 12,
                            storage_id: "st".into(),
                            url: Some("https://files.example/shot.png".into()),
                        }],
                    }),
                    completion: None,
                    tool: None,
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
                },
            ],
            None,
        );
        let serialized = format!("{history:?}");
        assert!(serialized.contains("https://files.example/shot.png"));
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
        }
    }

    #[test]
    fn reloads_empty_opaque_reasoning_without_inventing_ciphertext() {
        let state = TranscriptState::new("user".into(), "thread".into());
        let history = agent_history_from_parts(
            &state,
            &[reasoning_completion(
                0,
                serde_json::json!({
                    "type": "reasoning",
                    "text": "",
                    "providerMetadata": {
                        "openai": {
                            "itemId": "rs_empty",
                            "reasoningEncryptedContent": ""
                        }
                    }
                }),
            )],
            None,
        );
        assert_eq!(history.len(), 1);
        match &history[0].contents[0] {
            AgentHistoryContent::Reasoning { id, blocks_json } => {
                assert_eq!(id.as_deref(), Some("rs_empty"));
                assert_eq!(blocks_json, "[]");
            }
            other => panic!("expected empty signed reasoning, got {other:?}"),
        }
    }

    #[test]
    fn compaction_reload_drops_all_loaded_reasoning_regardless_of_part_number() {
        // A context summary is not proof the retained prefix is unchanged.
        // In-flight old generations can commit later, and in-memory compaction
        // can replace current-run text while historyFromNumber only drops the
        // prior run. Fail closed: drop every loaded reasoning item.
        let mut state = TranscriptState::new("user".into(), "thread".into());
        state.context_summary = Some("Prior work is done.".into());
        state.history_from_number = 1;
        let history = agent_history_from_parts(
            &state,
            &[
                prompt(0, "old", "covered"),
                reasoning_completion(
                    1,
                    serde_json::json!({
                        "type": "reasoning",
                        "text": "stale-tail",
                        "providerMetadata": {
                            "openai": {
                                "itemId": "rs_tail",
                                "reasoningEncryptedContent": "tail-envelope"
                            }
                        }
                    }),
                ),
                reasoning_completion(
                    3,
                    serde_json::json!({
                        "type": "reasoning",
                        "text": "also-stale",
                        "providerMetadata": {
                            "openai": {
                                "itemId": "rs_later",
                                "reasoningEncryptedContent": "later-envelope"
                            }
                        }
                    }),
                ),
            ],
            None,
        );
        let serialized = format!("{history:?}");
        assert!(serialized.contains("Prior work is done."));
        assert!(!serialized.contains("rs_tail"));
        assert!(!serialized.contains("tail-envelope"));
        assert!(!serialized.contains("rs_later"));
        assert!(!serialized.contains("later-envelope"));
    }

    #[test]
    fn compaction_reload_keeps_text_while_dropping_reasoning() {
        let mut state = TranscriptState::new("user".into(), "thread".into());
        state.context_summary = Some("Prior work is done.".into());
        state.history_from_number = 1;
        let history = agent_history_from_parts(
            &state,
            &[TranscriptPart {
                number: 1,
                source_key: "completion:1".into(),
                kind: TranscriptPartKind::Completion,
                created_at: None,
                run_id: "run".into(),
                prompt: None,
                completion: Some(TranscriptCompletionBody {
                    stream_id: Some("s".into()),
                    items: vec![
                        serde_json::json!({
                            "type": "reasoning",
                            "text": "stale",
                            "providerMetadata": {
                                "openai": {
                                    "itemId": "rs_old",
                                    "reasoningEncryptedContent": "old-envelope"
                                }
                            }
                        }),
                        serde_json::json!({ "type": "text", "text": "kept answer" }),
                    ],
                }),
                tool: None,
            }],
            None,
        );
        let serialized = format!("{history:?}");
        assert!(serialized.contains("kept answer"));
        assert!(!serialized.contains("rs_old"));
        assert!(!serialized.contains("old-envelope"));
    }
}
