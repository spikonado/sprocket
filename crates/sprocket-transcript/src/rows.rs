use std::collections::{BTreeMap, HashSet};

use serde::Serialize;
use serde_json::Value;

use crate::tool_display::{
    SessionCommands, ToolDisplay, ToolDisplayInput, ToolStatus, is_session_command, polled_targets,
};
use crate::{
    LiveCompletionOverlay, TranscriptAttachmentMeta, TranscriptCompletionBody, TranscriptPart,
    TranscriptPartKind, TranscriptToolBody,
};

/// The part number of rows from a live completion, which sorts after every saved part.
pub const LIVE_PART: u32 = u32::MAX;

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

/// What a browser asked to see. Thread rows summarize work blocks, work rows list a block's
/// items, and item rows carry the full text or tool summary.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RowScope {
    Thread,
    Work,
    Item,
}

/// A row with everything any scope shows, positioned by the part it came from.
#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    pub id: String,
    pub run_id: String,
    pub part: u32,
    pub body: RowBody,
}

#[derive(Clone, Debug, PartialEq)]
pub enum RowBody {
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
        work: String,
        text: String,
        running: bool,
    },
    Tool {
        work: String,
        name: String,
        display: ToolDisplay,
        result: Option<u32>,
    },
}

impl Row {
    pub fn work(&self) -> Option<&str> {
        match &self.body {
            RowBody::Reasoning { work, .. } | RowBody::Tool { work, .. } => Some(work),
            _ => None,
        }
    }

    /// The parts that show this row's item: its own and its tool result's.
    pub fn parts(&self) -> impl Iterator<Item = u32> {
        let result = match &self.body {
            RowBody::Tool { result, .. } => *result,
            _ => None,
        };
        std::iter::once(self.part).chain(result)
    }

    pub fn text(&self) -> Option<&str> {
        match &self.body {
            RowBody::Text { text, .. } | RowBody::Reasoning { text, .. } => Some(text),
            _ => None,
        }
    }

    /// Whether `next` is this row with only its text changed.
    pub fn differs_only_in_text(&self, next: &Self) -> bool {
        let mut copy = next.clone();
        if let RowBody::Text { text, .. } | RowBody::Reasoning { text, .. } = &mut copy.body
            && let Some(previous) = self.text()
        {
            previous.clone_into(text);
            return copy == *self;
        }
        false
    }

    pub fn set_streaming(&mut self) {
        if let RowBody::Text { running, .. } | RowBody::Reasoning { running, .. } = &mut self.body {
            *running = true;
        }
    }

    pub fn render(&self, scope: RowScope) -> Option<TranscriptRow> {
        let body = match (&self.body, scope) {
            (RowBody::Prompt { text, attachments }, RowScope::Thread | RowScope::Item) => {
                TranscriptRowBody::Prompt {
                    text: text.clone(),
                    attachments: attachments.clone(),
                }
            }
            (RowBody::Text { text, running }, RowScope::Thread | RowScope::Item) => {
                TranscriptRowBody::Text {
                    text: text.clone(),
                    running: *running,
                }
            }
            (
                RowBody::Work {
                    tool_counts,
                    running,
                },
                RowScope::Thread | RowScope::Item,
            ) => TranscriptRowBody::Work {
                tool_counts: tool_counts.clone(),
                running: *running,
            },
            (RowBody::Reasoning { text, running, .. }, RowScope::Work | RowScope::Item) => {
                TranscriptRowBody::Reasoning {
                    label: if *running {
                        "Thinking".to_owned()
                    } else {
                        reasoning_label(text)
                    },
                    running: *running,
                    text: (scope == RowScope::Item).then(|| text.clone()),
                }
            }
            (RowBody::Tool { name, display, .. }, RowScope::Work | RowScope::Item) => {
                let mut display = display.clone();
                let has_more = scope == RowScope::Work && display.shorten();
                TranscriptRowBody::Tool {
                    name: name.clone(),
                    display,
                    has_more,
                }
            }
            _ => return None,
        };
        Some(TranscriptRow {
            id: self.id.clone(),
            run_id: self.run_id.clone(),
            body,
        })
    }
}

fn reasoning_label(text: &str) -> String {
    const MAX_CHARS: usize = 120;
    let line = text
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("Thinking")
        .trim()
        .trim_matches('*')
        .trim_start_matches('#')
        .trim();
    match line.char_indices().nth(MAX_CHARS) {
        Some((end, _)) => format!("{}…", line[..end].trim_end()),
        None => line.to_owned(),
    }
}

