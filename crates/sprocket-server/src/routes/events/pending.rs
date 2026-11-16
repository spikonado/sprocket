use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use tokio::sync::Notify;
use tokio::time::Instant;

use super::ServerMessage;

#[derive(Clone, Default)]
pub(super) struct Outgoing(Arc<Queue>);

#[derive(Default)]
struct Queue {
    pending: Mutex<Pending>,
    ready: Notify,
}

#[derive(Default)]
struct Pending {
    since: Option<Instant>,
    messages: Vec<ServerMessage>,
    rows: HashMap<u64, Rows>,
}

#[derive(Default)]
struct Rows {
    snapshot: Option<Value>,
    updates: Vec<Value>,
    positions: HashMap<String, usize>,
}

impl Outgoing {
    pub(super) fn send(&self, message: ServerMessage) {
        let mut pending = self.0.pending.lock().unwrap_or_else(|e| e.into_inner());
        pending.since.get_or_insert_with(Instant::now);
        match message {
            ServerMessage::Event { id, data } if data["type"] == "snapshot" => {
                pending.rows.insert(
                    id,
                    Rows {
                        snapshot: Some(data),
                        ..Rows::default()
                    },
                );
            }
            ServerMessage::Event { id, data } if data["type"] == "batch" => {
                if let Some(updates) = data["updates"].as_array() {
                    let rows = pending.rows.entry(id).or_default();
                    for update in updates {
                        rows.push(update.clone());
                    }
                }
            }
            ServerMessage::Event { id, data }
                if data["kind"] == "snapshot" || data["kind"] == "error" =>
            {
                pending.messages.retain(|message| !matches!(message, ServerMessage::Event { id: previous, .. } if *previous == id));
                pending.messages.push(ServerMessage::Event { id, data });
            }
            message => pending.messages.push(message),
        }
        drop(pending);
        self.0.ready.notify_one();
    }

    pub(super) fn remove(&self, id: u64) {
        let mut pending = self.0.pending.lock().unwrap_or_else(|e| e.into_inner());
        pending.rows.remove(&id);
        pending.messages.retain(|message| message.id() != id);
        if pending.rows.is_empty() && pending.messages.is_empty() {
            pending.since = None;
        }
    }

    pub(super) async fn next(&self) -> (Instant, Vec<ServerMessage>) {
        loop {
            self.0.ready.notified().await;
            let pending = {
                let mut queue = self.0.pending.lock().unwrap_or_else(|e| e.into_inner());
                std::mem::take(&mut *queue)
            };
            let Some(since) = pending.since else {
                continue;
            };
            let mut messages = Vec::new();
            for (id, rows) in pending.rows {
                if let Some(data) = rows.snapshot {
                    messages.push(ServerMessage::Event { id, data });
                }
                if !rows.updates.is_empty() {
                    messages.push(ServerMessage::Event {
                        id,
                        data: json!({"type": "batch", "updates": rows.updates}),
                    });
                }
            }
            messages.extend(pending.messages);
            if !messages.is_empty() {
                return (since, messages);
            }
        }
    }
}

impl Rows {
    fn push(&mut self, update: Value) {
        let id = if update["type"] == "row" {
            update["row"]["id"].as_str()
        } else {
            update["rowId"].as_str()
        };
        let Some(id) = id else { return };
        if let Some(&index) = self.positions.get(id) {
            let previous = &mut self.updates[index];
            if update["type"] == "append" {
                let offset = update["offset"].as_u64();
                let text = update["text"].as_str().unwrap_or_default();
                let (start, target) = if previous["type"] == "row" {
                    (Some(0), &mut previous["row"]["text"])
                } else {
                    (previous["offset"].as_u64(), &mut previous["text"])
                };
                if let (Some(start), Value::String(existing)) = (start, target)
                    && Some(start + existing.encode_utf16().count() as u64) == offset
                {
                    existing.push_str(text);
                    return;
                }
            }
            *previous = update;
        } else {
            self.positions.insert(id.to_owned(), self.updates.len());
            self.updates.push(update);
        }
    }
}

#[cfg(test)]
mod tests;
