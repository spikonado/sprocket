use anyhow::Context;
use serde::Deserialize;
use serde::Deserializer;
use sprocket_convex::{deserialize_convex_u32, deserialize_convex_u64};

use super::store::TranscriptStore;
use super::types::{
    TRANSCRIPT_CHUNK_SIZE, TranscriptAttachmentMeta, TranscriptCompletionBody, TranscriptPart,
    TranscriptPartKind, TranscriptPromptBody, TranscriptState, TranscriptToolBody,
};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTranscriptState {
    pub thread_id: String,
    #[serde(deserialize_with = "deserialize_convex_u32")]
    pub total_parts: u32,
    #[serde(deserialize_with = "deserialize_convex_u32")]
    pub history_from_number: u32,
    #[serde(default)]
    pub context_summary: Option<String>,
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
    #[serde(default)]
    image_uploads: Vec<RemoteAttachment>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteAttachment {
    image_upload_id: String,
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
        prompt: part.prompt.map(|prompt| TranscriptPromptBody {
            text: prompt.text,
            image_uploads: prompt
                .image_uploads
                .into_iter()
                .map(|upload| TranscriptAttachmentMeta {
                    image_upload_id: upload.image_upload_id,
                    name: upload.name,
                    media_type: upload.media_type,
                    size: upload.size,
                    storage_id: upload.storage_id,
                    url: upload.url,
                })
                .collect(),
        }),
        completion: part.completion.map(|completion| TranscriptCompletionBody {
            stream_id: completion.stream_id,
            items: completion.items,
        }),
        tool: part.tool.map(|tool| TranscriptToolBody {
            job_id: tool.job_id,
            tool_invocation_id: tool.tool_invocation_id,
            call_id: tool.call_id,
            name: tool.name,
            output: tool.output,
            status: tool.status,
        }),
    })
}

pub async fn apply_remote_state(
    store: &TranscriptStore,
    user_id: &str,
    thread_id: &str,
    remote: &RemoteTranscriptState,
    stale: bool,
) -> anyhow::Result<TranscriptState> {
    store
        .update_state(user_id, thread_id, |state| {
            state.remote_total_parts = remote.total_parts;
            state.history_from_number = remote.history_from_number;
            state.context_summary = remote.context_summary.clone();
            state.stale = stale;
        })
        .await
}

pub async fn fetch_parts_by_numbers<F, Fut>(
    numbers: &[u32],
    mut fetch: F,
) -> anyhow::Result<Vec<TranscriptPart>>
where
    F: FnMut(Vec<u32>) -> Fut,
    Fut: std::future::Future<Output = anyhow::Result<Vec<TranscriptPart>>>,
{
    let mut fetched = Vec::new();
    for chunk in numbers.chunks(TRANSCRIPT_CHUNK_SIZE as usize) {
        fetched.extend(
            fetch(chunk.to_vec())
                .await
                .context("fetch transcript parts")?,
        );
    }
    Ok(fetched)
}

pub async fn fetch_missing_parts<F, Fut>(
    store: &TranscriptStore,
    user_id: &str,
    thread_id: &str,
    start: u32,
    end_exclusive: u32,
    mut fetch: F,
) -> anyhow::Result<Vec<TranscriptPart>>
where
    F: FnMut(Vec<u32>) -> Fut,
    Fut: std::future::Future<Output = anyhow::Result<Vec<TranscriptPart>>>,
{
    let missing = store
        .missing_numbers(user_id, thread_id, start, end_exclusive)
        .await?;
    let mut fetched = Vec::new();
    for chunk in missing.chunks(TRANSCRIPT_CHUNK_SIZE as usize) {
        let parts = fetch(chunk.to_vec())
            .await
            .context("fetch transcript parts")?;
        store.append_parts(user_id, thread_id, &parts).await?;
        fetched.extend(parts);
    }
    Ok(fetched)
}

pub fn parse_remote_parts(value: serde_json::Value) -> anyhow::Result<Vec<TranscriptPart>> {
    let parsed: RemotePartsResult = serde_json::from_value(value)?;
    parsed.parts.into_iter().map(to_local_part).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prompt(number: u32) -> TranscriptPart {
        TranscriptPart {
            number,
            source_key: format!("prompt:{number}"),
            kind: TranscriptPartKind::Prompt,
            run_id: format!("run-{number}"),
            created_at: None,
            prompt: Some(TranscriptPromptBody {
                text: format!("{number}"),
                image_uploads: Vec::new(),
            }),
            completion: None,
            tool: None,
        }
    }

    #[tokio::test]
    async fn fetches_only_missing_numbers() {
        let dir = std::env::temp_dir().join(format!("sprocket-sync-{}", uuid::Uuid::new_v4()));
        let store = TranscriptStore::new(dir.clone());
        store
            .append_parts("user", "thread", &[prompt(1)])
            .await
            .unwrap();
        let fetched = fetch_missing_parts(&store, "user", "thread", 0, 3, |numbers| async move {
            Ok(numbers.into_iter().map(prompt).collect())
        })
        .await
        .unwrap();
        assert_eq!(
            fetched.iter().map(|part| part.number).collect::<Vec<_>>(),
            vec![0, 2]
        );
        assert_eq!(
            store
                .read_parts("user", "thread", &[0, 1, 2])
                .await
                .unwrap()
                .iter()
                .map(|part| part.number)
                .collect::<Vec<_>>(),
            vec![0, 1, 2]
        );
        let _ = tokio::fs::remove_dir_all(dir).await;
    }

    #[test]
    fn remote_parts_read_convex_creation_time() {
        let parts = parse_remote_parts(serde_json::json!({
            "parts": [{
                "number": 2.0,
                "sourceKey": "tool:inv:started",
                "kind": "tool",
                "runId": "run",
                "_creationTime": 1_700_000_000_000.125,
                "tool": {
                    "callId": "c1",
                    "name": "exec_command",
                    "status": "started"
                }
            }]
        }))
        .unwrap();
        assert_eq!(parts[0].created_at, Some(1_700_000_000_000));
        assert_eq!(parts[0].tool.as_ref().unwrap().call_id, "c1");
    }

    #[test]
    fn remote_parts_keep_working_without_creation_time() {
        let parts = parse_remote_parts(serde_json::json!({
            "parts": [{
                "number": 0.0,
                "sourceKey": "prompt:0",
                "kind": "prompt",
                "runId": "run",
                "prompt": { "text": "hi", "imageUploads": [] }
            }]
        }))
        .unwrap();
        assert_eq!(parts[0].created_at, None);
        assert_eq!(parts[0].prompt.as_ref().unwrap().text, "hi");
    }
}
