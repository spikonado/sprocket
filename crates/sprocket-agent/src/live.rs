use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

const CHANNEL_CAPACITY: usize = 64;

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "type")]
pub enum LiveAssistantPart {
    #[serde(rename = "text")]
    Text {
        id: String,
        text: String,
        #[serde(rename = "startedAt", default, skip_serializing_if = "Option::is_none")]
        started_at: Option<u64>,
        #[serde(
            rename = "completedAt",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        completed_at: Option<u64>,
        #[serde(rename = "turnId", skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
    },
    #[serde(rename = "reasoning")]
    Reasoning {
        id: String,
        text: String,
        #[serde(rename = "startedAt", default, skip_serializing_if = "Option::is_none")]
        started_at: Option<u64>,
        #[serde(
            rename = "completedAt",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        completed_at: Option<u64>,
        #[serde(rename = "turnId", skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
    },
    #[serde(rename = "tool-call")]
    ToolCall {
        #[serde(rename = "partId", skip_serializing_if = "Option::is_none")]
        part_id: Option<String>,
        #[serde(rename = "callId")]
        call_id: String,
        name: String,
        input: serde_json::Value,
        #[serde(rename = "startedAt", default, skip_serializing_if = "Option::is_none")]
        started_at: Option<u64>,
        #[serde(
            rename = "completedAt",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        completed_at: Option<u64>,
        #[serde(rename = "turnId", skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
    },
}

#[derive(Clone, Debug, Default)]
pub(crate) struct LiveAssistantParts {
    pub parts: Vec<LiveAssistantPart>,
    text_index: HashMap<String, usize>,
    tool_index: HashMap<String, usize>,
}

impl LiveAssistantParts {
    pub(crate) fn order_stream_parts(&mut self, stream_id: &str) {
        self.parts.sort_by_key(|part| {
            let id = match part {
                LiveAssistantPart::Text { id, .. } | LiveAssistantPart::Reasoning { id, .. } => {
                    Some(id.as_str())
                }
                LiveAssistantPart::ToolCall { part_id, .. } => part_id.as_deref(),
            };
            id.and_then(|id| id.strip_prefix(stream_id))
                .and_then(|suffix| suffix.rsplit(':').next())
                .and_then(|index| index.parse::<usize>().ok())
                .unwrap_or(usize::MAX)
        });
        self.text_index.clear();
        self.tool_index.clear();
        for (index, part) in self.parts.iter().enumerate() {
            match part {
                LiveAssistantPart::Text { id, .. } => {
                    self.text_index.insert(format!("text:{id}"), index);
                }
                LiveAssistantPart::Reasoning { id, .. } => {
                    self.text_index.insert(format!("reasoning:{id}"), index);
                }
                LiveAssistantPart::ToolCall {
                    part_id, call_id, ..
                } => {
                    self.tool_index
                        .insert(part_id.clone().unwrap_or_else(|| call_id.clone()), index);
                }
            }
        }
    }

    pub fn clear(&mut self) {
        self.parts.clear();
        self.text_index.clear();
        self.tool_index.clear();
    }

    pub fn apply_text_delta(
        &mut self,
        event_type: &str,
        id: String,
        delta: &str,
        turn_id: Option<String>,
        now_ms: u64,
    ) {
        let key = format!("{event_type}:{id}");
        if let Some(&index) = self.text_index.get(&key) {
            match &mut self.parts[index] {
                LiveAssistantPart::Text {
                    text,
                    started_at,
                    completed_at,
                    turn_id: existing,
                    ..
                } if event_type == "text" => {
                    text.push_str(delta);
                    if started_at.is_none() {
                        *started_at = Some(now_ms);
                    }
                    *completed_at = Some(now_ms);
                    if turn_id.is_some() {
                        *existing = turn_id;
                    }
                }
                LiveAssistantPart::Reasoning {
                    text,
                    started_at,
                    completed_at,
                    turn_id: existing,
                    ..
                } if event_type == "reasoning" => {
                    text.push_str(delta);
                    if started_at.is_none() {
                        *started_at = Some(now_ms);
                    }
                    *completed_at = Some(now_ms);
                    if turn_id.is_some() {
                        *existing = turn_id;
                    }
                }
                _ => {}
            }
            return;
        }
        let part = if event_type == "reasoning" {
            LiveAssistantPart::Reasoning {
                id,
                text: delta.to_string(),
                started_at: Some(now_ms),
                completed_at: Some(now_ms),
                turn_id,
            }
        } else {
            LiveAssistantPart::Text {
                id,
                text: delta.to_string(),
                started_at: Some(now_ms),
                completed_at: Some(now_ms),
                turn_id,
            }
        };
        self.text_index.insert(key, self.parts.len());
        self.parts.push(part);
    }

    pub fn apply_tool_call(
        &mut self,
        part_id: Option<String>,
        call_id: String,
        name: String,
        input: serde_json::Value,
        turn_id: Option<String>,
        now_ms: u64,
    ) {
        let key = part_id.clone().unwrap_or_else(|| call_id.clone());
        let started_at = self
            .tool_index
            .get(&key)
            .and_then(|&index| match &self.parts[index] {
                LiveAssistantPart::ToolCall { started_at, .. } => *started_at,
                _ => None,
            })
            .or(Some(now_ms));
        let part = LiveAssistantPart::ToolCall {
            part_id,
            call_id,
            name,
            input,
            started_at,
            completed_at: Some(now_ms),
            turn_id,
        };
        if let Some(&index) = self.tool_index.get(&key) {
            self.parts[index] = part;
        } else {
            self.tool_index.insert(key, self.parts.len());
            self.parts.push(part);
        }
    }

