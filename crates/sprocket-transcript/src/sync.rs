use serde::Deserialize;
use serde::Deserializer;
use sprocket_convex::{deserialize_convex_u32, deserialize_convex_u64};

use super::store::TranscriptStore;
use super::types::{
    HiddenPromptKind, TranscriptAttachmentMeta, TranscriptCompletionBody, TranscriptPart,
    TranscriptPartKind, TranscriptPromptBody, TranscriptState, TranscriptToolBody,
};

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTranscriptState {
    pub thread_id: String,
    #[serde(deserialize_with = "deserialize_convex_u32")]
    pub total_parts: u32,
    #[serde(deserialize_with = "deserialize_convex_u32")]
    pub history_from_number: u32,
    #[serde(default)]
    pub context_summary: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_convex_i64")]
    pub reasoning_stripped_through_part_number: Option<i64>,
}

fn deserialize_optional_convex_i64<'de, D>(deserializer: D) -> Result<Option<i64>, D::Error>
where
    D: Deserializer<'de>,
{
    let Some(value) = Option::<f64>::deserialize(deserializer)? else {
        return Ok(None);
    };
    if !value.is_finite() || value.fract() != 0.0 {
        return Err(serde::de::Error::custom(format!(
            "expected an integer-compatible Convex number, got {value}"
        )));
    }
    Ok(Some(value as i64))
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemotePartsResult {
    parts: Vec<RemoteTranscriptPart>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteTranscriptPart {
    #[serde(deserialize_with = "deserialize_convex_u32")]
    number: u32,
    source_key: String,
    kind: String,
    run_id: String,
    #[serde(default)]
    work: super::sections::WorkAssignment,
    #[serde(
        rename = "_creationTime",
        default,
        deserialize_with = "deserialize_creation_time"
    )]
    created_at: Option<u64>,
    prompt: Option<RemotePrompt>,
    completion: Option<RemoteCompletion>,
    tool: Option<RemoteTool>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemotePrompt {
    text: String,
    image_uploads: Vec<RemoteAttachment>,
    #[serde(default)]
    hidden: Option<HiddenPromptKind>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteAttachment {
    name: String,
    media_type: String,
    #[serde(deserialize_with = "deserialize_convex_u64")]
    size: u64,
    storage_id: String,
    #[serde(default)]
    url: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteCompletion {
    #[serde(default)]
    stream_id: Option<String>,
    items: Vec<serde_json::Value>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteTool {
    #[serde(default)]
    job_id: Option<String>,
    #[serde(default)]
    tool_invocation_id: Option<String>,
    call_id: String,
    name: String,
    #[serde(default)]
    input: Option<serde_json::Value>,
    #[serde(default)]
    output: Option<serde_json::Value>,
    status: String,
}

fn deserialize_creation_time<'de, D>(deserializer: D) -> Result<Option<u64>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<f64>::deserialize(deserializer)?
        .map(|value| {
            if !value.is_finite() || value < 0.0 || value >= u64::MAX as f64 {
                return Err(serde::de::Error::custom("invalid transcript creation time"));
            }
            // Convex creation times can include fractional milliseconds.
            Ok(value as u64)
        })
        .transpose()
}

impl From<RemotePrompt> for TranscriptPromptBody {
    fn from(prompt: RemotePrompt) -> Self {
        Self {
            text: prompt.text,
            image_uploads: prompt
                .image_uploads
                .into_iter()
                .map(|upload| TranscriptAttachmentMeta {
                    name: upload.name,
                    media_type: upload.media_type,
                    size: upload.size,
                    storage_id: upload.storage_id,
                    url: upload.url,
                    local_path: None,
                })
                .collect(),
            hidden: prompt.hidden,
        }
    }
}

/// Reads a prompt body from a Convex function result.
pub fn deserialize_remote_prompt<'de, D>(
    deserializer: D,
) -> Result<Option<TranscriptPromptBody>, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(Option::<RemotePrompt>::deserialize(deserializer)?.map(TranscriptPromptBody::from))
}

fn to_local_part(part: RemoteTranscriptPart) -> anyhow::Result<TranscriptPart> {
    let kind = match part.kind.as_str() {
        "prompt" => TranscriptPartKind::Prompt,
        "completion" => TranscriptPartKind::Completion,
        "tool" => TranscriptPartKind::Tool,
        other => anyhow::bail!("unknown transcript part kind {other}"),
    };
    Ok(TranscriptPart {
        number: part.number,
        source_key: part.source_key,
        kind,
        run_id: part.run_id,
        created_at: part.created_at,
        prompt: part.prompt.map(TranscriptPromptBody::from),
        completion: part.completion.map(|completion| TranscriptCompletionBody {
            stream_id: completion.stream_id,
            items: completion.items,
        }),
        tool: part.tool.map(|tool| TranscriptToolBody {
            job_id: tool.job_id,
            tool_invocation_id: tool.tool_invocation_id,
            call_id: tool.call_id,
            name: tool.name,
            input: tool.input,
            output: tool.output,
            status: tool.status,
        }),
        work: part.work,
    })
}

pub async fn apply_remote_state(
    store: &TranscriptStore,
    user_id: &str,
    thread_id: &str,
    remote: &RemoteTranscriptState,
    stale: bool,
) -> anyhow::Result<TranscriptState> {
    anyhow::ensure!(
        remote.thread_id == thread_id,
        "transcript state belongs to another thread"
    );
    store
        .update_state(user_id, thread_id, |state| {
            state.remote_total_parts = remote.total_parts;
            state.history_from_number = remote.history_from_number;
            state.context_summary = remote.context_summary.clone();
            state.reasoning_stripped_through_part_number =
                remote.reasoning_stripped_through_part_number;
            state.stale = stale;
        })
        .await
}

fn parse_remote_parts(value: serde_json::Value) -> anyhow::Result<Vec<TranscriptPart>> {
    let parsed: RemotePartsResult = serde_json::from_value(value)?;
    parsed.parts.into_iter().map(to_local_part).collect()
}

pub fn parse_remote_page(
    value: serde_json::Value,
    thread_id: &str,
) -> anyhow::Result<Vec<TranscriptPart>> {
    anyhow::ensure!(
        value.get("threadId").and_then(serde_json::Value::as_str) == Some(thread_id),
        "transcript page belongs to another thread"
    );
    parse_remote_parts(value)
}

#[cfg(test)]
mod tests;
