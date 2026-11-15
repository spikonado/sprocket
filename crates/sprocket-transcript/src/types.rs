use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

pub const TRANSCRIPT_CHUNK_SIZE: u32 = 100;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct TranscriptState {
    pub remote_total_parts: u32,
    pub history_from_number: u32,
    pub context_summary: Option<String>,
    pub reasoning_stripped_through_part_number: Option<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", from = "TranscriptPartReader")]
pub struct TranscriptPart {
    pub number: u32,
    pub source_key: String,
    pub kind: TranscriptPartKind,
    pub run_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<TranscriptPromptBody>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completion: Option<TranscriptCompletionBody>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<TranscriptToolBody>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TranscriptPartReader {
    number: u32,
    source_key: String,
    kind: TranscriptPartKind,
    run_id: String,
    #[serde(default)]
    created_at: Option<u64>,
    #[serde(default)]
    prompt: Option<TranscriptPromptBody>,
    #[serde(default)]
    completion: Option<TranscriptCompletionBody>,
    #[serde(default)]
    tool: Option<TranscriptToolBody>,
    #[serde(default)]
    work: LegacyWork,
}

impl From<TranscriptPartReader> for TranscriptPart {
    fn from(reader: TranscriptPartReader) -> Self {
        let mut part = Self {
            number: reader.number,
            source_key: reader.source_key,
            kind: reader.kind,
            run_id: reader.run_id,
            created_at: reader.created_at,
            prompt: reader.prompt,
            completion: reader.completion,
            tool: reader.tool,
        };
        reader.work.move_tool_invocations(part.completion.as_mut());
        part
    }
}

/// The `work` field of parts saved for released clients. Only its tool invocation IDs, which
/// belong on the completion's call items, are still read.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyWork {
    #[serde(default)]
    tool_invocations: Vec<LegacyToolInvocation>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyToolInvocation {
    #[serde(deserialize_with = "sprocket_convex::deserialize_convex_u32")]
    item: u32,
    tool_invocation_id: String,
}

impl LegacyWork {
    pub fn move_tool_invocations(self, completion: Option<&mut TranscriptCompletionBody>) {
        let Some(completion) = completion else {
            return;
        };
        for invocation in self.tool_invocations {
            if let Some(item) = completion.items.get_mut(invocation.item as usize)
                && item["type"] == "tool-call"
                && let Some(object) = item.as_object_mut()
            {
                object
                    .entry("toolInvocationId")
                    .or_insert(JsonValue::String(invocation.tool_invocation_id));
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TranscriptPartKind {
    Prompt,
    Completion,
    Tool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptPromptBody {
    pub text: String,
    pub image_uploads: Vec<TranscriptAttachmentMeta>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hidden: Option<HiddenPromptKind>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum HiddenPromptKind {
    Instructions,
    Environment,
    Continuation,
    #[serde(other)]
    Other,
}

impl TranscriptPromptBody {
    pub fn text_with_attachments(&self) -> String {
        if self.image_uploads.is_empty() {
            return self.text.clone();
        }
        let attachments = self
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
            self.text,
            serde_json::json!(attachments)
        )
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptAttachmentMeta {
    pub name: String,
    pub media_type: String,
    pub size: u64,
    pub storage_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_path: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptCompletionBody {
    pub items: Vec<JsonValue>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptToolBody {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub job_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_invocation_id: Option<String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub call_id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<JsonValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<JsonValue>,
    pub status: String,
}

impl TranscriptPart {
    pub fn without_ephemeral_urls(&self) -> Self {
        let mut part = self.clone();
        if let Some(prompt) = part.prompt.as_mut() {
            for upload in &mut prompt.image_uploads {
                upload.url = None;
                upload.local_path = None;
            }
        }
        part
    }
}

#[cfg(test)]
mod tests;
