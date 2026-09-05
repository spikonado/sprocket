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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream_id: Option<String>,
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

    #[cfg(test)]
    fn slot_count(&self) -> usize {
        self.lock().len()
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
mod tests {
    use super::*;

    fn overlay(thread_id: &str, text: &str) -> LiveCompletionOverlay {
        LiveCompletionOverlay {
            thread_id: thread_id.to_string(),
            run_id: "run-1".to_string(),
            run_status: "running".to_string(),
            stream_id: Some("stream-1".to_string()),
            text: text.to_string(),
            parts: vec![LiveAssistantPart::Text {
                id: "t".to_string(),
                text: text.to_string(),
                started_at: None,
                completed_at: None,
                turn_id: Some("stream-1".to_string()),
            }],
            run_started_at: 1,
        }
    }

    #[test]
    fn live_parts_keep_old_json_without_timing() {
        let part: LiveAssistantPart = serde_json::from_value(serde_json::json!({
            "type": "text",
            "id": "t",
            "text": "hello",
            "turnId": "stream-1"
        }))
        .unwrap();
        assert_eq!(
            part,
            LiveAssistantPart::Text {
                id: "t".into(),
                text: "hello".into(),
                started_at: None,
                completed_at: None,
                turn_id: Some("stream-1".into()),
            }
        );
    }

    #[test]
    fn text_and_reasoning_record_start_once_and_update_end() {
        let mut parts = LiveAssistantParts::default();
        parts.apply_text_delta("text", "t".into(), "Hello", Some("turn".into()), 10);
        parts.apply_text_delta("text", "t".into(), "!", Some("turn".into()), 25);
        parts.apply_text_delta("reasoning", "r".into(), "think", Some("turn".into()), 11);
        parts.apply_text_delta("reasoning", "r".into(), " more", Some("turn".into()), 40);

        assert_eq!(
            parts.parts,
            vec![
                LiveAssistantPart::Text {
                    id: "t".into(),
                    text: "Hello!".into(),
                    started_at: Some(10),
                    completed_at: Some(25),
                    turn_id: Some("turn".into()),
                },
                LiveAssistantPart::Reasoning {
                    id: "r".into(),
                    text: "think more".into(),
                    started_at: Some(11),
                    completed_at: Some(40),
                    turn_id: Some("turn".into()),
                }
            ]
        );
        assert_eq!(
            serde_json::to_value(&parts.parts).unwrap()[0]["startedAt"],
            serde_json::json!(10)
        );
    }

    #[test]
    fn tool_replacement_keeps_the_original_start() {
        let mut parts = LiveAssistantParts::default();
        parts.apply_tool_call(
            Some("p1".into()),
            "c1".into(),
            "exec_command".into(),
            serde_json::json!({"cmd": "echo"}),
            Some("turn".into()),
            50,
        );
        parts.apply_tool_call(
            Some("p1".into()),
            "c1".into(),
            "exec_command".into(),
            serde_json::json!({"cmd": "ls"}),
            Some("turn".into()),
            80,
        );

        assert_eq!(
            parts.parts,
            vec![LiveAssistantPart::ToolCall {
                part_id: Some("p1".into()),
                call_id: "c1".into(),
                name: "exec_command".into(),
                input: serde_json::json!({"cmd": "ls"}),
                started_at: Some(50),
                completed_at: Some(80),
                turn_id: Some("turn".into()),
            }]
        );
    }

    #[test]
    fn completed_reasoning_keeps_delta_start_and_sets_end() {
        let mut parts = LiveAssistantParts::default();
        parts.apply_text_delta("reasoning", "s:c".into(), "partial", Some("s".into()), 10);
        parts.apply_completed_reasoning("s:c".into(), "done".into(), Some("s".into()), 50);

        assert_eq!(
            parts.parts,
            vec![LiveAssistantPart::Reasoning {
                id: "s:c".into(),
                text: "done".into(),
                started_at: Some(10),
                completed_at: Some(50),
                turn_id: Some("s".into()),
            }]
        );
    }

    #[test]
    fn empty_completed_reasoning_sets_start_and_end() {
        let mut parts = LiveAssistantParts::default();
        parts.apply_completed_reasoning("s:c".into(), String::new(), Some("s".into()), 70);

        assert_eq!(
            parts.parts,
            vec![LiveAssistantPart::Reasoning {
                id: "s:c".into(),
                text: String::new(),
                started_at: Some(70),
                completed_at: Some(70),
                turn_id: Some("s".into()),
            }]
        );
    }

    #[test]
    fn completed_reasoning_appends_when_indexed_slot_is_not_reasoning() {
        let mut parts = LiveAssistantParts::default();
        parts.apply_text_delta("reasoning", "s:c".into(), "stale", Some("s".into()), 10);
        parts.parts[0] = LiveAssistantPart::ToolCall {
            part_id: Some("p1".into()),
            call_id: "c1".into(),
            name: "exec_command".into(),
            input: serde_json::json!({"cmd": "pwd"}),
            started_at: Some(10),
            completed_at: Some(10),
            turn_id: Some("s".into()),
        };
        parts.apply_completed_reasoning("s:c".into(), "late".into(), Some("s".into()), 90);
        parts.apply_completed_reasoning("s:c".into(), "late again".into(), Some("s".into()), 95);

        assert_eq!(
            parts.parts,
            vec![
                LiveAssistantPart::ToolCall {
                    part_id: Some("p1".into()),
                    call_id: "c1".into(),
                    name: "exec_command".into(),
                    input: serde_json::json!({"cmd": "pwd"}),
                    started_at: Some(10),
                    completed_at: Some(10),
                    turn_id: Some("s".into()),
                },
                LiveAssistantPart::Reasoning {
                    id: "s:c".into(),
                    text: "late again".into(),
                    started_at: Some(90),
                    completed_at: Some(95),
                    turn_id: Some("s".into()),
                }
            ]
        );
    }

    #[tokio::test]
    async fn publish_replaces_snapshot_and_fans_out() {
        let hub = LiveCompletionHub::new();
        let mut first = hub.subscribe("thread-1");
        let mut second = hub.subscribe("thread-1");
        assert!(first.snapshot.is_none());
        assert!(second.snapshot.is_none());

        let live = overlay("thread-1", "Hello");
        hub.publish(live.clone());

        assert_eq!(hub.snapshot("thread-1").as_ref(), Some(&live));
        assert_eq!(
            first.receiver.recv().await.expect("first subscriber"),
            LiveCompletionWatchEvent::Updated { live: live.clone() }
        );
        assert_eq!(
            second.receiver.recv().await.expect("second subscriber"),
            LiveCompletionWatchEvent::Updated { live }
        );
    }

    #[test]
    fn late_joiner_receives_current_snapshot() {
        let hub = LiveCompletionHub::new();
        hub.publish(overlay("thread-1", "partial"));
        let late = hub.subscribe("thread-1");
        assert_eq!(
            late.snapshot.as_ref().map(|live| live.text.as_str()),
            Some("partial")
        );
    }

    #[tokio::test]
    async fn clear_drops_snapshot_and_notifies() {
        let hub = LiveCompletionHub::new();
        let mut subscriber = hub.subscribe("thread-1");
        hub.publish(overlay("thread-1", "partial"));
        let _ = subscriber.receiver.recv().await;
        hub.clear("thread-1");
        assert!(hub.snapshot("thread-1").is_none());
        assert_eq!(
            subscriber.receiver.recv().await.expect("cleared"),
            LiveCompletionWatchEvent::Cleared
        );
        let late = hub.subscribe("thread-1");
        assert!(late.snapshot.is_none());
    }

    #[test]
    fn clear_drops_idle_slots_without_subscribers() {
        let hub = LiveCompletionHub::new();
        hub.publish(overlay("thread-1", "partial"));
        assert_eq!(hub.slot_count(), 1);
        hub.clear("thread-1");
        assert_eq!(hub.slot_count(), 0);
        assert!(hub.snapshot("thread-1").is_none());
    }
}
