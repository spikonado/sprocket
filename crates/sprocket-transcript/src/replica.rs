use std::path::PathBuf;

use anyhow::Context;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use super::read_index::ReadIndex;
use super::sections::{POSITION_STRIDE, WorkPosition};
use super::{TranscriptPart, TranscriptStore};

// Bump when the schema or derived row shapes change; mismatched caches are rebuilt from parts.
const SCHEMA_VERSION: i64 = 1;

const SCHEMA: &str = "CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE parts (number INTEGER PRIMARY KEY, source_key TEXT NOT NULL UNIQUE, run TEXT NOT NULL, body TEXT NOT NULL);
    CREATE INDEX parts_run_number ON parts(run, number);
    CREATE TABLE rows (id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, kind TEXT NOT NULL, generation INTEGER NOT NULL, body TEXT);
    CREATE UNIQUE INDEX rows_live_sequence ON rows(sequence) WHERE body IS NOT NULL;
    CREATE INDEX rows_generation ON rows(generation);
    INSERT INTO state VALUES ('generation', '0');";

fn read_state<T: DeserializeOwned>(db: &Connection, key: &str) -> anyhow::Result<Option<T>> {
    let value: Option<String> = db
        .query_row("SELECT value FROM state WHERE key=?", [key], |row| {
            row.get(0)
        })
        .optional()?;
    value
        .map(|value| serde_json::from_str(&value).map_err(Into::into))
        .transpose()
}

pub struct WorkReplica {
    pub(crate) db: Connection,
}

impl WorkReplica {
    fn is_corrupt(error: &anyhow::Error) -> bool {
        matches!(error.downcast_ref::<rusqlite::Error>(),
            Some(rusqlite::Error::SqliteFailure(failure,_)) if matches!(failure.code,
                rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase))
    }

    fn rebuild(directory: PathBuf) -> anyhow::Result<Self> {
        let preserved =
            directory.with_file_name(format!("replica-corrupt-{}", uuid::Uuid::new_v4()));
        std::fs::rename(&directory, &preserved).with_context(|| {
            format!(
                "could not preserve corrupt replica at {}",
                preserved.display()
            )
        })?;
        Self::open(directory)
    }

    fn recover(directory: PathBuf) -> anyhow::Result<Self> {
        match Self::open(directory.clone()) {
            Ok(replica) => Ok(replica),
            Err(error) => {
                if !Self::is_corrupt(&error) {
                    return Err(error);
                }
                Self::rebuild(directory)
            }
        }
    }

    pub fn open(directory: PathBuf) -> anyhow::Result<Self> {
        std::fs::create_dir_all(&directory)?;
        let mut db = Connection::open(directory.join("history.sqlite3"))?;
        db.busy_timeout(std::time::Duration::from_secs(10))?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;")?;
        if Self::schema_version(&db)? != SCHEMA_VERSION {
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            if Self::schema_version(&tx)? != SCHEMA_VERSION {
                let tables: Vec<String> = tx
                    .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")?
                    .query_map([], |row| row.get(0))?
                    .collect::<Result<_, _>>()?;
                for table in tables {
                    tx.execute_batch(&format!("DROP TABLE \"{table}\";"))?;
                }
                tx.execute_batch(SCHEMA)?;
                ReadIndex::initialize(&tx)?;
                Self::put_state(&tx, "replicaId", &uuid::Uuid::new_v4().to_string())?;
                tx.execute_batch(&format!("PRAGMA user_version={SCHEMA_VERSION};"))?;
            }
            tx.commit()?;
        }
        Ok(Self { db })
    }

    fn schema_version(db: &Connection) -> anyhow::Result<i64> {
        Ok(db.query_row("PRAGMA user_version", [], |row| row.get(0))?)
    }

    pub(crate) fn state<T: DeserializeOwned>(&self, key: &str) -> anyhow::Result<Option<T>> {
        read_state(&self.db, key)
    }

    fn put_state(db: &Connection, key: &str, value: &impl Serialize) -> anyhow::Result<()> {
        db.execute(
            "INSERT INTO state VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![key, serde_json::to_string(value)?],
        )?;
        Ok(())
    }

    pub fn has_part(&self, number: u32) -> anyhow::Result<bool> {
        Ok(self
            .db
            .query_row("SELECT 1 FROM parts WHERE number=?", [number], |_| Ok(()))
            .optional()?
            .is_some())
    }

    pub fn part(&self, number: u32) -> anyhow::Result<Option<TranscriptPart>> {
        let body: Option<String> = self
            .db
            .query_row("SELECT body FROM parts WHERE number=?", [number], |row| {
                row.get(0)
            })
            .optional()?;
        body.map(|body| serde_json::from_str(&body).map_err(Into::into))
            .transpose()
    }

    pub(crate) fn generation(&self) -> anyhow::Result<i64> {
        Ok(self.state("generation")?.unwrap_or(0))
    }

