use rusqlite::{Connection, OptionalExtension, Row, params};

use super::TranscriptPart;
use super::sections::{WorkItem, WorkPosition, string};

pub(super) struct ReadIndex<'a>(pub &'a Connection);

pub(super) const DISPLAY_ITEM: &str = "(canonical=1 OR (NOT EXISTS (
    SELECT 1 FROM source_refs c WHERE c.run=s.run AND c.canonical=1 AND
    (c.identity=s.identity OR c.identity='call:'||s.call_id)
) AND sequence=(SELECT MIN(t.sequence) FROM source_refs t WHERE t.run=s.run AND t.identity=s.identity AND t.canonical=0)))";

pub(super) const ITEM_COLUMNS: &str =
    "s.number,s.offset,s.run,s.call_id,s.identity,s.canonical,s.terminal";

pub(super) fn read_item(row: &Row<'_>) -> rusqlite::Result<WorkItem> {
    let number: u32 = row.get(0)?;
    let identity: Option<String> = row.get(4)?;
    let terminal: bool = row.get(6)?;
    Ok(WorkItem {
        run_id: row.get(2)?,
        source: WorkPosition {
            part: number,
            item: row.get(1)?,
        },
        call_id: row.get(3)?,
        tool_invocation_id: identity
            .as_deref()
            .and_then(|identity| identity.strip_prefix("invocation:"))
            .map(str::to_owned),
        result_part: terminal.then_some(number),
        canonical: row.get(5)?,
    })
}

impl ReadIndex<'_> {
    pub fn initialize(db: &Connection) -> anyhow::Result<()> {
        db.execute_batch(
            "CREATE TABLE source_refs (
                number INTEGER NOT NULL, offset INTEGER NOT NULL, sequence INTEGER NOT NULL,
                run TEXT NOT NULL, call_id TEXT, identity TEXT, canonical INTEGER NOT NULL,
                terminal INTEGER NOT NULL,
                PRIMARY KEY(number,offset)
            );
            CREATE INDEX source_refs_run_identity_canonical_sequence ON source_refs(run,identity,canonical,sequence);
            CREATE INDEX source_refs_run_identity_terminal_sequence ON source_refs(run,identity,terminal,sequence);
            CREATE INDEX source_refs_run_call_id_terminal_sequence ON source_refs(run,call_id,terminal,sequence);",
        )?;
        Ok(())
    }

    pub fn rebuild_run(&self, parts: &[TranscriptPart]) -> anyhow::Result<()> {
        let Some(first) = parts.first() else {
            return Ok(());
        };
        self.0
            .execute("DELETE FROM source_refs WHERE run=?", [&first.run_id])?;
        for part in parts {
            for (offset, value) in part.content_items().iter().enumerate() {
                if value["type"] != "tool-call" {
                    continue;
                }
                let item = WorkItem {
                    run_id: part.run_id.clone(),
                    source: WorkPosition {
                        part: part.number,
                        item: offset as u32,
                    },
                    call_id: string(value, "callId"),
                    tool_invocation_id: string(value, "toolInvocationId"),
                    result_part: None,
                    canonical: true,
                };
                self.insert(&item)?;
            }
            if let Some(item) = WorkItem::tool_event(part) {
                self.insert(&item)?;
            }
        }
        Ok(())
    }

    fn insert(&self, item: &WorkItem) -> anyhow::Result<()> {
        self.0.execute(
            "INSERT INTO source_refs VALUES (?,?,?,?,?,?,?,?)",
            params![
                item.source.part,
                item.source.item,
                i64::try_from(item.source.sequence())?,
                item.run_id,
                item.call_id,
                item.identity(),
                item.canonical,
                item.result_part.is_some()
            ],
        )?;
        Ok(())
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
}
