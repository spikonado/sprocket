use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::types::TranscriptPart;

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

    fn key(self) -> String {
        format!("work-{}-{}", self.part, self.item)
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
    #[serde(deserialize_with = "sprocket_convex::deserialize_convex_u32")]
    pub item_count: u32,
    #[serde(deserialize_with = "sprocket_convex::deserialize_convex_u32")]
    pub pending_tools: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<f64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkRange {
    #[serde(deserialize_with = "sprocket_convex::deserialize_convex_u32")]
    pub start: u32,
    #[serde(deserialize_with = "sprocket_convex::deserialize_convex_u32")]
    pub end: u32,
    pub section_key: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkMembership {
    #[serde(deserialize_with = "sprocket_convex::deserialize_convex_u32")]
    pub number: u32,
    #[serde(deserialize_with = "sprocket_convex::deserialize_convex_u32")]
    pub processed: u32,
    pub ranges: Vec<WorkRange>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub section_key: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkBatch {
    pub expected: WorkPosition,
    pub through: WorkPosition,
    pub sections: Vec<WorkSection>,
    pub removed: Vec<String>,
    pub memberships: Vec<WorkMembership>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_run_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WorkItem {
    pub run_id: String,
    pub section: String,
    pub source: WorkPosition,
    pub call_id: Option<String>,
    pub name: Option<String>,
    pub result_part: Option<u32>,
    pub tool_parts: BTreeSet<u32>,
    pub canonical: bool,
    pub started_at: Option<f64>,
    pub completed_at: Option<f64>,
    pub session_id: Option<String>,
    pub running: bool,
    pub approval: Option<(String, String)>,
}

impl WorkItem {
    pub fn known_completion(&self) -> Option<f64> {
        self.completed_at
            .filter(|completed| self.started_at.is_none_or(|started| *completed >= started))
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct WorkSession {
    pub result_part: u32,
    pub running: bool,
    pub completed_at: Option<f64>,
}

pub trait WorkIndex {
    fn section(&self, key: &str) -> anyhow::Result<Option<WorkSection>>;
    fn save_section(&self, section: &WorkSection) -> anyhow::Result<()>;
    fn remove_section(&self, key: &str) -> anyhow::Result<()>;
    fn summarize(&self, key: &str) -> anyhow::Result<Option<WorkSection>>;
    fn item(&self, id: &str) -> anyhow::Result<Option<WorkItem>>;
    fn save_item(&self, id: &str, item: &WorkItem) -> anyhow::Result<()>;
    fn membership(&self, number: u32) -> anyhow::Result<WorkMembership>;
    fn save_membership(&self, membership: &WorkMembership) -> anyhow::Result<()>;
    fn session(&self, run: &str, session: &str) -> anyhow::Result<Option<WorkSession>>;
    fn save_session(&self, run: &str, session: &str, value: &WorkSession) -> anyhow::Result<()>;
    fn session_commands(&self, run: &str, session: &str)
    -> anyhow::Result<Vec<(String, WorkItem)>>;
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct WorkEngine {
    pub through: WorkPosition,
    tail: Option<String>,
    #[serde(skip)]
    changed: BTreeSet<String>,
    #[serde(skip)]
    linked: BTreeSet<u32>,
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

pub(super) fn hidden_tool(name: &str) -> bool {
    matches!(
        name,
        "add_artifact" | "list_artifacts" | "edit_artifact" | "create_artifact" | "update_artifact"
    )
}

impl WorkEngine {
    fn close_tail(&mut self, index: &impl WorkIndex) -> anyhow::Result<()> {
        if let Some(key) = self.tail.take() {
            if let Some(mut section) = index.section(&key)? {
                section.closed = true;
                index.save_section(&section)?;
                self.changed.insert(key);
            }
        }
        Ok(())
    }

    fn section(
        &mut self,
        index: &impl WorkIndex,
        run: &str,
        at: WorkPosition,
        provisional: bool,
    ) -> anyhow::Result<String> {
        if !provisional {
            if let Some(key) = &self.tail {
                if index
                    .section(key)?
                    .is_some_and(|s| s.run_id == run && !s.closed && !s.provisional)
                {
                    return Ok(key.clone());
                }
            }
            self.close_tail(index)?;
        }
        let key = at.key();
        if index.section(&key)?.is_none() {
            index.save_section(&WorkSection {
                key: key.clone(),
                run_id: run.to_owned(),
                first: at,
                end: WorkPosition {
                    item: at.item + 1,
                    ..at
                },
                closed: provisional,
                provisional,
                item_count: 0,
                pending_tools: 0,
                started_at: None,
                completed_at: None,
            })?;
        }
        if !provisional {
            self.tail = Some(key.clone());
        }
        self.changed.insert(key.clone());
        Ok(key)
    }

    fn link(
        &mut self,
        index: &impl WorkIndex,
        at: WorkPosition,
        key: &str,
        tool: bool,
    ) -> anyhow::Result<()> {
        let mut membership = index.membership(at.part)?;
        if tool {
            membership.section_key = Some(key.to_owned());
        } else if let Some(last) = membership
            .ranges
            .last_mut()
            .filter(|r| r.end == at.item && r.section_key == key)
        {
            last.end += 1;
        } else {
            membership.ranges.push(WorkRange {
                start: at.item,
                end: at.item + 1,
                section_key: key.to_owned(),
            });
        }
        index.save_membership(&membership)?;
        self.linked.insert(at.part);
        Ok(())
    }

    fn tool(
        &mut self,
        index: &impl WorkIndex,
        part: &TranscriptPart,
        at: WorkPosition,
        call: Option<&Value>,
    ) -> anyhow::Result<()> {
        let (call_id, name) = if let Some(call) = call {
            (
                string(call, "callId").unwrap_or_default(),
                string(call, "name").unwrap_or_default(),
            )
        } else if let Some(tool) = &part.tool {
            (tool.call_id.clone(), tool.name.clone())
        } else {
            return Ok(());
        };
        if hidden_tool(&name) {
            return Ok(());
        }
        anyhow::ensure!(
            !call_id.is_empty() && !name.is_empty(),
            "tool identity missing"
        );
        let id = format!("{}:tool:{call_id}", part.run_id);
        let previous = index.item(&id)?;
        if call.is_some() && previous.as_ref().is_some_and(|item| item.canonical) {
            anyhow::bail!("duplicate canonical tool call");
        }
        let key = if call.is_some() || previous.is_none() {
            self.section(index, &part.run_id, at, call.is_none())?
        } else {
            previous
                .as_ref()
                .expect("previous item exists")
                .section
                .clone()
        };
        let mut item = previous.unwrap_or_else(|| WorkItem {
            run_id: part.run_id.clone(),
            section: key.clone(),
            source: at,
            call_id: Some(call_id),
            name: Some(name.clone()),
            result_part: None,
            tool_parts: BTreeSet::new(),
            canonical: false,
            started_at: None,
            completed_at: None,
            session_id: None,
            running: false,
            approval: None,
        });
        let relocated = item.section != key;
        self.changed.insert(item.section.clone());
        item.section = key.clone();
        if let Some(call) = call {
            item.canonical = true;
            item.source = at;
            item.started_at = timing(call, "startedAt").or(item.started_at);
            item.session_id = call
                .get("input")
                .and_then(|input| string(input, "sessionId"))
                .or(item.session_id);
            self.link(index, at, &key, false)?;
            if let Some(mut section) = index.section(&key)? {
                section.end = WorkPosition {
                    item: at.item + 1,
                    ..at
                };
                index.save_section(&section)?;
            }
        } else if let Some(tool) = &part.tool {
            item.tool_parts.insert(part.number);
            if tool.status == "started" {
                item.started_at = item.started_at.or(part.created_at.map(|n| n as f64));
            } else if item.result_part.is_none() {
                item.result_part = Some(part.number);
                item.completed_at = part.created_at.map(|n| n as f64);
                if let Some(output) = &tool.output {
                    item.running = output
                        .get("running")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    item.session_id = string(output, "sessionId").or(item.session_id);
                    if name == "mandate_setup" {
                        item.approval =
                            string(output, "mandateId").zip(string(output, "approvalUrl"));
                    }
                }
            }
            self.link(index, at, &key, true)?;
        }
        if relocated {
            for number in &item.tool_parts {
                self.link(
                    index,
                    WorkPosition {
                        part: *number,
                        item: 0,
                    },
                    &key,
                    true,
                )?;
            }
        }
        if let Some(session) = item
            .session_id
            .as_ref()
            .filter(|_| matches!(name.as_str(), "exec_command" | "write_stdin"))
        {
            let mut current = index.session(&part.run_id, session)?;
            if let Some(result_part) = item.result_part {
                if current
                    .as_ref()
                    .is_none_or(|current| current.result_part < result_part)
                {
                    let value = WorkSession {
                        result_part,
                        running: item.running,
                        completed_at: item.completed_at,
                    };
                    index.save_session(&part.run_id, session, &value)?;
                    current = Some(value);
                }
            }
            if let Some(current) = current {
                if item.name.as_deref() == Some("exec_command") {
                    item.running = current.running;
                    if !current.running {
                        item.completed_at = current.completed_at.or(item.completed_at);
                    }
                }
                for (other_id, mut other) in index.session_commands(&part.run_id, session)? {
                    if other_id == id {
                        continue;
                    }
                    if other.running != current.running
                        || (!current.running && other.completed_at != current.completed_at)
                    {
                        other.running = current.running;
                        if !current.running {
                            other.completed_at = current.completed_at.or(other.completed_at);
                        }
                        index.save_item(&other_id, &other)?;
                        self.changed.insert(other.section);
                    }
                }
            }
        }
        if item.name.as_deref() != Some("exec_command") {
            item.running = false;
        }
        self.changed.insert(key);
        index.save_item(&id, &item)?;
        Ok(())
    }

    pub fn advance(
        &mut self,
        index: &impl WorkIndex,
        part: &TranscriptPart,
        limit: usize,
    ) -> anyhow::Result<WorkBatch> {
        anyhow::ensure!(
            part.number == self.through.part && limit > 0,
            "work input is not at the checkpoint"
        );
        let expected = self.through;
        let count = part.completion.as_ref().map_or(1, |c| c.items.len().max(1));
        anyhow::ensure!(
            count <= 8192 && (self.through.item as usize) < count,
            "invalid completion item count"
        );
        let end = count.min(self.through.item as usize + limit);
        if let Some(key) = &self.tail {
            if index.section(key)?.is_some_and(|s| s.run_id != part.run_id) {
                self.close_tail(index)?;
            }
        }
        for offset in self.through.item as usize..end {
            let at = WorkPosition {
                part: part.number,
                item: offset as u32,
            };
            if part.prompt.is_some() {
                self.close_tail(index)?;
            }
            if part.tool.is_some() {
                self.tool(index, part, at, None)?;
            }
            if let Some(value) = part.completion.as_ref().and_then(|c| c.items.get(offset)) {
                match value.get("type").and_then(Value::as_str) {
                    Some("text")
                        if value
                            .get("text")
                            .and_then(Value::as_str)
                            .is_some_and(|s| !s.trim().is_empty()) =>
                    {
                        self.close_tail(index)?
                    }
                    Some("reasoning")
                        if value
                            .get("text")
                            .and_then(Value::as_str)
                            .is_some_and(|s| !s.trim().is_empty()) =>
                    {
                        let key = self.section(index, &part.run_id, at, false)?;
                        self.link(index, at, &key, false)?;
                        let mut section = index.section(&key)?.expect("section exists");
                        section.end = WorkPosition {
                            item: at.item + 1,
                            ..at
                        };
                        index.save_section(&section)?;
                        index.save_item(
                            &format!("reasoning-{}-{}", part.number, at.item),
                            &WorkItem {
                                run_id: part.run_id.clone(),
                                section: key.clone(),
                                source: at,
                                call_id: None,
                                name: None,
                                result_part: None,
                                tool_parts: BTreeSet::new(),
                                canonical: true,
                                started_at: timing(value, "startedAt"),
                                completed_at: timing(value, "completedAt"),
                                session_id: None,
                                running: false,
                                approval: None,
                            },
                        )?;
                        self.changed.insert(key);
                    }
                    Some("tool-call") => self.tool(index, part, at, Some(value))?,
                    _ => {}
                }
            }
        }
        let mut membership = index.membership(part.number)?;
        membership.processed = end as u32;
        index.save_membership(&membership)?;
        self.linked.insert(part.number);
        self.through = if end == count {
            WorkPosition {
                part: part
                    .number
                    .checked_add(1)
                    .ok_or_else(|| anyhow::anyhow!("transcript position overflow"))?,
                item: 0,
            }
        } else {
            WorkPosition {
                part: part.number,
                item: end as u32,
            }
        };
        let mut sections = Vec::new();
        let mut removed = Vec::new();
        for key in std::mem::take(&mut self.changed) {
            let Some(section) = index.summarize(&key)? else {
                index.remove_section(&key)?;
                removed.push(key);
                continue;
            };
            index.save_section(&section)?;
            sections.push(section);
        }
        Ok(WorkBatch {
            expected,
            through: self.through,
            sections,
            removed,
            finished_run_id: None,
            memberships: std::mem::take(&mut self.linked)
                .into_iter()
                .map(|n| index.membership(n))
                .collect::<anyhow::Result<_>>()?,
        })
    }

    pub fn batch_limit(&self, part: &TranscriptPart) -> usize {
        let Some(completion) = &part.completion else {
            return 1;
        };
        let mut writes = 0;
        let mut previous = "";
        let mut count = 0;
        for item in completion.items.iter().skip(self.through.item as usize) {
            let kind = item["type"].as_str().unwrap_or("");
            if kind != previous || kind == "tool-call" {
                writes += 1;
            }
            if writes > 32 {
                break;
            }
            previous = kind;
            count += 1;
            if kind == "tool-call" {
                break;
            }
        }
        count.max(1)
    }

    pub fn detail(
        item: &WorkItem,
        source: &TranscriptPart,
        result: Option<&TranscriptPart>,
    ) -> Vec<Value> {
        let mut parts = Vec::new();
        if item.canonical {
            if let Some(value) = source
                .completion
                .as_ref()
                .and_then(|c| c.items.get(item.source.item as usize))
            {
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
            if let Some(object) = output.as_object_mut().filter(|_| item.session_id.is_some()) {
                object.insert("running".into(), item.running.into());
            }
            parts.push(json!({"type":"tool-result", "callId":tool.call_id, "name":tool.name, "output":output, "completedAt":item.known_completion()}));
        }
        parts
    }
}