    fn put_row(db: &Connection, mut value: Value, generation: i64) -> anyhow::Result<()> {
        let id = value["id"].as_str().context("row ID missing")?.to_owned();
        let sequence = value["sequence"].as_i64().context("row position missing")?;
        let kind = value["kind"]
            .as_str()
            .context("row kind missing")?
            .to_owned();
        let previous: Option<String> = db
            .query_row(
                "SELECT body FROM rows WHERE id=? AND body IS NOT NULL",
                [&id],
                |row| row.get(0),
            )
            .optional()?;
        value["revision"] = json!(0);
        if let Some(previous) = previous {
            let mut previous: Value = serde_json::from_str(&previous)?;
            previous["revision"] = json!(0);
            if previous == value {
                return Ok(());
            }
        }
        value["revision"] = json!(generation);
        db.execute("INSERT INTO rows VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET sequence=excluded.sequence, kind=excluded.kind, generation=excluded.generation, body=excluded.body",
            params![id, sequence, kind, generation, value.to_string()])?;
        Ok(())
    }

    fn delete_row(db: &Connection, id: &str, generation: i64) -> anyhow::Result<()> {
        db.execute(
            "UPDATE rows SET body=NULL, generation=? WHERE id=? AND body IS NOT NULL",
            params![generation, id],
        )?;
        Ok(())
    }

    fn rebuild_section(
        db: &Connection,
        thread_id: &str,
        key: &str,
        generation: i64,
    ) -> anyhow::Result<()> {
        let index = ReadIndex(db);
        let items = index.page(key, -1, i64::MAX, false, u32::MAX)?;
        if items.is_empty() {
            return Self::delete_row(db, key, generation);
        }
        let first = items
            .iter()
            .filter(|item| item.canonical)
            .map(|item| item.source)
            .min()
            .or_else(|| items.iter().map(|item| item.source).min())
            .context("section has no first item")?;
        let run_id = items[0].run_id.clone();
        anyhow::ensure!(
            items.iter().all(|item| item.run_id == run_id),
            "section spans runs"
        );
        let bodies: Vec<String> = db
            .prepare("SELECT body FROM parts WHERE run=? ORDER BY number")?
            .query_map([&run_id], |row| row.get(0))?
            .collect::<Result<_, _>>()?;
        let mut closed = false;
        for body in bodies {
            if closed {
                break;
            }
            let part: TranscriptPart = serde_json::from_str(&body)?;
            for range in &part.work_assignment().ranges {
                let at = WorkPosition {
                    part: part.number,
                    item: range.start,
                };
                if range.section_key != key && at > first {
                    closed = true;
                }
                if range.section_key == key
                    && part
                        .content_items()
                        .iter()
                        .skip(range.end as usize)
                        .any(|item| {
                            item["type"] == "text"
                                && item["text"]
                                    .as_str()
                                    .is_some_and(|text| !text.trim().is_empty())
                        })
                {
                    closed = true;
                }
            }
        }
        let pending_tools = items
            .iter()
            .filter(|item| item.call_id.is_some() && item.result_part.is_none())
            .count();
        // The UI reloads open details when the row revision changes, so detail-only changes must change the row.
        let row = json!({"id":key,"threadId":thread_id,"runId":run_id,"sequence":first.sequence(),"kind":"work",
            "closed":closed,"toolCounts":index.tool_counts(key)?,"unpersistedToolCallIds":index.unpersisted_tool_call_ids(key)?,
            "itemCount":items.len(),"pendingTools":pending_tools});
        Self::put_row(db, row, generation)
    }

