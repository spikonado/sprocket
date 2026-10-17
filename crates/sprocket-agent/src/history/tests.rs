use super::*;
use crate::reasoning::{
    apply_completed_reasoning, merge_provider_metadata, reasoning_summary_text,
};
use crate::types::deserialize_agent_history;
use rig::completion::Message;
use rig::message::{
    AssistantContent, AssistantMessage, CallId, Opaque, Origin, Reasoning, ToolCall, ToolFunction,
    ToolName,
};
use sprocket_transcript::{
    LiveAssistantParts, TranscriptAttachmentMeta, TranscriptCompletionBody, TranscriptPromptBody,
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
fn continuation_of_a_run_without_output_answers_its_prompt() {
    let state = TranscriptState::new("user".into(), "thread".into());
    let parts = [
        prompt(0, "earlier", "first task"),
        prompt(1, "parent", "original task"),
    ];
    let pending = pending_prompt_part(&state, &parts, "continuation").unwrap();
    assert_eq!(pending.number, 1);
    let history = format!(
        "{:?}",
        agent_history_from_parts(&state, &parts, Some("continuation"))
    );
    assert!(history.contains("first task"));
    assert!(!history.contains("original task"));
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
            AssistantContent::Reasoning(Reasoning::new(summary)).with_native(native_item.clone())
        else {
            unreachable!()
        };
        let mut parts = LiveAssistantParts::default();
        parts.apply_text_delta("reasoning", "s:r".into(), "partial", None, 10);
        let mut metadata = HashMap::new();
        apply_completed_reasoning(&mut parts, &mut metadata, "s", "r", &original);
        metadata.get_mut("reasoning:s:r").unwrap()["reasoningIssuer"] = serde_json::json!(issuer);
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
    let Message::Assistant(message) = deserialize_agent_history(history).unwrap().remove(0) else {
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
    let history = without_reasoning_traces(vec![
        Message::user("keep the request"),
        Message::Assistant(
            AssistantMessage::new(vec![
                AssistantContent::Opaque(Opaque {
                    item: serde_json::json!({ "type": "compaction", "data": "opaque-secret" }),
                    replay: true,
                }),
                AssistantContent::Reasoning(Reasoning::new("")).with_native(serde_json::json!({
                    "type": "reasoning",
                    "id": "rs_old",
                    "encrypted_content": "sgr1.secret"
                })),
            ])
            .with_origin(origin.clone()),
        ),
        Message::Assistant(
            AssistantMessage::new(vec![
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
            ])
            .with_origin(origin),
        ),
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
