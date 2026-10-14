use std::collections::HashMap;

use rig::message::{AssistantContent, Reasoning};
use serde_json::Value as JsonValue;

use crate::live::{LiveAssistantPart, LiveAssistantParts, now_ms};

/// Durable OpenAI-shaped metadata already stored on transcript reasoning items.
/// `encrypted` is gateway envelope bytes: persist and replay as-is, never decode.
pub(crate) fn openai_reasoning_metadata(
    item_id: Option<&str>,
    encrypted: Option<&str>,
) -> Option<JsonValue> {
    let item_id = item_id.filter(|id| !id.is_empty());
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

fn native_reasoning(reasoning: &Reasoning) -> Option<&JsonValue> {
    let native = reasoning.native.as_ref()?;
    (native.fingerprint == AssistantContent::Reasoning(reasoning.clone()).fingerprint())
        .then_some(&native.item)
}

pub(crate) fn opaque_reasoning_blob(reasoning: &Reasoning) -> Option<&str> {
    opaque_encrypted(
        native_reasoning(reasoning)?
            .get("encrypted_content")?
            .as_str(),
    )
}

#[cfg(test)]
pub(crate) fn reasoning_summary_text(reasoning: &Reasoning) -> String {
    summary_text(reasoning)
}

fn summary_text(reasoning: &Reasoning) -> String {
    let Some(summary) = native_reasoning(reasoning)
        .filter(|item| item.get("type").and_then(JsonValue::as_str) == Some("reasoning"))
        .and_then(|item| item.get("summary"))
        .and_then(JsonValue::as_array)
    else {
        return if reasoning.redacted {
            String::new()
        } else {
            reasoning.text.clone()
        };
    };
    summary
        .iter()
        .filter_map(|block| block.get("text").and_then(JsonValue::as_str))
        .collect::<Vec<_>>()
        .join("\n")
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
    let text = summary_text(reasoning);
    let native = native_reasoning(reasoning);
    let openai =
        native.filter(|item| item.get("type").and_then(JsonValue::as_str) == Some("reasoning"));
    let mut metadata = openai_reasoning_metadata(
        openai
            .and_then(|item| item.get("id"))
            .and_then(JsonValue::as_str),
        opaque_reasoning_blob(reasoning),
    )
    .unwrap_or_else(|| serde_json::json!({}));
    if openai.is_some() {
        metadata["reasoningIssuer"] = serde_json::json!("openai");
    }
    provider_metadata.insert(key, metadata);
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
    enum ReasoningContent {
        Summary(String),
        Encrypted(String),
    }

    fn reasoning_with(id: Option<&str>, content: Vec<ReasoningContent>) -> Reasoning {
        let summary: Vec<_> = content
            .iter()
            .filter_map(|block| match block {
                ReasoningContent::Summary(text) => Some(text.as_str()),
                _ => None,
            })
            .collect();
        let mut item = serde_json::json!({
            "type": "reasoning",
            "summary": summary.iter().map(|text| serde_json::json!({
                "type": "summary_text", "text": text
            })).collect::<Vec<_>>()
        });
        if let Some(id) = id {
            item["id"] = serde_json::json!(id);
        }
        if let Some(encrypted) = content.iter().find_map(|block| match block {
            ReasoningContent::Encrypted(content) => Some(content),
            _ => None,
        }) {
            item["encrypted_content"] = serde_json::json!(encrypted);
        }
        let AssistantContent::Reasoning(reasoning) =
            AssistantContent::Reasoning(Reasoning::new(summary.join("\n"))).with_native(item)
        else {
            unreachable!()
        };
        reasoning
    }

    #[test]
    fn empty_opaque_state_keeps_item_id_without_an_encrypted_block() {
        let metadata = openai_reasoning_metadata(Some("rs_empty"), Some(""));
        assert_eq!(
            metadata,
            Some(serde_json::json!({ "openai": { "itemId": "rs_empty" } }))
        );
        assert!(openai_reasoning_metadata(Some(""), Some("")).is_none());
        assert_eq!(
            openai_reasoning_metadata(Some("  rs_1  "), None),
            Some(serde_json::json!({ "openai": { "itemId": "  rs_1  " } }))
        );
        assert!(opaque_encrypted(Some("")).is_none());
        assert!(opaque_encrypted(None).is_none());
    }

    #[test]
    fn edited_reasoning_uses_current_text_instead_of_stale_native_state() {
        let mut reasoning = reasoning_with(
            Some("rs_1"),
            vec![
                ReasoningContent::Summary("original".into()),
                ReasoningContent::Encrypted("opaque".into()),
            ],
        );
        reasoning.text = "edited".into();
        let mut parts = LiveAssistantParts::default();
        let mut metadata = HashMap::new();
        apply_completed_reasoning(&mut parts, &mut metadata, "stream", "corr", &reasoning);
        assert_eq!(reasoning_summary_text(&reasoning), "edited");
        assert_eq!(metadata["reasoning:stream:corr"], serde_json::json!({}));
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
                },
                "reasoningIssuer": "openai"
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
    fn completed_reasoning_replaces_metadata_without_stale_opaque_state() {
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
        assert_eq!(
            provider_metadata["reasoning:stream:corr"],
            serde_json::json!({
                "reasoningIssuer": "openai"
            })
        );
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
