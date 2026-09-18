use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

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

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkSection {
    pub key: String,
    pub run_id: String,
    pub first: WorkPosition,
    pub end: WorkPosition,
    pub closed: bool,
    pub provisional: bool,
    pub item_count: u32,
    pub pending_tools: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<f64>,
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

    pub(crate) fn without_work_assignment(mut self) -> Self {
        self.work = WorkAssignment::default();
        self
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WorkItem {
    pub run_id: String,
    pub section: String,
    pub source: WorkPosition,
    pub call_id: Option<String>,
    pub tool_invocation_id: Option<String>,
    pub name: Option<String>,
    pub result_part: Option<u32>,
    pub tool_parts: BTreeSet<u32>,
    pub canonical: bool,
    pub started_at: Option<f64>,
    pub completed_at: Option<f64>,
    pub session_id: Option<String>,
    pub reported_running: Option<bool>,
    pub running: bool,
    pub approval: Option<(String, String)>,
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
        if hidden_tool(&tool.name) {
            return None;
        }
        let terminal = tool.status != "started";
        let output = tool.output.as_ref();
        let reported_running = output.and_then(|output| output["running"].as_bool());
        Some(Self {
            run_id: part.run_id.clone(),
            section: String::new(),
            source: WorkPosition {
                part: part.number,
                item: 0,
            },
            call_id: Some(tool.call_id.clone()),
            tool_invocation_id: Some(tool.tool_invocation_id.clone()),
            name: Some(tool.name.clone()),
            result_part: terminal.then_some(part.number),
            tool_parts: BTreeSet::new(),
            canonical: false,
            started_at: (!terminal)
                .then_some(part.created_at)
                .flatten()
                .map(|n| n as f64),
            completed_at: terminal
                .then_some(part.created_at)
                .flatten()
                .map(|n| n as f64),
            session_id: output.and_then(|output| string(output, "sessionId")),
            reported_running,
            running: reported_running.unwrap_or(false),
            approval: output
                .filter(|_| tool.name == "mandate_setup")
                .and_then(|output| string(output, "mandateId").zip(string(output, "approvalUrl"))),
        })
    }

    pub(super) fn merge_event(&mut self, event: Self) {
        self.started_at = earliest_timing(self.started_at, event.started_at);
        if self.result_part.is_none() && event.result_part.is_some() {
            self.result_part = event.result_part;
            self.completed_at = event.completed_at;
            self.running = event.running;
            self.reported_running = event.reported_running;
            self.session_id = event.session_id.or(self.session_id.take());
            self.approval = event.approval;
        }
    }

    pub(super) fn session_update(&self) -> Option<WorkSession> {
        let (result_part, running) = self.result_part.zip(self.reported_running)?;
        Some(WorkSession {
            result_part,
            running,
            completed_at: self.completed_at,
        })
    }

    pub(super) fn apply_command_session(&mut self, session: &WorkSession) {
        if self.name.as_deref() == Some("exec_command") {
            self.running = session.running;
            if !session.running {
                self.completed_at = session.completed_at.or(self.completed_at);
            }
        }
    }

    pub fn known_completion(&self) -> Option<f64> {
        self.completed_at
            .filter(|completed| self.started_at.is_none_or(|started| *completed >= started))
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct WorkSession {
    pub result_part: u32,
    pub running: bool,
    pub completed_at: Option<f64>,
}

pub(super) fn string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

pub(super) fn timing(value: &Value, key: &str) -> Option<f64> {
    value
        .get(key)
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite() && *n >= 0.0)
}

pub(super) fn earliest_timing(left: Option<f64>, right: Option<f64>) -> Option<f64> {
    match (left, right) {
        (Some(left), Some(right)) => Some(left.min(right)),
        (left, right) => left.or(right),
    }
}

pub(crate) fn hidden_tool(name: &str) -> bool {
    matches!(name, "add_artifact" | "list_artifacts" | "edit_artifact")
}

pub(super) fn detail(
    item: &WorkItem,
    source: &TranscriptPart,
    result: Option<&TranscriptPart>,
) -> Vec<Value> {
    let mut parts = Vec::new();
    if item.canonical {
        if let Some(value) = source.content_items().get(item.source.item as usize) {
            let mut value = value.clone();
            if let Some(object) = value.as_object_mut() {
                object.retain(|key, _| {
                    matches!(
                        key.as_str(),
                        "type"
                            | "id"
                            | "partId"
                            | "turnId"
                            | "text"
                            | "callId"
                            | "name"
                            | "input"
                            | "startedAt"
                            | "completedAt"
                    )
                });
                object.remove("startedAt");
                object.remove("completedAt");
                if let Some(started) = item.started_at {
                    object.insert("startedAt".into(), json!(started));
                }
                if item.call_id.is_none() {
                    if let Some(completed) = item.known_completion() {
                        object.insert("completedAt".into(), json!(completed));
                    }
                }
            }
            parts.push(value);
        }
    } else if let Some(tool) = &source.tool {
        parts.push(json!({"type":"tool-call", "callId":tool.call_id, "name":tool.name, "input":null, "startedAt":item.started_at}));
    }
    if let Some(tool) = result.and_then(|part| part.tool.as_ref()) {
        let mut output = tool.output.clone().unwrap_or(Value::Null);
        let running = match item.name.as_deref() {
            Some("exec_command") => Some(item.running),
            Some("write_stdin") => item.reported_running,
            _ => None,
        };
        if let Some((object, running)) = output.as_object_mut().zip(running) {
            object.insert("running".into(), running.into());
        }
        parts.push(json!({"type":"tool-result", "callId":tool.call_id, "name":tool.name, "output":output, "completedAt":item.known_completion()}));
    }
    parts
}