    pub fn save_parts(&mut self, thread_id: &str, parts: &[TranscriptPart]) -> anyhow::Result<()> {
        let generation = self.generation()? + 1;
        let tx = self.db.transaction()?;
        for part in parts {
            let count = part
                .completion
                .as_ref()
                .map_or(1, |_| part.content_items().len().max(1));
            anyhow::ensure!(count <= 8192, "invalid completion item count");
            let body = serde_json::to_string(&part.without_ephemeral_urls())?;
            let previous: Option<(String, String)> = tx
                .query_row(
                    "SELECT source_key,body FROM parts WHERE number=?",
                    [part.number],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            if let Some((source, previous)) = previous {
                anyhow::ensure!(
                    source == part.source_key && previous == body,
                    "transcript source changed at part {}",
                    part.number
                );
                continue;
            }
            tx.execute(
                "INSERT INTO parts VALUES (?,?,?,?)",
                params![part.number, part.source_key, part.run_id, body],
            )?;
            ReadIndex(&tx).insert_part(part)?;
            let mut affected = ReadIndex(&tx).affected_sections(part.number)?;
            affected.extend(
                tx.prepare(
                    "SELECT DISTINCT section FROM source_refs WHERE run=? AND section IS NOT NULL",
                )?
                .query_map([&part.run_id], |row| row.get(0))?
                .collect::<Result<Vec<String>, _>>()?,
            );
            affected.sort();
            affected.dedup();
            for item in ReadIndex(&tx).approvals_for_part(part.number)? {
                if let Some((mandate_id, approval_url)) = item.approval {
                    Self::put_row(
                        &tx,
                        json!({"id":format!("approval-{}-{}",item.source.part,item.source.item),"sequence":item.source.sequence()+1,
                        "threadId":thread_id,"runId":item.run_id,"kind":"approval","mandateId":mandate_id,"approvalUrl":approval_url}),
                        generation,
                    )?;
                }
            }
            let at = WorkPosition {
                part: part.number,
                item: 0,
            };
            if let Some(prompt) = part
                .prompt
                .as_ref()
                .filter(|prompt| prompt.hidden.is_none())
            {
                Self::put_row(
                    &tx,
                    json!({"id":format!("prompt-{}",part.number),"sequence":at.sequence(),
                    "threadId":thread_id,"runId":part.run_id,"kind":"prompt","text":prompt.text,"attachments":prompt.image_uploads}),
                    generation,
                )?;
            }
            if part.completion.is_some() {
                for (offset, item) in part.content_items().iter().enumerate() {
                    if item["type"] == "text"
                        && item["text"]
                            .as_str()
                            .is_some_and(|text| !text.trim().is_empty())
                    {
                        let at = WorkPosition {
                            item: u32::try_from(offset)?,
                            ..at
                        };
                        Self::put_row(
                            &tx,
                            json!({"id":format!("text-{}-{offset}",part.number),"sequence":at.sequence(),
                            "threadId":thread_id,"runId":part.run_id,"kind":"text","text":item["text"]}),
                            generation,
                        )?;
                    }
                }
            }
            for section in affected {
                Self::rebuild_section(&tx, thread_id, &section, generation)?;
            }
        }
        let mut prefix: u32 = read_state(&tx, "downloadedPrefix")?.unwrap_or(0);
        while tx
            .query_row("SELECT 1 FROM parts WHERE number=?", [prefix], |_| Ok(()))
            .optional()?
            .is_some()
        {
            prefix += 1;
        }
        Self::put_state(&tx, "downloadedPrefix", &prefix)?;
        if let Some(local_total) = parts
            .iter()
            .filter_map(|part| part.number.checked_add(1))
            .max()
        {
            let remote_total: u32 = read_state(&tx, "total")?.unwrap_or(0);
            Self::put_state(&tx, "total", &remote_total.max(local_total))?;
        }
        Self::put_state(&tx, "generation", &generation)?;
        tx.commit()?;
        Ok(())
    }

    pub fn set_remote_total(&mut self, total: u32) -> anyhow::Result<()> {
        let known_total: u32 = self.state("total")?.unwrap_or(0);
        Self::put_state(&self.db, "total", &total.max(known_total))
    }

    pub(super) fn downloaded_prefix(&self) -> anyhow::Result<u32> {
        Ok(self.state("downloadedPrefix")?.unwrap_or(0))
    }

    pub fn page(
        &self,
        before: Option<u64>,
        limit: u32,
        change: Option<(u64, i64)>,
        streams: &[(String, String)],
        stale: bool,
    ) -> anyhow::Result<Value> {
        let generation = self.generation()?;
        let total: u32 = self.state("total")?.unwrap_or(0);
        let before = before.map(i64::try_from).transpose()?.unwrap_or(i64::MAX);
        let mut rows: Vec<Value> = self.db.prepare("SELECT body FROM rows WHERE sequence<? AND body IS NOT NULL ORDER BY sequence DESC LIMIT ?")?
            .query_map(params![before,limit+1], |row| row.get::<_,String>(0))?.map(|row| Ok(serde_json::from_str(&row?)?)).collect::<anyhow::Result<_>>()?;
        let more = rows.len() > limit as usize;
        rows.truncate(limit as usize);
        rows.reverse();
        let downloaded_prefix = self.downloaded_prefix()?;
        let first_sequence = rows.first().and_then(|row| row["sequence"].as_u64());
        let missing_older = first_sequence.is_some_and(|sequence| {
            sequence > 0 && u64::from(downloaded_prefix) * POSITION_STRIDE < sequence
        });
        let next = if more || missing_older {
            first_sequence
        } else {
            None
        };
        let mut changes = Vec::new();
        let mut change_cursor = json!({"revision":generation,"position":-1});
        let mut more_changes = false;
        if let Some((revision, position)) = change {
            let revision = i64::try_from(revision)?;
            let entries: Vec<(i64, String, i64, Option<String>)> = self.db.prepare(
                "SELECT rowid,id,generation,body FROM rows
                WHERE generation>=?1 AND (generation>?1 OR (?2>=0 AND rowid>?2)) ORDER BY generation,rowid LIMIT 65")?
                .query_map(params![revision, position], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)))?.collect::<Result<_,_>>()?;
            more_changes = entries.len() > 64;
            for (position, id, revision, body) in entries.into_iter().take(64) {
                changes.push(json!({"id":id,"row":body.map(|body| serde_json::from_str::<Value>(&body)).transpose()?}));
                if more_changes {
                    change_cursor = json!({"revision":revision,"position":position});
                }
            }
        }
        let complete = downloaded_prefix >= total;
        let mut persisted = Vec::new();
        for (run, stream) in streams {
            let source_key = format!("completion:{run}:{stream}");
            let found = self
                .db
                .query_row(
                    "SELECT 1 FROM parts WHERE source_key=?",
                    params![source_key],
                    |_| Ok(()),
                )
                .optional()?
                .is_some();
            if found {
                persisted.push(json!({"runId":run,"streamId":stream}));
            }
        }
        let indexing = rows.is_empty() && before > 0 && !complete;
        let mut result = json!({"replicaId":self.state::<String>("replicaId")?,"rows":rows,"indexing":indexing,"syncing":!complete,"stale":stale,"revision":generation,
            "persistedStreams":persisted,"changes":changes,"changesCursor":change_cursor,"moreChanges":more_changes});
        if let Some(next) = next {
            result["nextBefore"] = json!(next);
        }
        Ok(result)
    }

