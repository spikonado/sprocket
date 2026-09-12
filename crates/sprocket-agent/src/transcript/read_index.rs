use std::collections::BTreeSet;

use rusqlite::{Connection, OptionalExtension, params};

use super::TranscriptPart;
use super::sections::{WorkItem, WorkMembership, WorkPosition, hidden_tool, string, timing};

pub(super) struct ReadIndex<'a>(pub &'a Connection);

const DISPLAY_ITEM: &str = "(canonical=1 OR (NOT EXISTS (
    SELECT 1 FROM source_refs c WHERE c.run=s.run AND c.call_id=s.call_id AND c.canonical=1
) AND sequence=(SELECT MIN(t.sequence) FROM source_refs t WHERE t.run=s.run AND t.call_id=s.call_id AND t.canonical=0)))";

impl ReadIndex<'_> {
    pub fn initialize(db: &Connection) -> anyhow::Result<()> {
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS source_refs (
                number INTEGER NOT NULL, offset INTEGER NOT NULL, sequence INTEGER NOT NULL,
                section TEXT, run TEXT NOT NULL, call_id TEXT, canonical INTEGER NOT NULL,
                session TEXT, terminal INTEGER NOT NULL, body TEXT NOT NULL,
                PRIMARY KEY(number,offset)
            );
            CREATE INDEX IF NOT EXISTS source_refs_section_sequence ON source_refs(section,sequence);
            CREATE INDEX IF NOT EXISTS source_refs_run_call_canonical_sequence ON source_refs(run,call_id,canonical,sequence);
            CREATE INDEX IF NOT EXISTS source_refs_run_call_terminal_sequence ON source_refs(run,call_id,terminal,sequence);
            CREATE INDEX IF NOT EXISTS source_refs_run_session_terminal_sequence ON source_refs(run,session,terminal,sequence);"
        )?;
        Ok(())
    }

    pub fn insert_part(&self, part: &TranscriptPart) -> anyhow::Result<()> {
        if let Some(completion) = &part.completion {
            for (offset, value) in completion.items.iter().enumerate() {
                let kind = value["type"].as_str();
                let call_id = string(value, "callId");
                let name = string(value, "name");
                match kind {
                    Some("reasoning")
                        if value["text"]
                            .as_str()
                            .is_some_and(|text| !text.trim().is_empty()) => {}
                    Some("tool-call") if name.as_deref().is_some_and(|name| !hidden_tool(name)) => {
                    }
                    _ => continue,
                }
                let item = WorkItem {
                    run_id: part.run_id.clone(),
                    section: String::new(),
                    source: WorkPosition {
                        part: part.number,
                        item: u32::try_from(offset)?,
                    },
                    call_id,
                    name,
                    result_part: None,
                    tool_parts: BTreeSet::new(),
                    canonical: true,
                    started_at: timing(value, "startedAt"),
                    completed_at: timing(value, "completedAt"),
                    session_id: value
                        .get("input")
                        .and_then(|input| string(input, "sessionId")),
                    running: false,
                    approval: None,
                };
                self.insert(&item, false)?;
            }
        }
        if let Some(tool) = &part.tool {
            if hidden_tool(&tool.name) {
                return Ok(());
            }
            let terminal = tool.status != "started";
            let item = WorkItem {
                run_id: part.run_id.clone(),
                section: String::new(),
                source: WorkPosition {
                    part: part.number,
                    item: 0,
                },
                call_id: Some(tool.call_id.clone()),
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
                session_id: tool
                    .output
                    .as_ref()
                    .and_then(|output| string(output, "sessionId")),
                running: tool
                    .output
                    .as_ref()
                    .is_some_and(|output| output["running"] == true),
                approval: tool
                    .output
                    .as_ref()
                    .filter(|_| tool.name == "mandate_setup")
                    .and_then(|output| {
                        string(output, "mandateId").zip(string(output, "approvalUrl"))
                    }),
            };
            self.insert(&item, terminal)?;
        }
        self.0.execute("UPDATE source_refs AS result SET session=(
            SELECT call.session FROM source_refs call WHERE call.run=result.run AND call.call_id=result.call_id AND call.canonical=1 LIMIT 1)
            WHERE result.canonical=0 AND result.session IS NULL AND result.run=? AND result.call_id IN (
                SELECT call_id FROM source_refs WHERE number=? AND call_id IS NOT NULL)", params![part.run_id,part.number])?;
        let membership: Option<String> = self
            .0
            .query_row(
                "SELECT body FROM memberships WHERE number=?",
                [part.number],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(membership) = membership {
            self.link(&serde_json::from_str(&membership)?)?;
        }
        Ok(())
    }

    fn insert(&self, item: &WorkItem, terminal: bool) -> anyhow::Result<()> {
        self.0.execute(
            "INSERT OR IGNORE INTO source_refs VALUES (?,?,?,NULL,?,?,?,?,?,?)",
            params![
                item.source.part,
                item.source.item,
                i64::try_from(item.source.sequence())?,
                item.run_id,
                item.call_id,
                item.canonical,
                item.session_id,
                terminal,
                serde_json::to_string(item)?
            ],
        )?;
        Ok(())
    }

    pub fn link(&self, membership: &WorkMembership) -> anyhow::Result<()> {
        self.0.execute(
            "UPDATE source_refs SET section=NULL WHERE number=?",
            [membership.number],
        )?;
        for range in &membership.ranges {
            self.0.execute("UPDATE source_refs SET section=? WHERE number=? AND canonical=1 AND offset>=? AND offset<?",
                params![range.section_key,membership.number,range.start,range.end])?;
        }
        if let Some(section) = &membership.section_key {
            self.0.execute(
                "UPDATE source_refs SET section=? WHERE number=? AND canonical=0",
                params![section, membership.number],
            )?;
        }
        Ok(())
    }

    pub fn approvals_for_part(&self, number: u32) -> anyhow::Result<Vec<WorkItem>> {
        let bodies: Vec<String> = self.0.prepare(
            "SELECT DISTINCT canonical.body FROM source_refs changed JOIN source_refs canonical
            ON canonical.run=changed.run AND canonical.call_id=changed.call_id AND canonical.canonical=1
            WHERE changed.number=?"
        )?.query_map([number], |row| row.get(0))?.collect::<Result<_,_>>()?;
        let mut approvals = Vec::new();
        for body in bodies {
            let mut item: WorkItem = serde_json::from_str(&body)?;
            self.pair(&mut item)?;
            if item.approval.is_some() {
                approvals.push(item);
            }
        }
        Ok(approvals)
    }

    pub fn affected_sections(&self, number: u32) -> anyhow::Result<Vec<String>> {
        Ok(self.0.prepare("SELECT section FROM source_refs WHERE number=? AND section IS NOT NULL
            UNION SELECT linked.section FROM source_refs changed JOIN source_refs linked
                ON linked.run=changed.run AND linked.call_id=changed.call_id WHERE changed.number=? AND linked.section IS NOT NULL
            UNION SELECT linked.section FROM source_refs changed JOIN source_refs linked
                ON linked.run=changed.run AND linked.session=changed.session WHERE changed.number=? AND linked.section IS NOT NULL")?
            .query_map([number,number,number], |row| row.get(0))?.collect::<Result<_,_>>()?)
    }

    pub fn page(
        &self,
        section: &str,
        after: i64,
        before: i64,
        descending: bool,
        limit: u32,
    ) -> anyhow::Result<Vec<WorkItem>> {
        let direction = if descending { "DESC" } else { "ASC" };
        let sql = format!("SELECT body FROM source_refs s WHERE section=? AND sequence>? AND sequence<? AND {DISPLAY_ITEM}
            ORDER BY sequence {direction} LIMIT ?");
        let items = self
            .0
            .prepare(&sql)?
            .query_map(params![section, after, before, limit], |row| {
                row.get::<_, String>(0)
            })?
            .map(|row| Ok(serde_json::from_str(&row?)?))
            .collect::<anyhow::Result<Vec<WorkItem>>>()?;
        items
            .into_iter()
            .map(|mut item| {
                item.section = section.to_owned();
                self.pair(&mut item)?;
                Ok(item)
            })
            .collect()
    }

    pub fn item_count(&self, section: &str) -> anyhow::Result<u32> {
        Ok(self.0.query_row(
            &format!("SELECT COUNT(*) FROM source_refs s WHERE section=? AND {DISPLAY_ITEM}"),
            [section],
            |row| row.get(0),
        )?)
    }

    fn event(&self, run: &str, call: &str, terminal: bool) -> anyhow::Result<Option<WorkItem>> {
        let body: Option<String> = self.0.query_row(
            "SELECT body FROM source_refs WHERE run=? AND call_id=? AND terminal=? AND canonical=0 ORDER BY sequence LIMIT 1",
            params![run,call,terminal], |row| row.get(0)).optional()?;
        body.map(|body| serde_json::from_str(&body).map_err(Into::into))
            .transpose()
    }

    fn pair(&self, item: &mut WorkItem) -> anyhow::Result<()> {
        let Some(call) = &item.call_id else {
            return Ok(());
        };
        if item.started_at.is_none() {
            item.started_at = self
                .event(&item.run_id, call, false)?
                .and_then(|event| event.started_at);
        }
        if let Some(result) = self.event(&item.run_id, call, true)? {
            item.result_part = result.result_part;
            item.completed_at = result.completed_at;
            item.running = result.running;
            item.session_id = result.session_id.or(item.session_id.take());
            item.approval = result.approval;
        }
        if item.name.as_deref() == Some("exec_command") {
            if let Some(session) = &item.session_id {
                let body: Option<String> = self.0.query_row(
                    "SELECT body FROM source_refs s WHERE run=? AND session=? AND terminal=1
                    AND json_extract(body,'$.name') IN ('exec_command','write_stdin')
                    AND NOT EXISTS (SELECT 1 FROM source_refs earlier WHERE earlier.run=s.run AND earlier.call_id=s.call_id AND earlier.terminal=1 AND earlier.sequence<s.sequence)
                    ORDER BY sequence DESC LIMIT 1",
                    params![item.run_id,session], |row| row.get(0)).optional()?;
                if let Some(body) = body {
                    let latest: WorkItem = serde_json::from_str(&body)?;
                    item.running = latest.running;
                    if !latest.running {
                        item.completed_at = latest.completed_at.or(item.completed_at);
                    }
                }
            }
        } else {
            item.running = false;
        }
        Ok(())
    }
}
