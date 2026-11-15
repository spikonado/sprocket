use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::types::TranscriptPart;
pub use super::types::{WorkAssignment, WorkRange};

pub const POSITION_STRIDE: u64 = 16_384;

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub struct WorkPosition {
    #[serde(deserialize_with = "sprocket_convex::deserialize_convex_u32")]
    pub part: u32,
    #[serde(deserialize_with = "sprocket_convex::deserialize_convex_u32")]
    pub item: u32,
}

impl WorkPosition {
    pub fn sequence(self) -> u64 {
        u64::from(self.part) * POSITION_STRIDE + u64::from(self.item) * 2
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkBlock {
    pub id: String,
    pub run_id: String,
    pub items: Vec<WorkPosition>,
    pub closed: bool,
}

pub(super) fn item_index(item: &Value, offset: usize) -> usize {
    item.get("id")
        .or_else(|| item.get("partId"))
        .and_then(Value::as_str)
        .and_then(|id| id.rsplit(':').next())
        .and_then(|index| index.parse().ok())
        .unwrap_or(offset)
}

pub(super) fn item_id(kind: &str, part: &TranscriptPart, offset: usize) -> String {
    let index = part
        .content_items()
        .get(offset)
        .map_or(offset, |item| item_index(item, offset));
    format!("{kind}:{}:{}:{index}", part.run_id, part.source_key)
}

/// Parts must be in transcript order. Blocks continue across parts within each run.
pub fn derive_work_blocks<'a>(
    parts: impl IntoIterator<Item = &'a TranscriptPart>,
) -> Vec<WorkBlock> {
    let mut blocks: Vec<WorkBlock> = Vec::new();
    let mut open: BTreeMap<&str, usize> = BTreeMap::new();
    for part in parts {
        for (offset, item) in part.content_items().iter().enumerate() {
            match item["type"].as_str() {
                Some("reasoning" | "text")
                    if item["text"]
                        .as_str()
                        .is_none_or(|text| text.trim().is_empty()) =>
                {
                    continue;
                }
                Some("text") => {
                    if let Some(index) = open.remove(part.run_id.as_str()) {
                        blocks[index].closed = true;
                    }
                    continue;
                }
                Some("reasoning" | "tool-call") => {}
                _ => continue,
            }
            let index = *open.entry(part.run_id.as_str()).or_insert_with(|| {
                blocks.push(WorkBlock {
                    id: item_id("work", part, offset),
                    run_id: part.run_id.clone(),
                    items: Vec::new(),
                    closed: false,
                });
                blocks.len() - 1
            });
            blocks[index].items.push(WorkPosition {
                part: part.number,
                item: offset as u32,
            });
        }
    }
    blocks
}

impl TranscriptPart {
    pub fn work_assignment(&self) -> &WorkAssignment {
        &self.work
    }

    pub fn content_items(&self) -> &[Value] {
        self.completion
            .as_ref()
            .map_or(&[], |completion| completion.items.as_slice())
    }

    pub fn without_work_assignment(mut self) -> Self {
        self.work = WorkAssignment::default();
        self
    }
}

#[derive(Clone, Debug)]
pub struct WorkItem {
    pub run_id: String,
    pub source: WorkPosition,
    pub call_id: Option<String>,
    pub tool_invocation_id: Option<String>,
    pub result_part: Option<u32>,
    pub canonical: bool,
}

impl WorkItem {
    pub(super) fn identity(&self) -> Option<String> {
        self.tool_invocation_id
            .as_ref()
            .map(|id| format!("invocation:{id}"))
            .or_else(|| self.call_id.as_ref().map(|id| format!("call:{id}")))
    }

    pub(super) fn tool_event(part: &TranscriptPart) -> Option<Self> {
        let tool = part.tool.as_ref()?;
        if tool.status == "started" {
            return None;
        }
        Some(Self {
            run_id: part.run_id.clone(),
            source: WorkPosition {
                part: part.number,
                item: 0,
            },
            call_id: (!tool.call_id.is_empty()).then(|| tool.call_id.clone()),
            tool_invocation_id: tool.tool_invocation_id.clone(),
            result_part: Some(part.number),
            canonical: false,
        })
    }
}

pub(super) fn string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

#[cfg(test)]
mod tests;