    pub fn apply_completed_text(
        &mut self,
        id: String,
        text: String,
        turn_id: Option<String>,
        now_ms: u64,
    ) -> String {
        let key = format!("text:{id}");
        if let Some(&index) = self.text_index.get(&key)
            && let LiveAssistantPart::Text {
                text: existing,
                completed_at,
                turn_id: existing_turn,
                ..
            } = &mut self.parts[index]
        {
            *completed_at = Some(now_ms);
            *existing_turn = turn_id;
            return std::mem::replace(existing, text);
        }
        self.text_index.insert(key, self.parts.len());
        self.parts.push(LiveAssistantPart::Text {
            id,
            text,
            started_at: Some(now_ms),
            completed_at: Some(now_ms),
            turn_id,
        });
        String::new()
    }

    pub fn apply_completed_reasoning(
        &mut self,
        id: String,
        text: String,
        turn_id: Option<String>,
        now_ms: u64,
    ) {
        let key = format!("reasoning:{id}");
        if let Some(&index) = self.text_index.get(&key) {
            if let LiveAssistantPart::Reasoning {
                text: existing,
                completed_at,
                turn_id: existing_turn,
                ..
            } = &mut self.parts[index]
            {
                *existing = text;
                *completed_at = Some(now_ms);
                *existing_turn = turn_id;
                return;
            }
        }
        self.text_index.insert(key, self.parts.len());
        self.parts.push(LiveAssistantPart::Reasoning {
            id,
            text,
            started_at: Some(now_ms),
            completed_at: Some(now_ms),
            turn_id,
        });
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveCompletionOverlay {
    pub thread_id: String,
    pub run_id: String,
    pub run_status: String,
    pub stream_id: String,
    pub text: String,
    pub parts: Vec<LiveAssistantPart>,
    pub run_started_at: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "eventType", rename_all = "camelCase")]
pub enum LiveCompletionWatchEvent {
    Updated { live: LiveCompletionOverlay },
    Cleared,
}

struct Slot {
    snapshot: Option<LiveCompletionOverlay>,
    events: broadcast::Sender<LiveCompletionWatchEvent>,
}

pub struct LiveCompletionHub {
    inner: Mutex<HashMap<String, Slot>>,
}

pub struct LiveCompletionSubscription {
    pub snapshot: Option<LiveCompletionOverlay>,
    pub receiver: broadcast::Receiver<LiveCompletionWatchEvent>,
}

impl LiveCompletionHub {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Slot>> {
        let mut map = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        map.retain(|_, slot| slot.snapshot.is_some() || slot.events.receiver_count() > 0);
        map
    }

    fn slot<'a>(map: &'a mut HashMap<String, Slot>, thread_id: &str) -> &'a mut Slot {
        map.entry(thread_id.to_string()).or_insert_with(|| {
            let (events, _) = broadcast::channel(CHANNEL_CAPACITY);
            Slot {
                snapshot: None,
                events,
            }
        })
    }

    pub fn publish(&self, overlay: LiveCompletionOverlay) {
        let mut map = self.lock();
        let slot = Self::slot(&mut map, &overlay.thread_id);
        slot.snapshot = Some(overlay.clone());
        let _ = slot
            .events
            .send(LiveCompletionWatchEvent::Updated { live: overlay });
    }

    pub fn clear(&self, thread_id: &str) {
        let mut map = self.lock();
        let Some(slot) = map.get_mut(thread_id) else {
            return;
        };
        slot.snapshot = None;
        let _ = slot.events.send(LiveCompletionWatchEvent::Cleared);
        if slot.events.receiver_count() == 0 {
            map.remove(thread_id);
        }
    }

    pub fn subscribe(&self, thread_id: &str) -> LiveCompletionSubscription {
        let mut map = self.lock();
        let slot = Self::slot(&mut map, thread_id);
        LiveCompletionSubscription {
            snapshot: slot.snapshot.clone(),
            receiver: slot.events.subscribe(),
        }
    }

    pub fn snapshot(&self, thread_id: &str) -> Option<LiveCompletionOverlay> {
        self.lock()
            .get(thread_id)
            .and_then(|slot| slot.snapshot.clone())
    }
}

pub(crate) fn join_assistant_text_parts(parts: &[LiveAssistantPart]) -> String {
    let mut text = String::new();
    let mut previous_turn_id: Option<&str> = None;
    let mut saw_text = false;
    for part in parts {
        let LiveAssistantPart::Text {
            text: part_text,
            turn_id,
            ..
        } = part
        else {
            continue;
        };
        if part_text.is_empty() {
            continue;
        }
        if saw_text
            && previous_turn_id.is_some()
            && turn_id
                .as_deref()
                .is_some_and(|turn| Some(turn) != previous_turn_id)
        {
            text.push_str("\n\n");
        }
        text.push_str(part_text);
        if let Some(turn) = turn_id.as_deref() {
            previous_turn_id = Some(turn);
        }
        saw_text = true;
    }
    text
}

#[cfg(test)]
mod tests;