fn item_index(item: &Value, offset: usize) -> usize {
    item.get("id")
        .or_else(|| item.get("partId"))
        .and_then(Value::as_str)
        .and_then(|id| id.rsplit(':').next())
        .and_then(|index| index.parse().ok())
        .unwrap_or(offset)
}

/// Row IDs come from the part's source key, so a live row keeps its ID once saved.
fn item_id(kind: &str, part: &TranscriptPart, offset: usize) -> String {
    let index = part
        .content_items()
        .get(offset)
        .map_or(offset, |item| item_index(item, offset));
    format!("{kind}:{}:{}:{index}", part.run_id, part.source_key)
}

/// The source key of the part a row came from.
pub fn row_source(row_id: &str) -> Option<&str> {
    row_id
        .splitn(3, ':')
        .nth(2)?
        .rsplit_once(':')
        .map(|(source, _)| source)
}

pub fn completion_source_key(live: &LiveCompletionOverlay) -> String {
    format!("completion:{}:{}", live.run_id, live.stream_id)
}

pub fn is_visible_prompt(part: &TranscriptPart) -> bool {
    part.prompt
        .as_ref()
        .is_some_and(|prompt| prompt.hidden.is_none())
}

fn has_text(item: &Value) -> bool {
    item["text"]
        .as_str()
        .is_some_and(|text| !text.trim().is_empty())
}

/// Where a page of history that starts at `start` shows from: the visible prompt of its newest
/// run with rows, when the page has it.
pub fn page_start(page: &[TranscriptPart], start: u32) -> u32 {
    let shows_rows = |part: &TranscriptPart| {
        is_visible_prompt(part)
            || part
                .tool
                .as_ref()
                .is_some_and(|tool| tool.status != "started")
            || part.content_items().iter().any(|item| {
                item["type"] == "tool-call"
                    || matches!(item["type"].as_str(), Some("text" | "reasoning")) && has_text(item)
            })
    };
    page.iter()
        .rev()
        .find(|part| shows_rows(part))
        .and_then(|last| {
            page.iter()
                .find(|part| part.run_id == last.run_id && is_visible_prompt(part))
        })
        .map_or(start, |part| part.number)
}

/// Folds parts, in transcript order, into rows. Each part yields the rows it adds or changes.
///
/// Runs never interleave, so the state is the current run's. Work blocks follow the agent's
/// rule: non-empty reasoning or a tool call opens or continues the run's block and non-empty
/// text closes it. A tool result updates its call's row. Results with no earlier call wait
/// until the next non-tool part, because older agents saved some results before their calls;
/// unmatched ones then become rows of their own.
#[derive(Clone, Debug, Default)]
pub struct RowTally {
    run: Option<RunTally>,
}

#[derive(Clone, Debug)]
struct RunTally {
    id: String,
    block: Option<Row>,
    calls: Vec<WaitingCall>,
    results: Vec<TranscriptPart>,
}

#[derive(Clone, Debug)]
struct WaitingCall {
    row: Row,
    input: Value,
    key: CallKey,
}

#[derive(Clone, Debug)]
enum CallKey {
    Invocation(String),
    /// Calls saved before tool invocation IDs existed match their result's provider call ID.
    Provider(String),
}

impl CallKey {
    fn of(item: &Value, saved: bool) -> Option<Self> {
        if item["type"] != "tool-call" {
            return None;
        }
        if let Some(invocation) = item["toolInvocationId"].as_str() {
            return Some(Self::Invocation(invocation.to_owned()));
        }
        // Providers reuse call IDs, so a live call only matches by its invocation once saved.
        item["callId"]
            .as_str()
            .filter(|call| saved && !call.is_empty())
            .map(|call| Self::Provider(call.to_owned()))
    }

    fn matches(&self, result: &TranscriptToolBody) -> bool {
        match self {
            Self::Invocation(id) => result.tool_invocation_id.as_deref() == Some(id.as_str()),
            Self::Provider(id) => result.call_id == *id,
        }
    }
}

/// Rows a live view adds or changes on top of the saved ones, and the rows still streaming.
#[derive(Debug, Default)]
pub struct LiveRows {
    pub rows: Vec<Row>,
    pub streaming: HashSet<String>,
}

impl RowTally {
    pub fn apply(&mut self, part: &TranscriptPart, commands: &mut SessionCommands) -> Vec<Row> {
        let mut changes = Vec::new();
        self.apply_part(part, true, commands, &mut changes);
        changes
    }

    /// Turns results still waiting for a call into rows. Call it where folding stops.
    pub fn settle(&mut self, commands: &mut SessionCommands) -> Vec<Row> {
        let mut changes = Vec::new();
        if let Some(run) = &mut self.run {
            run.flush(commands, &mut changes);
        }
        changes
    }

