use std::collections::HashSet;

use crate::transcript::types::{TranscriptPart, TranscriptPartKind};
use crate::types::{
    AgentHistoryContent, AgentHistoryMessage, AgentHistoryRole, AgentHistoryToolResultItem,
};

use super::types::TranscriptState;

pub fn current_run_has_finished_turns(parts: &[TranscriptPart], run_id: &str) -> bool {
    parts
        .iter()
        .any(|part| part.run_id == run_id && part.kind == TranscriptPartKind::Completion)
}

fn completion_call_ids(parts: &[TranscriptPart]) -> HashSet<&str> {
    let mut ids = HashSet::new();
    for part in parts {
        let Some(completion) = &part.completion else {
            continue;
        };
        for item in &completion.items {
            if item.get("type").and_then(|value| value.as_str()) != Some("tool-call") {
                continue;
            }
            if let Some(call_id) = item.get("callId").and_then(|value| value.as_str()) {
                ids.insert(call_id);
            }
        }
    }
    ids
}

pub fn agent_history_from_parts(
    state: &TranscriptState,
    parts: &[TranscriptPart],
    skip_run_id: Option<&str>,
) -> Vec<AgentHistoryMessage> {
    let include_current_prompt =
        skip_run_id.is_some_and(|run_id| current_run_has_finished_turns(parts, run_id));
    let call_ids = completion_call_ids(parts);
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
                text: format!(
                    "The conversation context was automatically compacted. Treat this summary as authoritative, continue the current task from this state, and do not redo completed work.\n\n<conversation_summary>\n{summary}\n</conversation_summary>"
                ),
                additional_params_json: None,
            }],
        });
    }

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
                }
            }
            TranscriptPartKind::Tool => {
                if let Some(tool) = &part.tool {
                    if !call_ids.contains(tool.call_id.as_str()) {
                        continue;
                    }
                    history.push(AgentHistoryMessage {
                        role: AgentHistoryRole::User,
                        assistant_id: None,
                        contents: vec![AgentHistoryContent::ToolResult {
                            id: tool.call_id.clone(),
                            call_id: Some(tool.call_id.clone()),
                            items: vec![AgentHistoryToolResultItem::Text {
                                text: tool.output.to_string(),
                            }],
                        }],
                    });
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
                .map(str::to_string);
            let encrypted =
                openai_field(item, "reasoningEncryptedContent").and_then(|value| value.as_str());
            let mut blocks = Vec::new();
            if !text.is_empty() {
                blocks.push(serde_json::json!({ "type": "text", "content": { "text": text } }));
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
            prompt: Some(TranscriptPromptBody {
                text: text.to_string(),
                image_uploads: Vec::new(),
            }),
            completion: None,
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
                    prompt: None,
                    completion: None,
                    tool: Some(TranscriptToolBody {
                        job_id: None,
                        call_id: "orphan".into(),
                        name: "exec_command".into(),
                        output: serde_json::json!("orphan-output"),
                        status: "completed".into(),
                    }),
                },
                TranscriptPart {
                    number: 2,
                    source_key: "completion:run".into(),
                    kind: TranscriptPartKind::Completion,
                    run_id: "run".into(),
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
                    prompt: None,
                    completion: None,
                    tool: Some(TranscriptToolBody {
                        job_id: None,
                        call_id: "keep".into(),
                        name: "exec_command".into(),
                        output: serde_json::json!("keep-output"),
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
}
