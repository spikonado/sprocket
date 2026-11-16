use std::borrow::Cow;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::ops::Range;
use std::path::Path;

use serde::Serialize;
use serde_json::{Value, json};

use crate::sections::{item_id, item_index};
use crate::tool_display::{
    ToolDisplay, ToolDisplayInput, ToolStatus, is_session_command, load_session_command,
};
use crate::{
    LiveCompletionOverlay, TranscriptAttachmentMeta, TranscriptCompletionBody, TranscriptPart,
    TranscriptPartKind, derive_work_blocks,
};

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptRow {
    pub id: String,
    pub run_id: String,
    #[serde(flatten)]
    pub body: TranscriptRowBody,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TranscriptRowBody {
    Prompt {
        text: String,
        attachments: Vec<TranscriptAttachmentMeta>,
    },
    Text {
        text: String,
        running: bool,
    },
    Work {
        tool_counts: BTreeMap<String, u32>,
        running: bool,
    },
    Reasoning {
        label: String,
        running: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        text: Option<String>,
    },
    Tool {
        name: String,
        #[serde(flatten)]
        display: ToolDisplay,
        has_more: bool,
    },
}

#[derive(Clone, Debug)]
pub enum ProjectionScope {
    Thread,
    Work(String),
    Item(String),
    Row(String),
}

impl ProjectionScope {
    pub fn run_id(&self) -> Option<&str> {
        match self {
            Self::Thread => None,
            Self::Work(id) | Self::Item(id) | Self::Row(id) => id.split(':').nth(1),
        }
    }
}

impl TranscriptRow {
    pub fn text(&self) -> Option<&str> {
        match &self.body {
            TranscriptRowBody::Text { text, .. }
            | TranscriptRowBody::Reasoning {
                text: Some(text), ..
            } => Some(text),
            _ => None,
        }
    }

    pub fn set_text(&mut self, value: String) {
        match &mut self.body {
            TranscriptRowBody::Text { text, .. }
            | TranscriptRowBody::Reasoning {
                text: Some(text), ..
            } => *text = value,
            _ => {}
        }
    }
}

pub fn completion_source_key(live: &LiveCompletionOverlay) -> String {
    format!("completion:{}:{}", live.run_id, live.stream_id)
}

fn merge_live<'a>(
    saved: &'a [TranscriptPart],
    live: &[LiveCompletionOverlay],
) -> (Vec<Cow<'a, TranscriptPart>>, LiveActivity) {
    let mut parts: Vec<_> = saved.iter().map(Cow::Borrowed).collect();
    parts.sort_by_key(|part| part.number);
    let mut sources = HashSet::new();
    parts.retain(|part| sources.insert(part.source_key.clone()));
    let mut activity = LiveActivity::default();
    let mut number = parts.last().map_or(0, |part| part.number.saturating_add(1));
    for overlay in live {
        let source_key = completion_source_key(overlay);
        let mut items: Vec<Value> = overlay
            .parts
            .iter()
            .map(|item| serde_json::to_value(item).expect("live assistant parts serialize"))
            .collect();
        items.sort_by_key(|item| item_index(item, usize::MAX));
        let part = TranscriptPart {
            number,
            source_key,
            kind: TranscriptPartKind::Completion,
            run_id: overlay.run_id.clone(),
            created_at: None,
            prompt: None,
            completion: Some(TranscriptCompletionBody {
                stream_id: None,
                items,
            }),
            tool: None,
            work: Default::default(),
        };
        if !overlay.run_status.is_final()
            && let Some(item) = part.content_items().last()
            && let Some(kind @ ("text" | "reasoning")) = item["type"].as_str()
        {
            activity
                .streaming
                .insert(item_id(kind, &part, part.content_items().len() - 1));
        }
        if !sources.insert(part.source_key.clone()) {
            continue;
        }
        activity.unsaved.insert(part.source_key.clone());
        parts.push(Cow::Owned(part));
        number = number.saturating_add(1);
    }
    (parts, activity)
}

#[derive(Default)]
struct LiveActivity {
    streaming: HashSet<String>,
    unsaved: HashSet<String>,
}

fn reasoning_label(text: &str) -> String {
    text.lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("Thinking")
        .trim()
        .trim_matches('*')
        .trim_start_matches('#')
        .trim()
        .chars()
        .take(120)
        .collect()
}

