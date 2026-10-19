use std::collections::BTreeMap;

use rusqlite::{Connection, OptionalExtension, Row, params};

use super::TranscriptPart;
use super::sections::{WorkItem, WorkPosition, string};

pub(super) struct ReadIndex<'a>(pub &'a Connection);

pub(super) const DISPLAY_ITEM: &str = "(canonical=1 OR (NOT EXISTS (
    SELECT 1 FROM source_refs c WHERE c.run=s.run AND c.canonical=1 AND
    (c.identity=s.identity OR c.identity='call:'||s.call_id)
) AND sequence=(SELECT MIN(t.sequence) FROM source_refs t WHERE t.run=s.run AND t.identity=s.identity AND t.canonical=0)))";

pub(super) const ITEM_COLUMNS: &str = "s.number,s.offset,s.section,s.run,s.call_id,s.identity,s.canonical,s.terminal,s.mandate_id,s.approval_url";

pub(super) fn read_item(row: &Row<'_>) -> rusqlite::Result<WorkItem> {
    let number: u32 = row.get(0)?;
    let identity: Option<String> = row.get(5)?;
    let terminal: bool = row.get(7)?;
    let mandate_id: Option<String> = row.get(8)?;
    let approval_url: Option<String> = row.get(9)?;
    Ok(WorkItem {
        run_id: row.get(3)?,
        section: row.get(2)?,
        source: WorkPosition {
            part: number,
            item: row.get(1)?,
        },
        call_id: row.get(4)?,
        tool_invocation_id: identity
            .as_deref()
            .and_then(|identity| identity.strip_prefix("invocation:"))
            .map(str::to_owned),
        result_part: terminal.then_some(number),
        canonical: row.get(6)?,
        approval: mandate_id.zip(approval_url),
    })
}

