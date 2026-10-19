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
    pub section: Option<String>,
    pub source: WorkPosition,
    pub call_id: Option<String>,
    pub tool_invocation_id: Option<String>,
    pub result_part: Option<u32>,
    pub canonical: bool,
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
        let terminal = tool.status != "started";
        Some(Self {
            run_id: part.run_id.clone(),
            section: None,
            source: WorkPosition {
                part: part.number,
                item: 0,
            },
            call_id: Some(tool.call_id.clone()),
            tool_invocation_id: tool.tool_invocation_id.clone(),
            result_part: terminal.then_some(part.number),
            canonical: false,
            approval: tool
                .output
                .as_ref()
                .filter(|_| tool.name == "mandate_setup")
                .and_then(|output| string(output, "mandateId").zip(string(output, "approvalUrl"))),
        })
    }

    pub(super) fn merge_event(&mut self, event: Self) {
        if self.result_part.is_none() && event.result_part.is_some() {
            self.result_part = event.result_part;
            self.approval = event.approval;
        }
    }
}

pub(super) fn string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
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
                        "type" | "id" | "partId" | "turnId" | "text" | "callId" | "name" | "input"
                    )
                });
            }
            parts.push(value);
        }
    } else if let Some(tool) = &source.tool {
        let input = tool
            .input
            .as_ref()
            .or_else(|| {
                let part = result?;
                let terminal = part.tool.as_ref()?;
                let invocation = tool.tool_invocation_id.as_ref().or(tool.job_id.as_ref())?;
                (part.run_id == source.run_id
                    && terminal.name == tool.name
                    && terminal
                        .tool_invocation_id
                        .as_ref()
                        .or(terminal.job_id.as_ref())
                        == Some(invocation))
                .then_some(terminal.input.as_ref())
                .flatten()
            })
            .unwrap_or(&Value::Null);
        parts.push(
            json!({"type":"tool-call", "callId":tool.call_id, "name":tool.name, "input":input}),
        );
    }
    if let Some(tool) = result.and_then(|part| part.tool.as_ref()) {
        let output = tool.output.as_ref().unwrap_or(&Value::Null);
        parts.push(
            json!({"type":"tool-result", "callId":tool.call_id, "name":tool.name, "output":output}),
        );
    }
    parts
}