    /// The rows after `overlays`, in order, on a copy of this state. Overlays whose completion
    /// `is_saved` only mark their rows streaming. Waiting results can still pair with live calls.
    pub fn live_rows(
        &self,
        overlays: &[LiveCompletionOverlay],
        is_saved: impl Fn(&str) -> bool,
        commands: &mut SessionCommands,
    ) -> LiveRows {
        let mut tally = self.clone();
        let mut live = LiveRows::default();
        for overlay in overlays {
            let part = live_part(overlay);
            let items = part.content_items();
            if !overlay.run_status.is_final()
                && let Some(item) = items.last()
                && let Some(kind @ ("text" | "reasoning")) = item["type"].as_str()
            {
                live.streaming.insert(item_id(kind, &part, items.len() - 1));
            }
            if !is_saved(&part.source_key) {
                tally.apply_part(&part, false, commands, &mut live.rows);
            }
        }
        live.rows.extend(tally.settle(commands));
        live
    }

    fn apply_part(
        &mut self,
        part: &TranscriptPart,
        saved: bool,
        commands: &mut SessionCommands,
        changes: &mut Vec<Row>,
    ) {
        if self.run.as_ref().is_none_or(|run| run.id != part.run_id) {
            changes.extend(self.settle(commands));
            self.run = Some(RunTally {
                id: part.run_id.clone(),
                block: None,
                calls: Vec::new(),
                results: Vec::new(),
            });
        }
        let run = self.run.as_mut().expect("the part's run was just set");
        if let Some(tool) = &part.tool {
            // Older agents saved a `started` part before each result.
            if tool.status != "started" {
                run.result(part, tool, commands, changes);
            }
        } else if let Some(prompt) = &part.prompt {
            run.flush(commands, changes);
            if prompt.hidden.is_none() {
                changes.push(Row {
                    id: item_id("prompt", part, 0),
                    run_id: part.run_id.clone(),
                    part: part.number,
                    body: RowBody::Prompt {
                        text: prompt.text.clone(),
                        attachments: prompt.image_uploads.clone(),
                    },
                });
            }
        } else {
            run.completion(part, saved, commands, changes);
        }
    }
}

fn live_part(overlay: &LiveCompletionOverlay) -> TranscriptPart {
    let mut items: Vec<Value> = overlay
        .parts
        .iter()
        .map(|item| serde_json::to_value(item).expect("live assistant parts serialize"))
        .collect();
    items.sort_by_key(|item| item_index(item, usize::MAX));
    TranscriptPart {
        number: LIVE_PART,
        source_key: completion_source_key(overlay),
        kind: TranscriptPartKind::Completion,
        run_id: overlay.run_id.clone(),
        created_at: None,
        prompt: None,
        completion: Some(TranscriptCompletionBody { items }),
        tool: None,
    }
}

struct Call<'a> {
    id: String,
    work: String,
    part: u32,
    name: &'a str,
    input: &'a Value,
    key: Option<CallKey>,
    result: Option<&'a TranscriptPart>,
}

impl RunTally {
    fn completion(
        &mut self,
        part: &TranscriptPart,
        saved: bool,
        commands: &mut SessionCommands,
        changes: &mut Vec<Row>,
    ) {
        let items = part.content_items();
        let keys: Vec<_> = items.iter().map(|item| CallKey::of(item, saved)).collect();
        let early_results: Vec<_> = keys
            .iter()
            .map(|key| {
                let key = key.as_ref()?;
                let index = self.results.iter().position(|result| {
                    result.tool.as_ref().is_some_and(|tool| key.matches(tool))
                })?;
                Some(self.results.remove(index))
            })
            .collect();
        self.flush(commands, changes);
        for (offset, (item, key)) in items.iter().zip(keys).enumerate() {
            let kind = item["type"].as_str().unwrap_or_default();
            match kind {
                "text" | "reasoning" if !has_text(item) => {}
                "text" => {
                    self.close(changes);
                    changes.push(Row {
                        id: item_id(kind, part, offset),
                        run_id: self.id.clone(),
                        part: part.number,
                        body: RowBody::Text {
                            text: item["text"].as_str().unwrap_or_default().to_owned(),
                            running: false,
                        },
                    });
                }
                "reasoning" => {
                    let opened = self.block.is_none();
                    let block = self.open_block(item_id("work", part, offset), part.number);
                    let work = block.id.clone();
                    if opened {
                        changes.push(block.clone());
                    }
                    changes.push(Row {
                        id: item_id(kind, part, offset),
                        run_id: self.id.clone(),
                        part: part.number,
                        body: RowBody::Reasoning {
                            work,
                            text: item["text"].as_str().unwrap_or_default().to_owned(),
                            running: false,
                        },
                    });
                }
                "tool-call" => self.call(
                    Call {
                        id: item_id("tool", part, offset),
                        work: item_id("work", part, offset),
                        part: part.number,
                        name: item["name"].as_str().unwrap_or("tool"),
                        input: &item["input"],
                        key,
                        result: early_results[offset].as_ref(),
                    },
                    commands,
                    changes,
                ),
                _ => {}
            }
        }
    }

