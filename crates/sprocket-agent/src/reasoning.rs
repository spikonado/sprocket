use std::collections::HashMap;

use rig::completion::Message;
use rig::message::{AssistantContent, Reasoning, ReasoningContent};
use serde_json::Value as JsonValue;

use crate::live::{LiveAssistantPart, LiveAssistantParts, now_ms};

/// Durable OpenAI-shaped metadata already stored on transcript reasoning items.
/// `encrypted` is gateway envelope bytes: persist and replay as-is, never decode.
pub(crate) fn openai_reasoning_metadata(
    item_id: Option<&str>,
    encrypted: Option<&str>,
) -> Option<JsonValue> {
    let item_id = item_id.map(str::trim).filter(|id| !id.is_empty());
    let encrypted = opaque_encrypted(encrypted);
    if item_id.is_none() && encrypted.is_none() {
        return None;
    }
    let mut openai = serde_json::Map::new();
    if let Some(item_id) = item_id {
        openai.insert("itemId".to_string(), JsonValue::String(item_id.to_string()));
    }
    if let Some(encrypted) = encrypted {
        openai.insert(
            "reasoningEncryptedContent".to_string(),
            JsonValue::String(encrypted.to_string()),
        );
    }
    Some(serde_json::json!({ "openai": openai }))
}

pub(crate) fn opaque_encrypted(value: Option<&str>) -> Option<&str> {
    value.filter(|content| !content.is_empty())
}

pub(crate) fn opaque_reasoning_blob(reasoning: &Reasoning) -> Option<&str> {
    opaque_encrypted(reasoning.encrypted_content())
}

/// Durable reload cannot treat a part-number cutoff as an unchanged prefix.
/// In-flight old generations can commit later, and in-memory compaction can
/// replace current-run text while durable `historyFromNumber` only drops the
/// prior run. When a context summary is present, drop every loaded reasoning
/// item. Newly generated reasoning stays in the running native Rig history.
pub(crate) fn skip_reasoning_on_reload(context_summary: Option<&str>) -> bool {
    context_summary.is_some_and(|summary| !summary.is_empty())
}

pub(crate) fn strip_assistant_reasoning(messages: &mut [Message]) {
    for message in messages {
        strip_message_reasoning(message);
    }
}

fn strip_message_reasoning(message: &mut Message) {
    if let Message::Assistant { content, .. } = message {
        content.retain(|part| !matches!(part, AssistantContent::Reasoning(_)));
    }
}

fn assistant_has_only_reasoning(message: &Message) -> bool {
    match message {
        Message::Assistant { content, .. } => {
            !content.is_empty()
                && content
                    .iter()
                    .all(|part| matches!(part, AssistantContent::Reasoning(_)))
        }
        _ => false,
    }
}

fn compaction_reasoning_range(
    message_count: usize,
    replaced_prefix_len: usize,
    reasoning_from_len: usize,
) -> (usize, usize) {
    let start = replaced_prefix_len.min(message_count);
    (start, reasoning_from_len.min(message_count).max(start))
}