    pub fn details(
        &self,
        section: &str,
        after: Option<u64>,
        before: Option<u64>,
        latest: bool,
        limit: u32,
        stale: bool,
    ) -> anyhow::Result<Value> {
        let descending = before.is_some() || latest;
        let after = after.map(i64::try_from).transpose()?.unwrap_or(-1);
        let before = before.map(i64::try_from).transpose()?.unwrap_or(i64::MAX);
        let index = ReadIndex(&self.db);
        let complete = self
            .db
            .query_row(
                "SELECT 1 FROM rows WHERE id=? AND body IS NOT NULL",
                [section],
                |_| Ok(()),
            )
            .optional()?
            .is_some()
            || self.downloaded_prefix()? >= self.state::<u32>("total")?.unwrap_or(0);
        let mut items = index.page(section, after, before, descending, limit)?;
        if descending {
            items.reverse();
        }
        let mut parts = Vec::new();
        for item in &items {
            let source = self
                .part(item.source.part)?
                .context("work source not downloaded")?;
            let result = item
                .result_part
                .map(|number| self.part(number))
                .transpose()?
                .flatten();
            parts.extend(super::sections::detail(item, &source, result.as_ref()));
        }
        let mut page = json!({"parts":parts,"indexing":!complete && items.is_empty() && !stale,"stale":stale,"revision":self.generation()?});
        if let Some(first) = items.first() {
            let sequence = i64::try_from(first.source.sequence())?;
            if !index.page(section, -1, sequence, true, 1)?.is_empty() {
                page["previousBefore"] = json!(sequence);
            }
        }
        if let Some(last) = items.last() {
            let sequence = i64::try_from(last.source.sequence())?;
            if !index
                .page(section, sequence, i64::MAX, false, 1)?
                .is_empty()
            {
                page["nextAfter"] = json!(sequence);
            }
        }
        Ok(page)
    }
}

impl TranscriptStore {
    pub fn watch_work_replica_resets(&self) -> tokio::sync::broadcast::Receiver<(String, String)> {
        self.replica_resets.subscribe()
    }

    pub async fn prepare_work_replica(&self, user: &str, thread: &str) -> anyhow::Result<()> {
        let path = self.display_cache_path(user, thread, "replica")?;
        let guard = self.lock_thread(user, thread).await.lock_owned().await;
        tokio::task::spawn_blocking(move || {
            let _guard = guard;
            WorkReplica::recover(path).map(|_| ())
        })
        .await?
    }

    pub async fn with_work_replica<T: Send + 'static>(
        &self,
        user: &str,
        thread: &str,
        operation: impl FnOnce(&mut WorkReplica) -> anyhow::Result<T> + Send + 'static,
    ) -> anyhow::Result<T> {
        let path = self.display_cache_path(user, thread, "replica")?;
        let lock = self.lock_thread(user, thread).await;
        let guard = lock.lock_owned().await;
        let resets = self.replica_resets.clone();
        let scope = (user.to_owned(), thread.to_owned());
        tokio::task::spawn_blocking(move || {
            let _guard = guard;
            let result = (|| operation(&mut WorkReplica::open(path.clone())?))();
            if let Err(error) = &result {
                if WorkReplica::is_corrupt(error) {
                    WorkReplica::rebuild(path)?;
                    let _ = resets.send(scope);
                }
            }
            result
        })
        .await?
    }
}
