use anyhow::Context;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::collections::{BTreeMap, BTreeSet, HashMap};

use super::{TRANSCRIPT_CHUNK_SIZE, TranscriptPart, TranscriptStore, TranscriptToolBody};

pub const MONITOR_PAGE_CHAR_LIMIT: usize = 20_000;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum MonitorEntry {
    Prompt {
        id: String,
        text: String,
    },
    Text {
        id: String,
        text: String,
    },
    Patch {
        id: String,
        ok: bool,
        changes: Vec<PatchChangeSummary>,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PatchChangeSummary {
    pub operation: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MonitorPage {
    pub entries: Vec<MonitorEntry>,
    pub next_cursor: String,
    pub has_more: bool,
}

#[derive(Clone, Debug, Default)]
pub struct MonitorFilter {
    pub only_run_id: Option<String>,
    pub hidden_prompt_runs: BTreeSet<String>,
}

#[derive(Clone, Copy, Debug, thiserror::Error, PartialEq, Eq)]
pub enum MonitorReadError {
    #[error("monitor cursor is malformed")]
    MalformedCursor,
    #[error("monitor cursor belongs to a different thread")]
    WrongThread,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MonitorCursor {
    thread_id: String,
    part: u32,
    item: usize,
    offset: usize,
}

impl MonitorCursor {
    fn read(thread: &str, encoded: Option<&str>) -> anyhow::Result<Self> {
        let Some(encoded) = encoded else {
            return Ok(Self {
                thread_id: thread.to_owned(),
                ..Self::default()
            });
        };
        let bytes = URL_SAFE_NO_PAD
            .decode(encoded)
            .map_err(|_| MonitorReadError::MalformedCursor)?;
        let cursor: Self =
            serde_json::from_slice(&bytes).map_err(|_| MonitorReadError::MalformedCursor)?;
        if cursor.thread_id != thread {
            return Err(MonitorReadError::WrongThread.into());
        }
        Ok(cursor)
    }

    fn next_part(&mut self) {
        self.part += 1;
        self.item = 0;
        self.offset = 0;
    }
}

pub async fn download_monitor_page<F, Fut>(
    store: &TranscriptStore,
    user: &str,
    thread: &str,
    cursor: Option<&str>,
    total: u32,
    filter: &MonitorFilter,
    fetch: F,
) -> anyhow::Result<MonitorPage>
where
    F: FnMut(u32, u32) -> Fut,
    Fut: std::future::Future<Output = anyhow::Result<Vec<TranscriptPart>>>,
{
    let cursor = MonitorCursor::read(thread, cursor)?;
    let _lease = store.open_thread(user, thread).await?;
    store
        .ensure_parts(user, thread, cursor.part, total, fetch)
        .await?;
    let mut ready_end = cursor.part;
    for number in store.part_numbers(user, thread).await? {
        if number < ready_end {
            continue;
        }
        if number != ready_end {
            break;
        }
        ready_end = number
            .checked_add(1)
            .context("transcript part number overflow")?;
    }
    read_page(
        store,
        user,
        thread,
        cursor,
        ready_end,
        filter,
        MONITOR_PAGE_CHAR_LIMIT,
    )
    .await
}

struct PageBuilder {
    entries: Vec<MonitorEntry>,
    max_chars: usize,
    remaining: usize,
}

impl PageBuilder {
    fn new(max_chars: usize) -> Self {
        let max_chars = max_chars.clamp(1, MONITOR_PAGE_CHAR_LIMIT);
        Self {
            entries: Vec::new(),
            max_chars,
            remaining: max_chars,
        }
    }

    fn finish(self, cursor: MonitorCursor, has_more: bool) -> anyhow::Result<MonitorPage> {
        Ok(MonitorPage {
            entries: self.entries,
            next_cursor: URL_SAFE_NO_PAD.encode(serde_json::to_vec(&cursor)?),
            has_more,
        })
    }

    fn text(
        &mut self,
        id: String,
        text: &str,
        prompt: bool,
        offset: &mut usize,
    ) -> anyhow::Result<bool> {
        let mut chars = text
            .get(*offset..)
            .context("invalid text cursor offset")?
            .chars()
            .peekable();
        if chars.peek().is_none() {
            return Ok(true);
        }
        let overhead = id.chars().count() + 1;
        let budget = self.remaining.saturating_sub(overhead);
        if budget == 0 {
            anyhow::ensure!(
                !self.entries.is_empty(),
                "monitor identity exceeds page budget"
            );
            return Ok(false);
        }
        let text: String = chars.by_ref().take(budget).collect();
        let count = text.chars().count();
        self.remaining -= overhead + count;
        *offset += text.len();
        self.entries.push(if prompt {
            MonitorEntry::Prompt { id, text }
        } else {
            MonitorEntry::Text { id, text }
        });
        Ok(chars.peek().is_none())
    }

    fn patch(
        &mut self,
        id: String,
        tool: &TranscriptToolBody,
        offset: &mut usize,
    ) -> anyhow::Result<bool> {
        let ok = tool.status == "completed";
        let changes = if ok {
            patch_changes(tool.output.as_ref())
        } else {
            Vec::new()
        };
        let overhead = id.chars().count() + 1;
        let tail = changes
            .get(*offset..)
            .context("invalid patch cursor offset")?;
        let first_cost = tail.first().map_or(0, patch_change_cost);
        anyhow::ensure!(
            overhead + first_cost <= self.max_chars,
            "patch path exceeds monitor page budget"
        );
        if overhead + first_cost > self.remaining {
            return Ok(false);
        }
        self.remaining -= overhead;
        let count = tail
            .iter()
            .take_while(|change| {
                let cost = patch_change_cost(change);
                if cost > self.remaining {
                    return false;
                }
                self.remaining -= cost;
                true
            })
            .count();
        self.entries.push(MonitorEntry::Patch {
            id,
            ok,
            changes: tail[..count].to_vec(),
        });
        *offset += count;
        Ok(*offset == changes.len())
    }
}

struct PatchCall {
    run: String,
    invocation: Option<String>,
    call_id: Option<String>,
}

struct ToolResult {
    run: String,
    invocation: Option<String>,
    call_id: String,
    name: String,
}

/// Kept in the thread's in-memory index so pages pair patches without rereading the thread.
#[derive(Default)]
pub(crate) struct PatchIdentities {
    calls: BTreeMap<(u32, usize), PatchCall>,
    results: BTreeMap<u32, ToolResult>,
}

#[derive(Default)]
pub(crate) struct PatchIndex {
    results: HashMap<(u32, usize), u32>,
    orphans: BTreeSet<u32>,
}

fn nonempty(value: Option<&str>) -> Option<&str> {
    value.filter(|value| !value.is_empty())
}

impl PatchIdentities {
    pub(crate) fn insert(&mut self, part: &TranscriptPart) {
        for (item, value) in part
            .completion
            .iter()
            .flat_map(|completion| completion.items.iter().enumerate())
        {
            if value["type"] == "tool-call" && value["name"] == "apply_patch" {
                self.calls.insert(
                    (part.number, item),
                    PatchCall {
                        run: part.run_id.clone(),
                        invocation: nonempty(value["toolInvocationId"].as_str()).map(str::to_owned),
                        call_id: nonempty(value["callId"].as_str()).map(str::to_owned),
                    },
                );
            }
        }
        if let Some(tool) = part.tool.as_ref().filter(|tool| tool.status != "started") {
            self.results.insert(
                part.number,
                ToolResult {
                    run: part.run_id.clone(),
                    invocation: nonempty(tool.tool_invocation_id.as_deref()).map(str::to_owned),
                    call_id: tool.call_id.clone(),
                    name: tool.name.clone(),
                },
            );
        }
    }

    pub(crate) fn index(&self, total: u32) -> PatchIndex {
        let mut by_invocation = HashMap::new();
        let mut by_call_id: HashMap<_, Vec<_>> = HashMap::new();
        for (&position, call) in self.calls.range(..(total, 0)) {
            if let Some(invocation) = &call.invocation {
                by_invocation.insert((call.run.as_str(), invocation.as_str()), position);
            }
            if let Some(call_id) = &call.call_id {
                by_call_id
                    .entry((call.run.as_str(), call_id.as_str()))
                    .or_default()
                    .push((position, call.invocation.is_some()));
            }
        }
        let mut index = PatchIndex::default();
        for (&number, result) in self.results.range(..total) {
            let invocation = result.invocation.as_deref();
            let position = invocation
                .and_then(|invocation| by_invocation.get(&(result.run.as_str(), invocation)))
                .copied()
                .or_else(|| {
                    if !result.name.is_empty() && result.name != "apply_patch" {
                        return None;
                    }
                    let calls = by_call_id.get(&(result.run.as_str(), result.call_id.as_str()))?;
                    let mut candidates = calls
                        .iter()
                        .filter(|(_, has_invocation)| invocation.is_none() || !has_invocation);
                    candidates
                        .clone()
                        .rev()
                        .find(|(position, _)| position.0 < number)
                        .or_else(|| candidates.next())
                        .map(|(position, _)| *position)
                });
            if let Some(position) = position {
                index.results.entry(position).or_insert(number);
            } else if result.name == "apply_patch" {
                index.orphans.insert(number);
            }
        }
        index
    }
}

async fn read_page(
    store: &TranscriptStore,
    user: &str,
    thread: &str,
    mut cursor: MonitorCursor,
    total: u32,
    filter: &MonitorFilter,
    max_chars: usize,
) -> anyhow::Result<MonitorPage> {
    let mut page = PageBuilder::new(max_chars);
    let mut patches = None;
    while cursor.part < total {
        let end = cursor.part.saturating_add(TRANSCRIPT_CHUNK_SIZE).min(total);
        let parts = store
            .read_parts_range(user, thread, cursor.part, end)
            .await?;
        for part in parts {
            anyhow::ensure!(part.number == cursor.part, "monitor transcript has a gap");
            if filter
                .only_run_id
                .as_deref()
                .is_some_and(|run| run != part.run_id)
            {
                cursor.next_part();
                continue;
            }
            if let Some(prompt) = &part.prompt
                && prompt.hidden.is_none()
                && !filter.hidden_prompt_runs.contains(&part.run_id)
                && !page.text(
                    format!("prompt:{}", part.source_key),
                    &prompt.text,
                    true,
                    &mut cursor.offset,
                )?
            {
                return page.finish(cursor, true);
            }
            if let Some(completion) = &part.completion {
                for (index, item) in completion.items.iter().enumerate().skip(cursor.item) {
                    cursor.item = index;
                    match item["type"].as_str() {
                        Some("text") => {
                            if !page.text(
                                format!("text:{}:{index}", part.source_key),
                                item["text"].as_str().unwrap_or_default(),
                                false,
                                &mut cursor.offset,
                            )? {
                                return page.finish(cursor, true);
                            }
                        }
                        Some("tool-call") if item["name"] == "apply_patch" => {
                            if patches.is_none() {
                                patches = Some(store.patch_index(user, thread, total).await?);
                            }
                            let number = patches
                                .as_ref()
                                .and_then(|patches| patches.results.get(&(part.number, index)))
                                .copied();
                            let Some(number) = number else {
                                // Keep the call position so a later result cannot be skipped.
                                return page.finish(cursor, false);
                            };
                            let result = store
                                .read_parts(user, thread, &[number])
                                .await?
                                .pop()
                                .context("patch result part is missing")?;
                            let tool = result.tool.context("patch result body is missing")?;
                            if !page.patch(
                                format!("patch:{}:{index}", part.source_key),
                                &tool,
                                &mut cursor.offset,
                            )? {
                                return page.finish(cursor, true);
                            }
                        }
                        _ => {}
                    }
                    cursor.item = index + 1;
                    cursor.offset = 0;
                }
            }
            if let Some(tool) = &part.tool
                && tool.status != "started"
                && tool.name == "apply_patch"
            {
                if patches.is_none() {
                    patches = Some(store.patch_index(user, thread, total).await?);
                }
                if patches
                    .as_ref()
                    .is_some_and(|patches| patches.orphans.contains(&part.number))
                    && !page.patch(
                        format!("patch:{}", part.source_key),
                        tool,
                        &mut cursor.offset,
                    )?
                {
                    return page.finish(cursor, true);
                }
            }
            cursor.next_part();
        }
        anyhow::ensure!(cursor.part == end, "monitor transcript has a gap");
        tokio::task::yield_now().await;
    }
    page.finish(cursor, false)
}

fn patch_change_cost(change: &PatchChangeSummary) -> usize {
    change.operation.chars().count()
        + change.path.chars().count()
        + change
            .source_path
            .as_ref()
            .map_or(0, |source| source.chars().count())
        + 1
}

fn patch_changes(output: Option<&JsonValue>) -> Vec<PatchChangeSummary> {
    let Some(output) = output else {
        return Vec::new();
    };
    output["changes"]
        .as_array()
        .map(|changes| {
            changes
                .iter()
                .filter_map(|change| {
                    Some(PatchChangeSummary {
                        operation: change["operation"].as_str()?.to_owned(),
                        path: change["path"].as_str()?.to_owned(),
                        source_path: change["source"].as_str().map(str::to_owned),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests;