/// Live display is summary blocks only. Rig's `display_text` also joins
/// `Text` and `Redacted`, which must not become transcript text.
fn reasoning_summary_text(reasoning: &Reasoning) -> String {
    reasoning
        .content
        .iter()
        .filter_map(|block| match block {
            ReasoningContent::Summary(text) => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Drop reasoning in `[replaced_prefix_len, reasoning_from_len)` and remove
/// assistants that become empty. Later messages keep newly generated state.
pub(crate) fn strip_pre_compaction_reasoning(
    messages: &mut Vec<Message>,
    replaced_prefix_len: usize,
    reasoning_from_len: usize,
) {
    let (start, end) =
        compaction_reasoning_range(messages.len(), replaced_prefix_len, reasoning_from_len);
    let mut kept = Vec::with_capacity(messages.len());
    for (index, mut message) in std::mem::take(messages).into_iter().enumerate() {
        if index >= start && index < end {
            if assistant_has_only_reasoning(&message) {
                continue;
            }
            strip_message_reasoning(&mut message);
        }
        kept.push(message);
    }
    *messages = kept;
}

/// Raw indices that survive `strip_pre_compaction_reasoning` on a suffix
/// starting at `replaced_prefix_len`.
pub(crate) fn kept_suffix_raw_indices(
    messages: &[Message],
    replaced_prefix_len: usize,
    reasoning_from_len: usize,
) -> Vec<usize> {
    let (start, end) =
        compaction_reasoning_range(messages.len(), replaced_prefix_len, reasoning_from_len);
    (start..messages.len())
        .filter(|&index| index >= end || !assistant_has_only_reasoning(&messages[index]))
        .collect()
}

pub(crate) fn apply_completed_reasoning(
    parts: &mut LiveAssistantParts,
    provider_metadata: &mut HashMap<String, JsonValue>,
    stream_id: &str,
    correlator: &str,
    reasoning: &Reasoning,
) {
    let id = format!("{stream_id}:{correlator}");
    let key = format!("reasoning:{id}");
    let text = reasoning_summary_text(reasoning);
    let metadata =
        openai_reasoning_metadata(reasoning.id.as_deref(), opaque_reasoning_blob(reasoning));
    if let Some(metadata) = metadata {
        provider_metadata.insert(key, metadata);
    } else {
        provider_metadata.remove(&key);
    }
    parts.apply_completed_reasoning(id, text, Some(stream_id.to_string()), now_ms());
}

pub(crate) fn merge_provider_metadata(
    part: &LiveAssistantPart,
    metadata: Option<&JsonValue>,
) -> JsonValue {
    let mut value = serde_json::to_value(part).expect("live assistant parts always serialize");
    if let Some(metadata) = metadata {
        value
            .as_object_mut()
            .expect("live assistant part object")
            .insert("providerMetadata".to_string(), metadata.clone());
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;
    use rig::message::{ReasoningContent, Text};

    fn reasoning_with(id: Option<&str>, content: Vec<ReasoningContent>) -> Reasoning {
        Reasoning {
            id: id.map(str::to_string),
            content,
        }
    }

    #[test]
    fn empty_opaque_state_keeps_item_id_without_an_encrypted_block() {
        let metadata = openai_reasoning_metadata(Some("rs_empty"), Some(""));
        assert_eq!(
            metadata,
            Some(serde_json::json!({ "openai": { "itemId": "rs_empty" } }))
        );
        assert!(openai_reasoning_metadata(Some("  "), Some("")).is_none());
        assert!(opaque_encrypted(Some("")).is_none());
        assert!(opaque_encrypted(None).is_none());
    }

    #[test]
    fn opaque_encrypted_preserves_nonempty_original_bytes() {
        assert_eq!(opaque_encrypted(Some(" envelope ")), Some(" envelope "));
        assert_eq!(opaque_encrypted(Some("  ")), Some("  "));
        assert_eq!(
            openai_reasoning_metadata(Some("rs_1"), Some(" envelope ")),
            Some(serde_json::json!({
                "openai": {
                    "itemId": "rs_1",
                    "reasoningEncryptedContent": " envelope "
                }
            }))
        );
        assert_eq!(
            openai_reasoning_metadata(None, Some(" envelope ")),
            Some(serde_json::json!({
                "openai": { "reasoningEncryptedContent": " envelope " }
            }))
        );
    }

    #[test]
    fn completed_reasoning_replaces_delta_text_and_stores_opaque_state() {
        let mut parts = LiveAssistantParts::default();
        parts.apply_text_delta(
            "reasoning",
            "agent:run:claim:1:corr".to_string(),
            "partial",
            Some("agent:run:claim:1".to_string()),
            10,
        );
        let mut provider_metadata = HashMap::new();
        apply_completed_reasoning(
            &mut parts,
            &mut provider_metadata,
            "agent:run:claim:1",
            "corr",
            &reasoning_with(
                Some("rs_123"),
                vec![
                    ReasoningContent::Summary("done".to_string()),
                    ReasoningContent::Encrypted("envelope".to_string()),
                    ReasoningContent::Redacted {
                        data: "redacted-state".to_string(),
                    },
                    ReasoningContent::Text {
                        text: "raw-state".to_string(),
                        signature: None,
                    },
                    ReasoningContent::Summary("second".to_string()),
                ],
            ),
        );

        assert_eq!(parts.parts.len(), 1);
        match &parts.parts[0] {
            LiveAssistantPart::Reasoning { text, .. } => {
                assert_eq!(text, "done\nsecond");
                assert!(!text.contains("envelope"));
                assert!(!text.contains("redacted-state"));
                assert!(!text.contains("raw-state"));
            }
            other => panic!("expected reasoning part, got {other:?}"),
        }
        assert_eq!(
            provider_metadata["reasoning:agent:run:claim:1:corr"],
            serde_json::json!({
                "openai": {
                    "itemId": "rs_123",
                    "reasoningEncryptedContent": "envelope"
                }
            })
        );
    }

    #[test]
    fn empty_signed_completion_inserts_a_durable_slot_without_live_ciphertext() {
        let mut parts = LiveAssistantParts::default();
        let mut provider_metadata = HashMap::new();
        apply_completed_reasoning(
            &mut parts,
            &mut provider_metadata,
            "stream",
            "corr",
            &reasoning_with(
                Some("rs_signed"),
                vec![ReasoningContent::Encrypted("opaque".to_string())],
            ),
        );

        match &parts.parts[0] {
            LiveAssistantPart::Reasoning { text, .. } => assert!(text.is_empty()),
            other => panic!("expected reasoning part, got {other:?}"),
        }
        let item = merge_provider_metadata(
            &parts.parts[0],
            provider_metadata.get("reasoning:stream:corr"),
        );
        assert_eq!(item["text"], "");
        assert_eq!(item["providerMetadata"]["openai"]["itemId"], "rs_signed");
        assert_eq!(
            item["providerMetadata"]["openai"]["reasoningEncryptedContent"],
            "opaque"
        );
    }

    #[test]
    fn interleaved_reasoning_keeps_arrival_order_beside_tool_calls() {
        let mut parts = LiveAssistantParts::default();
        parts.apply_text_delta(
            "reasoning",
            "stream:r1".to_string(),
            "first",
            Some("stream".to_string()),
            10,
        );
        parts.apply_tool_call(
            Some("call-1".to_string()),
            "call_1".to_string(),
            "exec_command".to_string(),
            serde_json::json!({ "cmd": "pwd" }),
            Some("stream".to_string()),
            20,
        );
        let mut provider_metadata = HashMap::new();
        apply_completed_reasoning(
            &mut parts,
            &mut provider_metadata,
            "stream",
            "r2",
            &reasoning_with(
                Some("rs_2"),
                vec![ReasoningContent::Summary("after".to_string())],
            ),
        );
        apply_completed_reasoning(
            &mut parts,
            &mut provider_metadata,
            "stream",
            "r1",
            &reasoning_with(
                Some("rs_1"),
                vec![ReasoningContent::Summary("first done".to_string())],
            ),
        );

        assert_eq!(parts.parts.len(), 3);
        match &parts.parts[0] {
            LiveAssistantPart::Reasoning { text, .. } => assert_eq!(text, "first done"),
            other => panic!("expected first reasoning, got {other:?}"),
        }
        match &parts.parts[1] {
            LiveAssistantPart::ToolCall { call_id, .. } => assert_eq!(call_id, "call_1"),
            other => panic!("expected tool call, got {other:?}"),
        }
        match &parts.parts[2] {
            LiveAssistantPart::Reasoning { text, .. } => assert_eq!(text, "after"),
            other => panic!("expected second reasoning, got {other:?}"),
        }
    }

    #[test]
    fn compaction_strips_old_reasoning_and_keeps_later_state() {
        let mut messages = vec![
            Message::user("old"),
            Message::Assistant {
                id: None,
                content: vec![
                    AssistantContent::Reasoning(Reasoning::new("stale")),
                    AssistantContent::Text(Text::new("kept text")),
                ],
            },
            Message::Assistant {
                id: None,
                content: vec![AssistantContent::Reasoning(Reasoning::encrypted(
                    "new-envelope",
                ))],
            },
        ];

        strip_pre_compaction_reasoning(&mut messages, 1, 2);

        assert_eq!(messages.len(), 3);
        match &messages[1] {
            Message::Assistant { content, .. } => {
                assert_eq!(content.len(), 1);
                assert!(matches!(content[0], AssistantContent::Text(_)));
            }
            other => panic!("expected stripped assistant, got {other:?}"),
        }
        match &messages[2] {
            Message::Assistant { content, .. } => {
                assert!(matches!(content[0], AssistantContent::Reasoning(_)));
            }
            other => panic!("expected new reasoning, got {other:?}"),
        }
    }

    #[test]
    fn compaction_strip_removes_reasoning_only_assistants() {
        let messages = vec![
            Message::user("old"),
            Message::Assistant {
                id: None,
                content: vec![AssistantContent::Reasoning(Reasoning::new("stale"))],
            },
            Message::Assistant {
                id: None,
                content: vec![AssistantContent::Reasoning(Reasoning::encrypted("new"))],
            },
        ];
        assert_eq!(kept_suffix_raw_indices(&messages, 1, 2), vec![2]);

        let mut stripped = messages;
        strip_pre_compaction_reasoning(&mut stripped, 1, 2);
        assert_eq!(stripped.len(), 2);
        match &stripped[1] {
            Message::Assistant { content, .. } => {
                assert!(matches!(content[0], AssistantContent::Reasoning(_)));
            }
            other => panic!("expected surviving reasoning, got {other:?}"),
        }
    }

    #[test]
    fn reload_drops_all_reasoning_when_a_context_summary_is_present() {
        assert!(!skip_reasoning_on_reload(None));
        assert!(skip_reasoning_on_reload(Some("summary")));
        assert!(!skip_reasoning_on_reload(Some("")));
        assert!(skip_reasoning_on_reload(Some("   ")));
    }

    #[test]
    fn empty_assistants_are_not_reasoning_only() {
        let messages = vec![
            Message::user("old"),
            Message::Assistant {
                id: None,
                content: vec![],
            },
            Message::Assistant {
                id: None,
                content: vec![AssistantContent::Reasoning(Reasoning::new("stale"))],
            },
        ];
        assert_eq!(kept_suffix_raw_indices(&messages, 1, 3), vec![1]);

        let mut stripped = messages;
        strip_pre_compaction_reasoning(&mut stripped, 1, 3);
        assert_eq!(stripped.len(), 2);
        match &stripped[1] {
            Message::Assistant { content, .. } => assert!(content.is_empty()),
            other => panic!("expected empty assistant to remain, got {other:?}"),
        }
    }

    #[test]
    fn inverted_compaction_range_does_not_strip() {
        let messages = vec![
            Message::user("old"),
            Message::Assistant {
                id: None,
                content: vec![AssistantContent::Reasoning(Reasoning::new("keep"))],
            },
        ];
        assert_eq!(
            kept_suffix_raw_indices(&messages, 5, 1),
            Vec::<usize>::new()
        );

        let mut stripped = messages.clone();
        strip_pre_compaction_reasoning(&mut stripped, 5, 1);
        assert_eq!(stripped.len(), 2);
        match &stripped[1] {
            Message::Assistant { content, .. } => {
                assert!(matches!(content[0], AssistantContent::Reasoning(_)));
            }
            other => panic!("expected untouched reasoning, got {other:?}"),
        }
        assert_eq!(kept_suffix_raw_indices(&messages, 0, 0), vec![0, 1]);
    }

    #[test]
    fn completed_reasoning_without_opaque_state_clears_metadata() {
        let mut parts = LiveAssistantParts::default();
        let mut provider_metadata = HashMap::new();
        apply_completed_reasoning(
            &mut parts,
            &mut provider_metadata,
            "stream",
            "corr",
            &reasoning_with(
                Some("rs_1"),
                vec![ReasoningContent::Encrypted("envelope".to_string())],
            ),
        );
        assert!(provider_metadata.contains_key("reasoning:stream:corr"));

        apply_completed_reasoning(
            &mut parts,
            &mut provider_metadata,
            "stream",
            "corr",
            &reasoning_with(None, vec![ReasoningContent::Summary("visible".to_string())]),
        );
        assert!(!provider_metadata.contains_key("reasoning:stream:corr"));
        match &parts.parts[0] {
            LiveAssistantPart::Reasoning { text, .. } => assert_eq!(text, "visible"),
            other => panic!("expected updated reasoning, got {other:?}"),
        }
    }

    #[test]
    fn stale_reasoning_index_still_inserts_a_new_part() {
        let mut parts = LiveAssistantParts::default();
        parts.apply_text_delta(
            "reasoning",
            "stream:corr".to_string(),
            "stale",
            Some("stream".to_string()),
            10,
        );
        parts.parts[0] = LiveAssistantPart::ToolCall {
            part_id: Some("call-1".to_string()),
            call_id: "call_1".to_string(),
            name: "exec_command".to_string(),
            input: serde_json::json!({ "cmd": "pwd" }),
            started_at: Some(10),
            completed_at: Some(10),
            turn_id: Some("stream".to_string()),
        };
        let mut provider_metadata = HashMap::new();
        apply_completed_reasoning(
            &mut parts,
            &mut provider_metadata,
            "stream",
            "corr",
            &reasoning_with(
                Some("rs_1"),
                vec![ReasoningContent::Summary("late".to_string())],
            ),
        );

        assert_eq!(parts.parts.len(), 2);
        match &parts.parts[1] {
            LiveAssistantPart::Reasoning { text, .. } => assert_eq!(text, "late"),
            other => panic!("expected appended reasoning, got {other:?}"),
        }

        apply_completed_reasoning(
            &mut parts,
            &mut provider_metadata,
            "stream",
            "corr",
            &reasoning_with(
                Some("rs_1"),
                vec![ReasoningContent::Summary("late again".to_string())],
            ),
        );
        assert_eq!(parts.parts.len(), 2);
        match &parts.parts[1] {
            LiveAssistantPart::Reasoning { text, .. } => assert_eq!(text, "late again"),
            other => panic!("expected retargeted reasoning slot, got {other:?}"),
        }
    }

    #[test]
    fn completed_reasoning_preserves_delta_start_time() {
        let mut parts = LiveAssistantParts::default();
        parts.apply_text_delta(
            "reasoning",
            "stream:corr".to_string(),
            "partial",
            Some("stream".to_string()),
            1_000,
        );
        let mut provider_metadata = HashMap::new();
        let before = now_ms();
        apply_completed_reasoning(
            &mut parts,
            &mut provider_metadata,
            "stream",
            "corr",
            &reasoning_with(
                Some("rs_1"),
                vec![ReasoningContent::Summary("done".to_string())],
            ),
        );
        let after = now_ms();
        match &parts.parts[0] {
            LiveAssistantPart::Reasoning {
                text,
                started_at,
                completed_at,
                ..
            } => {
                assert_eq!(text, "done");
                assert_eq!(*started_at, Some(1_000));
                let completed = completed_at.expect("completed at");
                assert!(completed >= before && completed <= after);
            }
            other => panic!("expected reasoning part, got {other:?}"),
        }
    }

    #[test]
    fn empty_completed_reasoning_sets_start_and_end() {
        let mut parts = LiveAssistantParts::default();
        let mut provider_metadata = HashMap::new();
        let before = now_ms();
        apply_completed_reasoning(
            &mut parts,
            &mut provider_metadata,
            "stream",
            "corr",
            &reasoning_with(
                Some("rs_signed"),
                vec![ReasoningContent::Encrypted("opaque".to_string())],
            ),
        );
        let after = now_ms();
        match &parts.parts[0] {
            LiveAssistantPart::Reasoning {
                text,
                started_at,
                completed_at,
                ..
            } => {
                assert!(text.is_empty());
                let started = started_at.expect("started at");
                let completed = completed_at.expect("completed at");
                assert_eq!(started, completed);
                assert!(started >= before && completed <= after);
            }
            other => panic!("expected reasoning part, got {other:?}"),
        }
    }
}