pub async fn project_rows(
    saved: &[TranscriptPart],
    live: &[LiveCompletionOverlay],
    scope: &ProjectionScope,
    window: Range<u32>,
    transcript_dir: &Path,
) -> Vec<TranscriptRow> {
    let mut results = HashMap::new();
    let mut call_results = HashMap::new();
    let mut source_results = HashMap::new();
    for part in saved {
        if let Some(tool) = &part.tool
            && tool.status != "started"
        {
            let result = (part.number, tool);
            source_results.insert(part.source_key.as_str(), result);
            if let Some(invocation) = tool.tool_invocation_id.as_deref() {
                results
                    .entry((part.run_id.as_str(), invocation))
                    .or_insert(result);
            }
            if !tool.call_id.is_empty() {
                call_results
                    .entry((part.run_id.as_str(), tool.call_id.as_str()))
                    .or_insert(result);
            }
        }
    }
    let (mut parts, activity) = merge_live(saved, live);
    let result_for = |part: &TranscriptPart, item: &Value| {
        if let Some(source) = item["resultSourceKey"].as_str() {
            source_results.get(source).copied()
        } else if let Some(invocation) = item["toolInvocationId"].as_str() {
            results.get(&(part.run_id.as_str(), invocation)).copied()
        } else if !activity.unsaved.contains(&part.source_key) {
            item["callId"]
                .as_str()
                .and_then(|call| call_results.get(&(part.run_id.as_str(), call)))
                .copied()
        } else {
            None
        }
    };
    let matched: HashSet<_> = parts
        .iter()
        .flat_map(|part| {
            part.content_items()
                .iter()
                .filter_map(|item| result_for(part, item).map(|(number, _)| number))
        })
        .collect();
    let mut fallback_ids = HashSet::new();
    for part in &mut parts {
        let Some(tool) = &part.tool else { continue };
        if tool.status == "started" {
            continue;
        }
        let identity = tool
            .tool_invocation_id
            .as_deref()
            .or_else(|| (!tool.call_id.is_empty()).then_some(tool.call_id.as_str()))
            .or(tool.job_id.as_deref())
            .unwrap_or(&part.source_key);
        if !fallback_ids.insert((part.run_id.clone(), identity.to_owned()))
            || matched.contains(&part.number)
        {
            continue;
        }
        let fallback = TranscriptPart {
            number: part.number,
            source_key: part.source_key.clone(),
            run_id: part.run_id.clone(),
            kind: TranscriptPartKind::Completion,
            created_at: part.created_at,
            prompt: None,
            completion: Some(TranscriptCompletionBody {
                stream_id: None,
                items: vec![json!({"type":"tool-call", "name":tool.name,
                    "input":tool.input, "resultSourceKey":part.source_key})],
            }),
            tool: None,
            work: Default::default(),
        };
        *part = Cow::Owned(fallback);
    }
    let by_number: HashMap<_, _> = parts
        .iter()
        .map(|part| (part.number, part.as_ref()))
        .collect();
    let visible = |part: &TranscriptPart| {
        window.contains(&part.number) || activity.unsaved.contains(&part.source_key)
    };
    let mut work_at = HashMap::new();
    let mut selected_items = HashSet::new();
    for block in derive_work_blocks(parts.iter().map(AsRef::as_ref)) {
        let Some(first) = block.items.first() else {
            continue;
        };
        let id = block.id;
        if matches!(scope, ProjectionScope::Work(target) if *target == id) {
            selected_items.extend(
                block
                    .items
                    .iter()
                    .map(|position| (position.part, position.item)),
            );
        }
        if !(matches!(scope, ProjectionScope::Thread)
            || matches!(scope, ProjectionScope::Row(target) if *target == id))
        {
            continue;
        }
        let mut tool_counts = BTreeMap::new();
        let mut running = false;
        let mut in_window = false;
        for position in &block.items {
            let part = by_number[&position.part];
            let item = &part.content_items()[position.item as usize];
            in_window |= visible(part);
            if item["type"] == "tool-call" {
                *tool_counts
                    .entry(item["name"].as_str().unwrap_or("tool").to_owned())
                    .or_insert(0) += 1;
                let result = result_for(part, item);
                running |= result.is_none();
                in_window |= result.is_some_and(|(number, _)| window.contains(&number));
            }
            running |=
                activity
                    .streaming
                    .contains(&item_id("reasoning", part, position.item as usize));
        }
        if in_window || matches!(scope, ProjectionScope::Row(target) if *target == id) {
            work_at.insert(
                (first.part, first.item),
                TranscriptRow {
                    id,
                    run_id: block.run_id,
                    body: TranscriptRowBody::Work {
                        tool_counts,
                        running,
                    },
                },
            );
        }
    }
    let mut rows = Vec::new();
    let mut commands: HashMap<String, Option<String>> = HashMap::new();
    for part in &parts {
        for item in part
            .content_items()
            .iter()
            .filter(|item| matches!(item["name"].as_str(), Some("exec_cmd" | "exec_command")))
        {
            let output = result_for(part, item).and_then(|(_, tool)| tool.output.as_ref());
            let input = ToolDisplayInput::new(
                item["name"].as_str().unwrap(),
                &item["input"],
                output,
                ToolStatus::Completed,
            );
            if let Some(session) = input.session_id()
                && uuid::Uuid::parse_str(session).is_err()
                && let Some(command) = output
                    .and_then(|output| output["command"].as_str())
                    .or_else(|| item["input"]["cmd"].as_str())
            {
                commands.insert(session.to_owned(), Some(command.to_owned()));
            }
        }
    }
    for part in &parts {
        if let Some(prompt) = &part.prompt
            && prompt.hidden.is_none()
            && (matches!(scope, ProjectionScope::Thread) && visible(part)
                || matches!(scope, ProjectionScope::Row(target) if *target == item_id("prompt", part, 0)))
        {
            rows.push(TranscriptRow {
                id: item_id("prompt", part, 0),
                run_id: part.run_id.clone(),
                body: TranscriptRowBody::Prompt {
                    text: prompt.text.clone(),
                    attachments: prompt.image_uploads.clone(),
                },
            });
        }
        for (offset, item) in part.content_items().iter().enumerate() {
            let position = (part.number, offset as u32);
            if let Some(work) = work_at.remove(&position) {
                rows.push(work);
            }
            let kind = item["type"].as_str().unwrap_or_default();
            let text = item["text"].as_str().unwrap_or_default();
            if matches!(kind, "text" | "reasoning") && text.trim().is_empty() {
                continue;
            }
            let id = item_id(
                if kind == "tool-call" { "tool" } else { kind },
                part,
                offset,
            );
            let full = matches!(scope, ProjectionScope::Item(target) | ProjectionScope::Row(target) if *target == id);
            if !(full
                || selected_items.contains(&position)
                || matches!(scope, ProjectionScope::Thread) && kind == "text" && visible(part))
            {
                continue;
            }
            let running = activity.streaming.contains(&id);
            let body = match kind {
                "text" => TranscriptRowBody::Text {
                    text: text.to_owned(),
                    running,
                },
                "reasoning" => TranscriptRowBody::Reasoning {
                    label: if running {
                        "Thinking".to_owned()
                    } else {
                        reasoning_label(text)
                    },
                    running,
                    text: full.then(|| text.to_owned()),
                },
                "tool-call" => {
                    let name = item["name"].as_str().unwrap_or("tool");
                    let result = result_for(part, item).map(|(_, tool)| tool);
                    let status = ToolStatus::from_result(result.map(|tool| tool.status.as_str()));
                    let input = ToolDisplayInput::new(
                        name,
                        &item["input"],
                        result.and_then(|tool| tool.output.as_ref()),
                        status,
                    );
                    let command = match input.session_id().filter(|_| is_session_command(name)) {
                        Some(session) => {
                            if !commands.contains_key(session) {
                                let command = match uuid::Uuid::parse_str(session) {
                                    Ok(id) => load_session_command(transcript_dir, id).await,
                                    Err(_) => None,
                                };
                                commands.insert(session.to_owned(), command);
                            }
                            commands[session].as_deref()
                        }
                        None => None,
                    };
                    let mut display = input.display(command);
                    let has_more = if full { false } else { display.shorten() };
                    TranscriptRowBody::Tool {
                        name: name.to_owned(),
                        display,
                        has_more,
                    }
                }
                _ => continue,
            };
            rows.push(TranscriptRow {
                id,
                run_id: part.run_id.clone(),
                body,
            });
        }
    }
    rows
}

#[cfg(test)]
mod tests;