    fn result(
        &mut self,
        part: &TranscriptPart,
        tool: &TranscriptToolBody,
        commands: &mut SessionCommands,
        changes: &mut Vec<Row>,
    ) {
        let Some(index) = self.calls.iter().position(|call| call.key.matches(tool)) else {
            self.results.push(part.clone());
            return;
        };
        let WaitingCall { mut row, input, .. } = self.calls.remove(index);
        if let RowBody::Tool {
            name,
            display,
            result,
            ..
        } = &mut row.body
        {
            *display = tool_display(name, &input, Some(tool), commands);
            *result = Some(part.number);
        }
        changes.push(row);
    }

    /// Results that no call claimed become rows where they were saved.
    fn flush(&mut self, commands: &mut SessionCommands, changes: &mut Vec<Row>) {
        for result in std::mem::take(&mut self.results) {
            let Some(tool) = &result.tool else { continue };
            let input = tool.input.clone().unwrap_or_default();
            let id = format!("{}:{}:0", self.id, result.source_key);
            self.call(
                Call {
                    id: format!("tool:{id}"),
                    work: format!("work:{id}"),
                    part: result.number,
                    name: &tool.name,
                    input: &input,
                    key: None,
                    result: Some(&result),
                },
                commands,
                changes,
            );
        }
    }

    fn call(&mut self, call: Call<'_>, commands: &mut SessionCommands, changes: &mut Vec<Row>) {
        let block = self.open_block(call.work, call.part);
        if let RowBody::Work { tool_counts, .. } = &mut block.body {
            *tool_counts.entry(call.name.to_owned()).or_insert(0) += 1;
        }
        changes.push(block.clone());
        let work = block.id.clone();
        let result = call.result.and_then(|part| part.tool.as_ref());
        let row = Row {
            id: call.id,
            run_id: self.id.clone(),
            part: call.part,
            body: RowBody::Tool {
                work,
                name: call.name.to_owned(),
                display: tool_display(call.name, call.input, result, commands),
                result: call.result.map(|part| part.number),
            },
        };
        if result.is_none()
            && let Some(key) = call.key
        {
            self.calls.push(WaitingCall {
                row: row.clone(),
                input: call.input.clone(),
                key,
            });
        }
        changes.push(row);
    }

    fn open_block(&mut self, id: String, part: u32) -> &mut Row {
        self.block.get_or_insert_with(|| Row {
            id,
            run_id: self.id.clone(),
            part,
            body: RowBody::Work {
                tool_counts: BTreeMap::new(),
                running: true,
            },
        })
    }

    fn close(&mut self, changes: &mut Vec<Row>) {
        if let Some(mut block) = self.block.take() {
            if let RowBody::Work { running, .. } = &mut block.body {
                *running = false;
            }
            changes.push(block);
        }
    }
}

fn tool_display(
    name: &str,
    input: &Value,
    result: Option<&TranscriptToolBody>,
    commands: &mut SessionCommands,
) -> ToolDisplay {
    let output = result.and_then(|tool| tool.output.as_ref());
    let status = ToolStatus::from_result(result.map(|tool| tool.status.as_str()));
    let display_input = ToolDisplayInput::new(name, input, output, status);
    let Some(targets) = polled_targets(name, input, output, status) else {
        return command_display(name, &display_input, commands);
    };
    let mut display = display_input.display(None);
    display.summary = targets
        .iter()
        .map(|target| {
            let target_display = command_display(name, target, commands);
            display.commands.extend(target_display.commands);
            match target_display.error {
                Some(error) if display.error.is_none() => {
                    format!("{}: {error}", target_display.summary)
                }
                _ => target_display.summary,
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    display
}

fn command_display(
    name: &str,
    input: &ToolDisplayInput<'_>,
    commands: &mut SessionCommands,
) -> ToolDisplay {
    let command = input
        .session_id()
        .filter(|_| is_session_command(name))
        .and_then(|session| commands.get(session));
    input.display(command)
}

#[cfg(test)]
mod tests;
