use std::collections::HashMap;

use rig::message::{Api, AssistantContent, Native, Reasoning};
use serde_json::Value as JsonValue;
use sprocket_transcript::{LiveAssistantPart, LiveAssistantParts};

use crate::now_ms;

/// Every provider Sprocket streams from speaks Responses.
const RESPONSES_API: Api = Api::from_static("openai.responses");

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

fn native_reasoning(reasoning: &Reasoning) -> Option<&Native> {
    let native = reasoning.native.as_ref()?;
    (native.fingerprint == AssistantContent::Reasoning(reasoning.clone()).fingerprint())
        .then_some(native)
}

pub(crate) fn opaque_reasoning_blob(reasoning: &Reasoning) -> Option<&str> {
    Some(
        native_reasoning(reasoning)?
            .reasoning_blob(&RESPONSES_API)?
            .value,
    )
}

/// The OpenAI summary when it has text, otherwise the raw reasoning, which
/// is where Opus thinking arrives.
pub(crate) fn completed_reasoning_text(reasoning: &Reasoning) -> String {
    let summary = native_reasoning(reasoning)
        .map(|native| &native.item)
        .filter(|item| item.get("type").and_then(JsonValue::as_str) == Some("reasoning"))
        .and_then(|item| item.get("summary"))
        .and_then(JsonValue::as_array)
        .map(|summary| {
            summary
                .iter()
                .filter_map(|block| block.get("text").and_then(JsonValue::as_str))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();
    if summary.is_empty() && !reasoning.redacted {
        reasoning.text.clone()
    } else {
        summary
    }
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
    let text = completed_reasoning_text(reasoning);
    let openai = native_reasoning(reasoning)
        .map(|native| &native.item)
        .filter(|item| item.get("type").and_then(JsonValue::as_str) == Some("reasoning"));
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
mod tests;
