use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

const CHANNEL_CAPACITY: usize = 64;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "type")]
pub enum LiveAssistantPart {
    #[serde(rename = "text")]
    Text {
        id: String,
        text: String,
        #[serde(rename = "turnId", skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
    },
    #[serde(rename = "reasoning")]
    Reasoning {
        id: String,
        text: String,
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
        #[serde(rename = "turnId", skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
    },
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
                turn_id: Some("stream-1".to_string()),
            }],
            run_started_at: 1,
        }
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
