use anyhow::Context;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::collections::BTreeSet;

use super::WorkReplica;
use super::read_index::DISPLAY_ITEM;
use super::sections::POSITION_STRIDE;
use super::sections::WorkItem;
use super::store::TranscriptStore;

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

/// Cursor failures are explicit so callers restart from the beginning instead
/// of silently dropping history.
#[derive(Clone, Copy, Debug, thiserror::Error, PartialEq, Eq)]
pub enum MonitorReadError {
    #[error("monitor cursor is malformed")]
    MalformedCursor,
    #[error("monitor cursor belongs to a different thread")]
    WrongThread,
    #[error("monitor transcript was reset or rebuilt; restart without a cursor")]
    MonitorCursorReset,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MonitorCursor {
    thread_id: String,
    replica_id: String,
    revision: u64,
    scanned: u64,
    resume: Option<ResumeEntry>,
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    fallback_patches: BTreeSet<(String, String)>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct ResumeEntry {
    id: String,
    offset: u64,
    patch: bool,
}

pub async fn read_monitor_page(
    store: &TranscriptStore,
    user_id: &str,
    thread_id: &str,
    cursor: Option<&str>,
    max_chars: usize,
) -> anyhow::Result<MonitorPage> {
    let cursor = cursor.map(parse_cursor).transpose()?;
    let user = user_id.to_string();
    let thread = thread_id.to_string();
    store
        .with_work_replica(&user, &thread, {
            let thread = thread.clone();
            move |replica| read_page(replica, &thread, cursor, max_chars)
        })
        .await
}

fn parse_cursor(encoded: &str) -> anyhow::Result<MonitorCursor> {
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| MonitorReadError::MalformedCursor)?;
    serde_json::from_slice(&bytes).map_err(|_| MonitorReadError::MalformedCursor.into())
}

fn encode_cursor(cursor: &MonitorCursor) -> anyhow::Result<String> {
    Ok(URL_SAFE_NO_PAD.encode(serde_json::to_vec(cursor)?))
}

fn read_page(
    replica: &WorkReplica,
    thread_id: &str,
    cursor: Option<MonitorCursor>,
    max_chars: usize,
) -> anyhow::Result<MonitorPage> {
    let replica_id: String = replica.state("replicaId")?.context("replica id missing")?;
    let revision = u64::try_from(replica.generation()?).unwrap_or(0);
    let mut cursor = match cursor {
        None => MonitorCursor {
            thread_id: thread_id.to_string(),
            replica_id: replica_id.clone(),
            ..MonitorCursor::default()
        },
        Some(cursor) => {
            if cursor.thread_id != thread_id {
                return Err(MonitorReadError::WrongThread.into());
            }
            if cursor.replica_id != replica_id || cursor.revision > revision {
                return Err(MonitorReadError::MonitorCursorReset.into());
            }
            cursor
        }
    };
    let max_chars = max_chars.clamp(1, MONITOR_PAGE_CHAR_LIMIT);

    let prefix: u32 = replica
        .db
        .query_row("SELECT end+1 FROM coverage WHERE start=0", [], |row| {
            row.get(0)
        })
        .optional()?
        .unwrap_or(0);
    let ready_end = u64::from(prefix) * POSITION_STRIDE;

    if let Some(resume) = cursor.resume.clone() {
        let (entry, next) = resume_entry(replica, &resume, max_chars)?;
        cursor.resume = next;
        cursor.revision = revision;
        let boundary = replica.completion_boundary(cursor.scanned, ready_end)?;
        let has_more = cursor.resume.is_some()
            || !replica
                .project_completed(cursor.scanned, boundary)?
                .is_empty()
            || prefix < replica.total()?;
        return Ok(MonitorPage {
            entries: vec![entry],
            next_cursor: encode_cursor(&cursor)?,
            has_more,
        });
    }

    // Results can arrive after unrelated committed entries. Pin at the source
    // until it completes to preserve canonical order without losing it.
    let completion_boundary = replica.completion_boundary(cursor.scanned, ready_end)?;
    let entries = replica.project_completed(cursor.scanned, completion_boundary)?;
    let mut output: Vec<MonitorEntry> = Vec::new();
    let mut used = 0usize;
    let mut exhausted = true;
    for (sequence, entry) in entries {
        let patch_identity = if matches!(entry, MonitorEntry::Patch { .. }) {
            let source = replica
                .patch_sources(sequence, sequence + 1)?
                .pop()
                .context("patch source missing")?;
            let result = match replica.patch_result_number(&source)? {
                Some(number) => replica.part(number)?,
                None => None,
            };
            let identity = result
                .and_then(|part| WorkItem::tool_event(&part))
                .and_then(|event| event.identity());
            identity.map(|identity| (source.canonical, (source.run_id, identity)))
        } else {
            None
        };
        if let Some((true, identity)) = &patch_identity {
            if cursor.fallback_patches.remove(identity) {
                cursor.scanned = sequence + 1;
                continue;
            }
        }
        if used == max_chars {
            exhausted = false;
            break;
        }
        if let MonitorEntry::Patch { changes, .. } = &entry {
            let first_cost = changes.first().map_or(0, patch_change_cost);
            anyhow::ensure!(
                first_cost <= max_chars,
                "patch path exceeds monitor page budget"
            );
            if first_cost > max_chars - used {
                exhausted = false;
                break;
            }
        }
        if let Some((false, identity)) = patch_identity {
            cursor.fallback_patches.insert(identity);
        }
        cursor.scanned = sequence + 1;
        match truncate_entry(entry, used, max_chars) {
            Truncated::Complete(entry, now_used) => {
                used = now_used;
                output.push(entry);
            }
            Truncated::Overflow(entry, now_used, resume) => {
                used = now_used;
                output.push(entry);
                cursor.resume = Some(resume);
                exhausted = false;
                break;
            }
        }
    }
    if exhausted {
        cursor.scanned = completion_boundary;
    }
    anyhow::ensure!(used <= max_chars, "monitor page exceeded the char budget");
    cursor.revision = revision;
    let has_more = cursor.resume.is_some()
        || cursor.scanned < completion_boundary
        || prefix < replica.total()?;
    Ok(MonitorPage {
        entries: output,
        next_cursor: encode_cursor(&cursor)?,
        has_more,
    })
}

enum Truncated {
    Complete(MonitorEntry, usize),
    Overflow(MonitorEntry, usize, ResumeEntry),
}

fn truncate_entry(entry: MonitorEntry, used: usize, max_chars: usize) -> Truncated {
    match entry {
        MonitorEntry::Prompt { id, text } => truncate_text(true, id, text, used, max_chars),
        MonitorEntry::Text { id, text } => truncate_text(false, id, text, used, max_chars),
        MonitorEntry::Patch { id, ok, changes } => {
            let mut used = used;
            for (index, change) in changes.iter().enumerate() {
                let cost = patch_change_cost(change);
                if used.saturating_add(cost) > max_chars && index > 0 {
                    return Truncated::Overflow(
                        MonitorEntry::Patch {
                            id: id.clone(),
                            ok,
                            changes: changes[..index].to_vec(),
                        },
                        used,
                        ResumeEntry {
                            id,
                            offset: index as u64,
                            patch: true,
                        },
                    );
                }
                used = used.saturating_add(cost);
            }
            Truncated::Complete(MonitorEntry::Patch { id, ok, changes }, used)
        }
    }
}

fn truncate_text(
    is_prompt: bool,
    id: String,
    text: String,
    used: usize,
    max_chars: usize,
) -> Truncated {
    let len = text.chars().count();
    if used.saturating_add(len) <= max_chars {
        let entry = if is_prompt {
            MonitorEntry::Prompt { id, text }
        } else {
            MonitorEntry::Text { id, text }
        };
        return Truncated::Complete(entry, used + len);
    }
    let budget = max_chars.saturating_sub(used).min(len);
    let kept: String = text.chars().take(budget).collect();
    let entry = if is_prompt {
        MonitorEntry::Prompt {
            id: id.clone(),
            text: kept,
        }
    } else {
        MonitorEntry::Text {
            id: id.clone(),
            text: kept,
        }
    };
    Truncated::Overflow(
        entry,
        used.saturating_add(budget),
        ResumeEntry {
            id,
            offset: u64::try_from(budget).unwrap_or(u64::MAX),
            patch: false,
        },
    )
}

fn patch_change_cost(change: &PatchChangeSummary) -> usize {
    change.path.chars().count()
        + change
            .source_path
            .as_ref()
            .map_or(0, |source| source.chars().count())
}

/// Renders the remaining fragment of a truncated entry. Offsets accumulate
/// against the original stored text, so consecutive resumes never restart.
fn resume_entry(
    replica: &WorkReplica,
    resume: &ResumeEntry,
    max_chars: usize,
) -> anyhow::Result<(MonitorEntry, Option<ResumeEntry>)> {
    let entry = if resume.patch {
        let sequence: u64 = resume
            .id
            .strip_prefix("patch-")
            .context("invalid patch resume identity")?
            .parse()?;
        let source: String = replica.db.query_row(
            "SELECT body FROM source_refs WHERE sequence=?",
            [i64::try_from(sequence)?],
            |row| row.get(0),
        )?;
        let source: WorkItem = serde_json::from_str(&source)?;
        let MonitorEntry::Patch { ok, changes, .. } = replica
            .patch_outcome(&source)?
            .context("patch resume result is gone")?
        else {
            anyhow::bail!("patch resume points at another entry kind");
        };
        let offset = usize::try_from(resume.offset)?;
        let remaining = changes
            .get(offset..)
            .context("patch resume offset exceeds result")?;
        anyhow::ensure!(
            remaining.first().map_or(0, patch_change_cost) <= max_chars,
            "patch path exceeds monitor page budget"
        );
        MonitorEntry::Patch {
            id: resume.id.clone(),
            ok,
            changes: remaining.to_vec(),
        }
    } else {
        let row: Option<(String, String)> = replica
            .db
            .query_row(
                "SELECT kind, json_extract(body,'$.text') FROM rows WHERE id=?",
                [&resume.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let (kind, text) = row.with_context(|| format!("monitor entry {} is gone", resume.id))?;
        let offset = usize::try_from(resume.offset).unwrap_or(usize::MAX);
        let text = text.chars().skip(offset).collect();
        match kind.as_str() {
            "prompt" => MonitorEntry::Prompt {
                id: resume.id.clone(),
                text,
            },
            "text" => MonitorEntry::Text {
                id: resume.id.clone(),
                text,
            },
            other => anyhow::bail!("monitor resume points at a {other} row"),
        }
    };
    match truncate_entry(entry, 0, max_chars) {
        Truncated::Complete(entry, _) => Ok((entry, None)),
        Truncated::Overflow(entry, _, mut next) => {
            next.offset = next.offset.saturating_add(resume.offset);
            Ok((entry, Some(next)))
        }
    }
}

impl WorkReplica {
    fn patch_sources(&self, after: u64, boundary: u64) -> anyhow::Result<Vec<WorkItem>> {
        let sql = format!(
            "SELECT s.body FROM source_refs s JOIN parts p ON p.number=s.number
            WHERE sequence>=? AND sequence<? AND CASE WHEN canonical=1
                THEN json_extract(p.body,'$.completion.items['||s.offset||'].name')
                ELSE json_extract(p.body,'$.tool.name') END='apply_patch'
            AND {DISPLAY_ITEM} ORDER BY sequence"
        );
        let bodies = self
            .db
            .prepare(&sql)?
            .query_map(
                rusqlite::params![i64::try_from(after)?, i64::try_from(boundary)?],
                |row| row.get::<_, String>(0),
            )?
            .collect::<Result<Vec<_>, _>>()?;
        bodies
            .into_iter()
            .map(|body| Ok(serde_json::from_str(&body)?))
            .collect()
    }

    fn completion_boundary(&self, after: u64, boundary: u64) -> anyhow::Result<u64> {
        let mut next = boundary;
        for source in self.patch_sources(after, boundary)? {
            if self.patch_outcome(&source)?.is_none() {
                next = next.min(source.source.sequence());
            }
        }
        Ok(next)
    }

    fn patch_result_number(&self, source: &WorkItem) -> anyhow::Result<Option<u32>> {
        Ok(match source.result_part {
            Some(number) => Some(number),
            None => {
                let identity = source.identity();
                let (key, value) = if source.tool_invocation_id.is_some() {
                    ("identity", identity.as_deref())
                } else {
                    ("call_id", source.call_id.as_deref())
                };
                self.db
                    .query_row(
                        &format!(
                            "SELECT number FROM source_refs WHERE run=?
                    AND {key}=? AND canonical=0 AND terminal=1 ORDER BY sequence LIMIT 1"
                        ),
                        rusqlite::params![source.run_id, value],
                        |row| row.get(0),
                    )
                    .optional()?
            }
        })
    }

    fn patch_outcome(&self, source: &WorkItem) -> anyhow::Result<Option<MonitorEntry>> {
        let Some(number) = self.patch_result_number(source)? else {
            return Ok(None);
        };
        let prefix: u32 = self
            .db
            .query_row("SELECT end+1 FROM coverage WHERE start=0", [], |row| {
                row.get(0)
            })
            .optional()?
            .unwrap_or(0);
        if number >= prefix {
            return Ok(None);
        }
        let part = self.part(number)?.context("patch result part missing")?;
        let tool = part.tool.context("patch result body missing")?;
        let ok = tool.status == "completed";
        Ok(Some(MonitorEntry::Patch {
            id: format!("patch-{}", source.source.sequence()),
            ok,
            changes: if ok {
                patch_changes(tool.output.as_ref())
            } else {
                Vec::new()
            },
        }))
    }
    fn total(&self) -> anyhow::Result<u32> {
        Ok(self.state("total")?.unwrap_or(0))
    }

    fn project_completed(
        &self,
        after: u64,
        boundary: u64,
    ) -> anyhow::Result<Vec<(u64, MonitorEntry)>> {
        let mut entries: Vec<(u64, MonitorEntry)> = Vec::new();
        let after_i = i64::try_from(after)?;
        let boundary_i = i64::try_from(boundary)?;
        let mut statement = self.db.prepare(
            "SELECT id, sequence, kind, json_extract(body,'$.text') FROM rows
            WHERE sequence>=? AND sequence<? AND kind IN ('prompt','text')
            ORDER BY sequence",
        )?;
        let rows: Vec<(String, i64, String, Option<String>)> = statement
            .query_map(rusqlite::params![after_i, boundary_i], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })?
            .collect::<Result<_, _>>()?;
        for (id, sequence, kind, text) in rows {
            let text = text.unwrap_or_default();
            if kind == "prompt" {
                entries.push((u64::try_from(sequence)?, MonitorEntry::Prompt { id, text }));
            } else {
                entries.push((u64::try_from(sequence)?, MonitorEntry::Text { id, text }));
            }
        }

        for source in self.patch_sources(after, boundary)? {
            if let Some(entry) = self.patch_outcome(&source)? {
                entries.push((source.source.sequence(), entry));
            }
        }
        entries.sort_by_key(|(sequence, _)| *sequence);
        Ok(entries)
    }
}

// Old results lack source paths; never reconstruct them from unexecuted input.
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
