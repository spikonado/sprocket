use anyhow::Context;
use rusqlite::{Connection, OptionalExtension, params};
use serde::de::DeserializeOwned;

use super::sections::{WorkIndex, WorkItem, WorkMembership, WorkSection, WorkSession};

pub(super) struct SqlWorkIndex<'a>(pub &'a Connection);

impl SqlWorkIndex<'_> {
    pub fn initialize(db: &Connection) -> anyhow::Result<()> {
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS work_sections (
                key TEXT PRIMARY KEY, body TEXT NOT NULL, run TEXT NOT NULL, settled INTEGER NOT NULL DEFAULT 0,
                count INTEGER NOT NULL DEFAULT 0, pending INTEGER NOT NULL DEFAULT 0,
                canonical INTEGER NOT NULL DEFAULT 0,
                missing_start INTEGER NOT NULL DEFAULT 0, missing_end INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS work_sections_settled_run_key ON work_sections(settled,run,key);
            CREATE TABLE IF NOT EXISTS work_items (
                id TEXT PRIMARY KEY, section TEXT NOT NULL, sequence INTEGER NOT NULL,
                run TEXT NOT NULL, session TEXT, name TEXT,
                started REAL, completed REAL, body TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS work_items_section_sequence ON work_items(section, sequence);
            CREATE INDEX IF NOT EXISTS work_items_section_started ON work_items(section, started);
            CREATE INDEX IF NOT EXISTS work_items_section_completed ON work_items(section, completed);
            CREATE INDEX IF NOT EXISTS work_items_run_session_name ON work_items(run, session, name);
            CREATE TABLE IF NOT EXISTS work_memberships (number INTEGER PRIMARY KEY, body TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS work_sessions (run TEXT NOT NULL, session TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(run, session));"
        )?;
        Ok(())
    }

    fn one<T: DeserializeOwned>(
        &self,
        sql: &str,
        args: impl rusqlite::Params,
    ) -> anyhow::Result<Option<T>> {
        let body: Option<String> = self.0.query_row(sql, args, |row| row.get(0)).optional()?;
        body.map(|body| serde_json::from_str(&body).map_err(Into::into))
            .transpose()
    }

    fn adjust(&self, item: &WorkItem, sign: i32) -> anyhow::Result<()> {
        let pending = item.call_id.is_some() && (item.result_part.is_none() || item.running);
        let changed = self.0.execute(
            "UPDATE work_sections SET count=count+?, pending=pending+?, canonical=canonical+?,
                missing_start=missing_start+?, missing_end=missing_end+? WHERE key=?",
            params![
                sign,
                sign * i32::from(pending),
                sign * i32::from(item.canonical),
                sign * i32::from(item.started_at.is_none()),
                sign * i32::from(item.known_completion().is_none()),
                item.section
            ],
        )?;
        anyhow::ensure!(changed == 1, "work item references a missing section");
        Ok(())
    }
}

impl WorkIndex for SqlWorkIndex<'_> {
    fn section(&self, key: &str) -> anyhow::Result<Option<WorkSection>> {
        self.one("SELECT body FROM work_sections WHERE key=?", [key])
    }

    fn save_section(&self, section: &WorkSection) -> anyhow::Result<()> {
        self.0.execute("INSERT INTO work_sections(key,body,run) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body",
            params![section.key, serde_json::to_string(section)?, section.run_id])?;
        Ok(())
    }

    fn remove_section(&self, key: &str) -> anyhow::Result<()> {
        self.0
            .execute("DELETE FROM work_sections WHERE key=? AND count=0", [key])?;
        Ok(())
    }

    fn summarize(&self, key: &str) -> anyhow::Result<Option<WorkSection>> {
        let mut section = self.section(key)?.context("work section missing")?;
        let (count, pending, canonical, missing_start, missing_end): (u32,u32,u32,u32,u32) = self.0.query_row(
            "SELECT count,pending,canonical,missing_start,missing_end FROM work_sections WHERE key=?", [key],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?)))?;
        if count == 0 {
            return Ok(None);
        }
        section.item_count = count;
        let settled: bool = self.0.query_row(
            "SELECT settled FROM work_sections WHERE key=?",
            [key],
            |row| row.get(0),
        )?;
        section.pending_tools = if settled { 0 } else { pending };
        section.closed |= settled;
        section.provisional = canonical == 0;
        section.started_at = if missing_start == 0 {
            self.0.query_row(
                "SELECT started FROM work_items WHERE section=? ORDER BY started LIMIT 1",
                [key],
                |row| row.get(0),
            )?
        } else {
            None
        };
        section.completed_at = if missing_end == 0 && pending == 0 {
            self.0.query_row(
                "SELECT completed FROM work_items WHERE section=? ORDER BY completed DESC LIMIT 1",
                [key],
                |row| row.get(0),
            )?
        } else {
            None
        };
        Ok(Some(section))
    }

    fn item(&self, id: &str) -> anyhow::Result<Option<WorkItem>> {
        self.one("SELECT body FROM work_items WHERE id=?", [id])
    }

    fn save_item(&self, id: &str, item: &WorkItem) -> anyhow::Result<()> {
        if let Some(previous) = self.item(id)? {
            self.adjust(&previous, -1)?;
        }
        self.adjust(item, 1)?;
        self.0.execute("INSERT INTO work_items VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
            section=excluded.section, sequence=excluded.sequence, run=excluded.run, session=excluded.session,
            name=excluded.name, started=excluded.started, completed=excluded.completed, body=excluded.body",
            params![id,item.section,i64::try_from(item.source.sequence())?,item.run_id,item.session_id,item.name,
                item.started_at,item.known_completion(),serde_json::to_string(item)?])?;
        Ok(())
    }

    fn membership(&self, number: u32) -> anyhow::Result<WorkMembership> {
        Ok(self
            .one("SELECT body FROM work_memberships WHERE number=?", [number])?
            .unwrap_or_else(|| WorkMembership {
                number,
                ..Default::default()
            }))
    }

    fn save_membership(&self, membership: &WorkMembership) -> anyhow::Result<()> {
        self.0.execute("INSERT INTO work_memberships VALUES (?,?) ON CONFLICT(number) DO UPDATE SET body=excluded.body",
            params![membership.number,serde_json::to_string(membership)?])?;
        Ok(())
    }

    fn session(&self, run: &str, session: &str) -> anyhow::Result<Option<WorkSession>> {
        self.one(
            "SELECT body FROM work_sessions WHERE run=? AND session=?",
            [run, session],
        )
    }

    fn save_session(&self, run: &str, session: &str, value: &WorkSession) -> anyhow::Result<()> {
        self.0.execute("INSERT INTO work_sessions VALUES (?,?,?) ON CONFLICT(run,session) DO UPDATE SET body=excluded.body",
            params![run,session,serde_json::to_string(value)?])?;
        Ok(())
    }

    fn session_commands(
        &self,
        run: &str,
        session: &str,
    ) -> anyhow::Result<Vec<(String, WorkItem)>> {
        self.0
            .prepare(
                "SELECT id,body FROM work_items WHERE run=? AND session=? AND name='exec_command'",
            )?
            .query_map([run, session], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .map(|row| {
                let (id, body) = row?;
                Ok((id, serde_json::from_str(&body)?))
            })
            .collect()
    }
}
