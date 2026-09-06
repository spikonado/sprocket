use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

pub const TRANSCRIPT_CHUNK_SIZE: u32 = 100;
pub const TRANSCRIPT_PAGE_SIZE: u32 = 40;
pub const TRANSCRIPT_SCHEMA_VERSION: u32 = 1;
/// Projected when no real run start timestamp exists. Never a sequence number.
pub const UNKNOWN_RUN_STARTED_AT: u64 = 0;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptState {
    pub schema_version: u32,
    pub user_id: String,
    pub thread_id: String,
    pub remote_total_parts: u32,
    pub history_from_number: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_summary: Option<String>,
    #[serde(default)]
    pub downloaded_ranges: Vec<DownloadedRange>,
    #[serde(default)]
    pub stale: bool,
}

impl TranscriptState {
    pub fn new(user_id: String, thread_id: String) -> Self {
        Self {
            schema_version: TRANSCRIPT_SCHEMA_VERSION,
            user_id,
            thread_id,
            remote_total_parts: 0,
            history_from_number: 0,
            context_summary: None,
            downloaded_ranges: Vec::new(),
            stale: false,
        }
    }

    pub fn covers(&self, number: u32) -> bool {
        self.downloaded_ranges
            .iter()
            .any(|range| range.contains(number))
    }

    pub fn visible_end_exclusive(&self) -> u32 {
        let local_end = self
            .downloaded_ranges
            .iter()
            .map(|range| range.end.saturating_add(1))
            .max()
            .unwrap_or(0);
        self.remote_total_parts.max(local_end)
    }

    pub fn missing_in(&self, start: u32, end_exclusive: u32) -> Vec<u32> {
        (start..end_exclusive)
            .filter(|number| !self.covers(*number))
            .collect()
    }

    pub fn mark_downloaded(&mut self, numbers: &[u32]) {
        for &number in numbers {
            insert_number(&mut self.downloaded_ranges, number);
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DownloadedRange {
    pub start: u32,
    pub end: u32,
}

impl DownloadedRange {
    pub fn contains(self, number: u32) -> bool {
        number >= self.start && number <= self.end
    }
}

fn insert_number(ranges: &mut Vec<DownloadedRange>, number: u32) {
    if ranges.iter().any(|range| range.contains(number)) {
        return;
    }
    ranges.push(DownloadedRange {
        start: number,
        end: number,
    });
    ranges.sort_by_key(|range| range.start);
    let mut merged: Vec<DownloadedRange> = Vec::new();
    for range in ranges.drain(..) {
        match merged.last_mut() {
            Some(last) if range.start <= last.end.saturating_add(1) => {
                last.end = last.end.max(range.end);
            }
            _ => merged.push(range),
        }
    }
    *ranges = merged;
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
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
    #[serde(default)]
    pub image_uploads: Vec<TranscriptAttachmentMeta>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptAttachmentMeta {
    pub image_upload_id: String,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream_id: Option<String>,
    pub items: Vec<JsonValue>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptToolBody {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub job_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_invocation_id: Option<String>,
    pub call_id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<JsonValue>,
    pub status: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptPage {
    pub thread_id: String,
    pub total_parts: u32,
    pub history_from_number: u32,
    pub stale: bool,
    pub messages: Vec<TranscriptMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_before: Option<u32>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptMessage {
    pub id: String,
    pub thread_id: String,
    pub run_id: String,
    pub user_id: String,
    #[serde(rename = "type")]
    pub message_type: String,
    pub text: String,
    pub attachments: Vec<TranscriptAttachmentMeta>,
    pub parts: Vec<JsonValue>,
    pub run_status: String,
    /// Unix milliseconds. `0` means the run start was never recorded.
    pub run_started_at: u64,
    pub source_numbers: Vec<u32>,
    pub stream_ids: Vec<String>,
    pub details_loaded: bool,
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
mod tests {
    use super::*;

    #[test]
    fn merges_adjacent_downloaded_ranges() {
        let mut state = TranscriptState::new("user".into(), "thread".into());
        state.mark_downloaded(&[0, 2, 1, 5, 4]);
        assert_eq!(
            state.downloaded_ranges,
            vec![
                DownloadedRange { start: 0, end: 2 },
                DownloadedRange { start: 4, end: 5 }
            ]
        );
        assert_eq!(state.missing_in(0, 7), vec![3, 6]);
        state.remote_total_parts = 1;
        assert_eq!(state.visible_end_exclusive(), 6);
    }

    #[test]
    fn transcript_part_keeps_old_json_without_created_at() {
        let part: TranscriptPart = serde_json::from_value(serde_json::json!({
            "number": 3,
            "sourceKey": "prompt:3",
            "kind": "prompt",
            "runId": "run",
            "prompt": { "text": "hi", "imageUploads": [] }
        }))
        .unwrap();
        assert_eq!(part.number, 3);
        assert_eq!(part.created_at, None);
        assert_eq!(
            part.prompt.as_ref().map(|prompt| prompt.text.as_str()),
            Some("hi")
        );
    }
}