impl ReadIndex<'_> {
    pub fn initialize(db: &Connection) -> anyhow::Result<()> {
        db.execute_batch(
            "CREATE TABLE source_refs (
                number INTEGER NOT NULL, offset INTEGER NOT NULL, sequence INTEGER NOT NULL,
                section TEXT, run TEXT NOT NULL, call_id TEXT, identity TEXT, canonical INTEGER NOT NULL,
                terminal INTEGER NOT NULL, mandate_id TEXT, approval_url TEXT,
                PRIMARY KEY(number,offset)
            );
            CREATE INDEX source_refs_section_sequence ON source_refs(section,sequence);
            CREATE INDEX source_refs_run_identity_canonical_sequence ON source_refs(run,identity,canonical,sequence);
            CREATE INDEX source_refs_run_identity_terminal_sequence ON source_refs(run,identity,terminal,sequence);
            CREATE INDEX source_refs_run_call_id_terminal_sequence ON source_refs(run,call_id,terminal,sequence);",
        )?;
        Ok(())
    }

    pub fn insert_part(&self, part: &TranscriptPart) -> anyhow::Result<()> {
        if part.completion.is_some() {
            for (offset, value) in part.content_items().iter().enumerate() {
                match value["type"].as_str() {
                    Some("reasoning")
                        if value["text"]
                            .as_str()
                            .is_some_and(|text| !text.trim().is_empty()) => {}
                    Some("tool-call") => {}
                    _ => continue,
                }
                let item = WorkItem {
                    run_id: part.run_id.clone(),
                    section: None,
                    source: WorkPosition {
                        part: part.number,
                        item: u32::try_from(offset)?,
                    },
                    call_id: string(value, "callId"),
                    tool_invocation_id: part
                        .work
                        .tool_invocations
                        .iter()
                        .find(|invocation| invocation.item as usize == offset)
                        .map(|invocation| invocation.tool_invocation_id.clone()),
                    result_part: None,
                    canonical: true,
                    approval: None,
                };
                self.insert(&item)?;
            }
        }
        if let Some(item) = WorkItem::tool_event(part) {
            self.insert(&item)?;
        }
        self.link(part.number, part.work_assignment())?;
        Ok(())
    }

    fn insert(&self, item: &WorkItem) -> anyhow::Result<()> {
        let (mandate_id, approval_url) = item.approval.clone().unzip();
        self.0.execute(
            "INSERT OR IGNORE INTO source_refs VALUES (?,?,?,NULL,?,?,?,?,?,?,?)",
            params![
                item.source.part,
                item.source.item,
                i64::try_from(item.source.sequence())?,
                item.run_id,
                item.call_id,
                item.identity(),
                item.canonical,
                item.result_part.is_some(),
                mandate_id,
                approval_url
            ],
        )?;
        Ok(())
    }

    pub fn link(
        &self,
        number: u32,
        assignment: &super::sections::WorkAssignment,
    ) -> anyhow::Result<()> {
        self.0.execute(
            "UPDATE source_refs SET section=NULL WHERE number=?",
            [number],
        )?;
        for range in &assignment.ranges {
            self.0.execute("UPDATE source_refs SET section=? WHERE number=? AND canonical=1 AND offset>=? AND offset<?",
                params![range.section_key,number,range.start,range.end])?;
        }
        if let Some(section) = &assignment.section_key {
            self.0.execute(
                "UPDATE source_refs SET section=? WHERE number=? AND canonical=0",
                params![section, number],
            )?;
        }
        Ok(())
    }

    pub fn approvals_for_part(&self, number: u32) -> anyhow::Result<Vec<WorkItem>> {
        let items: Vec<WorkItem> = self
            .0
            .prepare(&format!(
                "SELECT DISTINCT {ITEM_COLUMNS} FROM source_refs changed JOIN source_refs s
            ON s.run=changed.run AND s.canonical=1 AND
            (s.identity=changed.identity OR s.identity='call:'||changed.call_id)
            WHERE changed.number=?"
            ))?
            .query_map([number], read_item)?
            .collect::<Result<_, _>>()?;
        let mut approvals = Vec::new();
        for mut item in items {
            self.pair(&mut item)?;
            if item.approval.is_some() {
                approvals.push(item);
            }
        }
        Ok(approvals)
    }

    pub fn affected_sections(&self, number: u32) -> anyhow::Result<Vec<String>> {
        Ok(self
            .0
            .prepare(
                "SELECT section FROM source_refs WHERE number=? AND section IS NOT NULL
            UNION SELECT linked.section FROM source_refs changed JOIN source_refs linked
                ON linked.run=changed.run AND (linked.identity=changed.identity OR
                (linked.canonical=1 AND linked.identity='call:'||changed.call_id))
                WHERE changed.number=? AND linked.section IS NOT NULL",
            )?
            .query_map([number, number], |row| row.get(0))?
            .collect::<Result<_, _>>()?)
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
        let sql = format!("SELECT {ITEM_COLUMNS} FROM source_refs s WHERE section=? AND sequence>? AND sequence<? AND {DISPLAY_ITEM}
            ORDER BY sequence {direction} LIMIT ?");
        let items: Vec<WorkItem> = self
            .0
            .prepare(&sql)?
            .query_map(params![section, after, before, limit], read_item)?
            .collect::<Result<_, _>>()?;
        items
            .into_iter()
            .map(|mut item| {
                self.pair(&mut item)?;
                Ok(item)
            })
            .collect()
    }

    pub fn tool_counts(&self, section: &str) -> anyhow::Result<BTreeMap<String, u32>> {
        Ok(self
            .0
            .prepare(&format!(
                "WITH displayed AS MATERIALIZED (
                    SELECT s.number,s.offset,s.canonical FROM source_refs s
                    WHERE s.section=? AND {DISPLAY_ITEM}
                ), completions AS MATERIALIZED (
                    SELECT p.number,CAST(j.key AS INTEGER) AS offset,json_extract(j.value,'$.name') AS name,
                        json_extract(j.value,'$.type') AS kind
                    FROM parts p JOIN (SELECT DISTINCT number FROM displayed WHERE canonical=1) d
                        ON d.number=p.number, json_each(p.body,'$.completion.items') j
                ), tools AS (
                    SELECT c.name,c.kind FROM displayed d JOIN completions c
                        ON c.number=d.number AND c.offset=d.offset WHERE d.canonical=1
                    UNION ALL
                    SELECT json_extract(p.body,'$.tool.name'),'tool-call'
                    FROM displayed d JOIN parts p ON p.number=d.number WHERE d.canonical=0
                )
                SELECT name,COUNT(*) FROM tools
                WHERE kind='tool-call' AND typeof(name)='text' GROUP BY name"
            ))?
            .query_map([section], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<Result<_, _>>()?)
    }

    pub fn unpersisted_tool_call_ids(&self, section: &str) -> anyhow::Result<Vec<String>> {
        Ok(self
            .0
            .prepare(&format!(
                "SELECT DISTINCT call_id FROM source_refs s
                WHERE section=? AND canonical=0 AND call_id IS NOT NULL AND {DISPLAY_ITEM}"
            ))?
            .query_map([section], |row| row.get(0))?
            .collect::<Result<_, _>>()?)
    }

    pub(super) fn result_event(&self, item: &WorkItem) -> anyhow::Result<Option<WorkItem>> {
        let (key, value) = if item.tool_invocation_id.is_some() {
            ("identity", item.identity())
        } else {
            ("call_id", item.call_id.clone())
        };
        Ok(self
            .0
            .query_row(
                &format!(
                    "SELECT {ITEM_COLUMNS} FROM source_refs s WHERE run=? AND {key}=?
                    AND terminal=1 AND canonical=0 ORDER BY sequence LIMIT 1"
                ),
                params![item.run_id, value],
                read_item,
            )
            .optional()?)
    }

    fn pair(&self, item: &mut WorkItem) -> anyhow::Result<()> {
        if item.call_id.is_none() {
            return Ok(());
        }
        if let Some(result) = self.result_event(item)? {
            item.merge_event(result);
        }
        Ok(())
    }
}
