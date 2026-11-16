use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::types::TranscriptPart;

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub struct WorkPosition {
    #[serde(deserialize_with = "sprocket_convex::deserialize_convex_u32")]
    pub part: u32,
    #[serde(deserialize_with = "sprocket_convex::deserialize_convex_u32")]
    pub item: u32,
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

pub fn item_id(kind: &str, part: &TranscriptPart, offset: usize) -> String {
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
    pub fn content_items(&self) -> &[Value] {
        self.completion
            .as_ref()
            .map_or(&[], |completion| completion.items.as_slice())
    }
}

#[cfg(test)]
mod tests;
