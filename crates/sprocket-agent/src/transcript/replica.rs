use std::path::PathBuf;

use anyhow::Context;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::read_index::ReadIndex;
use super::sections::{POSITION_STRIDE, WorkItem, WorkPosition, WorkSection};
use super::{TranscriptPart, TranscriptStore};

pub struct WorkReplica {
    db: Connection,
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
        let db = Connection::open(directory.join("history.sqlite3"))?;
        db.busy_timeout(std::time::Duration::from_secs(10))?;
        db.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS parts (number INTEGER PRIMARY KEY, source_key TEXT NOT NULL UNIQUE, item_count INTEGER NOT NULL, body TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS sections (key TEXT PRIMARY KEY, body TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS coverage (start INTEGER PRIMARY KEY, end INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS rows (id TEXT PRIMARY KEY, sequence INTEGER NOT NULL UNIQUE, part INTEGER NOT NULL, offset INTEGER NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS changes (id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, generation INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS changes_generation_sequence ON changes(generation, sequence);
            INSERT OR IGNORE INTO state VALUES ('generation', '0');"
        )?;
        ReadIndex::initialize(&db)?;
        db.execute(
            "INSERT OR IGNORE INTO state VALUES ('replicaId',?)",
            [serde_json::to_string(&uuid::Uuid::new_v4().to_string())?],
        )?;
        Ok(Self { db })
    }

    fn state<T: for<'de> Deserialize<'de>>(&self, key: &str) -> anyhow::Result<Option<T>> {
        let value: Option<String> = self
            .db
            .query_row("SELECT value FROM state WHERE key=?", [key], |row| {
                row.get(0)
            })
            .optional()?;
        value
            .map(|value| serde_json::from_str(&value).map_err(Into::into))
            .transpose()
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

    fn generation(&self) -> anyhow::Result<i64> {
        Ok(self.state("generation")?.unwrap_or(0))
    }

    fn put_row(
        db: &Connection,
        mut value: Value,
        at: WorkPosition,
        generation: i64,
    ) -> anyhow::Result<()> {
        let id = value["id"].as_str().context("row ID missing")?.to_owned();
        let sequence = value["sequence"].as_i64().context("row position missing")?;
        let previous: Option<String> = db
            .query_row("SELECT body FROM rows WHERE id=?", [&id], |row| row.get(0))
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
        db.execute("INSERT INTO rows VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET sequence=excluded.sequence, part=excluded.part, offset=excluded.offset, kind=excluded.kind, body=excluded.body",
            params![id,sequence,at.part,at.item,value["kind"].as_str(),value.to_string()])?;
        db.execute("INSERT INTO changes VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET sequence=excluded.sequence, generation=excluded.generation", params![id,sequence,generation])?;
        Ok(())
    }

    fn record_download(db: &Connection, number: u32) -> anyhow::Result<()> {
        let number = i64::from(number);
        let (start, end): (i64, i64) = db.query_row(
            "SELECT MIN(start),MAX(end) FROM (
            SELECT start,end FROM coverage WHERE start<=? AND end>=? UNION ALL SELECT ?,?)",
            params![number + 1, number - 1, number, number],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        db.execute(
            "DELETE FROM coverage WHERE start>=? AND start<=?",
            params![start, end],
        )?;
        db.execute("INSERT INTO coverage VALUES (?,?)", params![start, end])?;
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
            db.execute("DELETE FROM sections WHERE key=?", [key])?;
            db.execute("DELETE FROM rows WHERE id=?", [key])?;
            return Ok(());
        }
        let canonical = items.iter().filter(|item| item.canonical);
        let first = canonical
            .clone()
            .map(|item| item.source)
            .min()
            .or_else(|| items.iter().map(|item| item.source).min())
            .context("section has no first item")?;
        let last = canonical
            .map(|item| item.source)
            .max()
            .or_else(|| items.iter().map(|item| item.source).max())
            .context("section has no last item")?;
        let run_id = items[0].run_id.clone();
        anyhow::ensure!(
            items.iter().all(|item| item.run_id == run_id),
            "section spans runs"
        );
        let pending_tools = items
            .iter()
            .filter(|item| item.call_id.is_some() && (item.result_part.is_none() || item.running))
            .count() as u32;
        let started_at = items
            .iter()
            .filter_map(|item| item.started_at)
            .min_by(f64::total_cmp);
        let completed_at = (pending_tools == 0)
            .then(|| {
                items
                    .iter()
                    .filter_map(WorkItem::known_completion)
                    .max_by(f64::total_cmp)
            })
            .flatten();
        let mut closed = false;
        let mut statement = db.prepare(
            "SELECT body FROM parts WHERE json_extract(body,'$.runId')=? ORDER BY number",
        )?;
        let bodies: Vec<String> = statement
            .query_map([&run_id], |row| row.get(0))?
            .collect::<Result<_, _>>()?;
        for body in bodies {
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
        let section = WorkSection {
            key: key.to_owned(),
            run_id,
            first,
            end: WorkPosition {
                part: last.part,
                item: last.item.saturating_add(1),
            },
            closed,
            provisional: false,
            item_count: u32::try_from(items.len())?,
            pending_tools,
            started_at,
            completed_at,
        };
        db.execute(
            "INSERT INTO sections VALUES (?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body",
            params![key, serde_json::to_string(&section)?],
        )?;
        let mut row = serde_json::to_value(&section)?;
        row["id"] = json!(section.key);
        row["threadId"] = json!(thread_id);
        row["sequence"] = json!(section.first.sequence());
        row["kind"] = json!("work");
        if let Some(object) = row.as_object_mut() {
            object.remove("key");
            object.remove("first");
            object.remove("end");
        }
        Self::put_row(db, row, section.first, generation)
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
                params![part.number, part.source_key, u32::try_from(count)?, body],
            )?;
            Self::record_download(&tx, part.number)?;
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
                        "threadId":thread_id,"runId":item.run_id,"kind":"approval","mandateId":mandate_id,"approvalUrl":approval_url,
                        "itemCount":0,"pendingTools":0,"closed":true}),
                        item.source,
                        generation,
                    )?;
                }
            }
            let at = WorkPosition {
                part: part.number,
                item: 0,
            };
            if let Some(prompt) = &part.prompt {
                Self::put_row(
                    &tx,
                    json!({"id":format!("prompt-{}",part.number),"sequence":at.sequence(),
                    "threadId":thread_id,"runId":part.run_id,"kind":"prompt","text":prompt.text,"attachments":prompt.image_uploads,
                    "itemCount":0,"pendingTools":0,"closed":true}),
                    at,
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
                        let mut row = json!({"id":format!("text-{}-{offset}",part.number),"sequence":at.sequence(),
                            "threadId":thread_id,"runId":part.run_id,"kind":"text","text":item["text"],"itemCount":0,"pendingTools":0,"closed":true});
                        if let Some(start) = super::sections::timing(item, "startedAt") {
                            row["startedAt"] = json!(start);
                        }
                        Self::put_row(&tx, row, at, generation)?;
                    }
                }
            }
            for section in affected {
                Self::rebuild_section(&tx, thread_id, &section, generation)?;
            }
        }
        if let Some(local_total) = parts
            .iter()
            .filter_map(|part| part.number.checked_add(1))
            .max()
        {
            let remote_total: u32 = tx
                .query_row("SELECT value FROM state WHERE key='total'", [], |row| {
                    row.get(0)
                })
                .optional()?
                .and_then(|value: String| value.parse().ok())
                .unwrap_or(0);
            Self::put_state(&tx, "total", &remote_total.max(local_total))?;
        }
        Self::put_state(&tx, "generation", &generation)?;
        tx.commit()?;
        Ok(())
    }

    pub fn set_remote_total(&mut self, total: u32) -> anyhow::Result<()> {
        Self::put_state(&self.db, "total", &total)
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
        let end = i64::from(total) * i64::try_from(POSITION_STRIDE)?;
        let before = before.map(i64::try_from).transpose()?.unwrap_or(end);
        let ready = "1=1";
        let mut rows: Vec<Value> = self.db.prepare(&format!("SELECT r.body FROM rows r WHERE r.sequence<? AND {ready} ORDER BY r.sequence DESC LIMIT ?"))?
            .query_map(params![before,limit+1], |row| row.get::<_,String>(0))?.map(|row| Ok(serde_json::from_str(&row?)?)).collect::<anyhow::Result<_>>()?;
        let more = rows.len() > limit as usize;
        rows.truncate(limit as usize);
        rows.reverse();
        let downloaded_prefix: u32 = self
            .db
            .query_row("SELECT end+1 FROM coverage WHERE start=0", [], |row| {
                row.get(0)
            })
            .optional()?
            .unwrap_or(0);
        let ready_prefix = downloaded_prefix;
        let first_sequence = rows.first().and_then(|row| row["sequence"].as_u64());
        let missing_older = first_sequence.is_some_and(|sequence| {
            sequence > 0 && u64::from(ready_prefix) * POSITION_STRIDE < sequence
        });
        let next = if more || missing_older {
            first_sequence
        } else {
            None
        };
        let mut changes = Vec::new();
        let mut change_cursor = json!({"revision":generation,"sequence":-1});
        let mut more_changes = false;
        if let Some((revision, sequence)) = change {
            let revision = i64::try_from(revision)?;
            let entries: Vec<(String,i64,i64,Option<String>)> = self.db.prepare(&format!(
                "SELECT c.id,c.sequence,c.generation,CASE WHEN {ready} THEN r.body END FROM changes c LEFT JOIN rows r ON r.id=c.id
                WHERE c.generation>? OR (? >= 0 AND c.generation=? AND c.sequence>?) ORDER BY c.generation,c.sequence LIMIT 65"))?
                .query_map(params![revision,sequence,revision,sequence], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)))?.collect::<Result<_,_>>()?;
            more_changes = entries.len() > 64;
            for (id, sequence, revision, body) in entries.into_iter().take(64) {
                changes.push(json!({"id":id,"row":body.map(|body| serde_json::from_str::<Value>(&body)).transpose()?}));
                if more_changes {
                    change_cursor = json!({"revision":revision,"sequence":sequence});
                }
            }
        }
        let complete = downloaded_prefix >= total;
        let mut persisted = Vec::new();
        if complete {
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
        }
        let handoff_pending = persisted.len() < streams.len() && !complete;
        let indexing = handoff_pending
            || (!stale && !complete)
            || (rows.is_empty()
                && before > 0
                && (!complete
                    || i64::from(ready_prefix) * i64::try_from(POSITION_STRIDE)? < before));
        let mut result = json!({"replicaId":self.state::<String>("replicaId")?,"rows":rows,"indexing":indexing,"stale":stale,"endSequence":end,"revision":generation,
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
        let body: Option<String> = self
            .db
            .query_row("SELECT body FROM sections WHERE key=?", [section], |row| {
                row.get(0)
            })
            .optional()?;
        let row: Option<WorkSection> = body.map(|body| serde_json::from_str(&body)).transpose()?;
        let descending = before.is_some() || latest;
        let after = after.map(i64::try_from).transpose()?.unwrap_or(-1);
        let before = before.map(i64::try_from).transpose()?.unwrap_or(i64::MAX);
        let index = ReadIndex(&self.db);
        let complete = match &row {
            Some(row) => index.item_count(section)? == row.item_count,
            None => self
                .db
                .query_row(
                    "SELECT end+1>=? FROM coverage WHERE start=0",
                    [self.state::<u32>("total")?.unwrap_or(0)],
                    |row| row.get(0),
                )
                .optional()?
                .unwrap_or(false),
        };
        let mut items = index.page(section, after, before, descending, limit)?;
        if descending {
            items.reverse();
        }
        let mut parts = Vec::new();
        for item in &mut items {
            if row
                .as_ref()
                .is_some_and(|row| row.closed && row.pending_tools == 0)
            {
                item.running = false;
            }
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
            if !index.page(section, -1, sequence, true, 1)?.is_empty()
                || !complete
                    && row
                        .as_ref()
                        .is_some_and(|row| row.first.sequence() < first.source.sequence())
            {
                page["previousBefore"] = json!(sequence);
            }
        }
        if let Some(last) = items.last() {
            let sequence = i64::try_from(last.source.sequence())?;
            if !index
                .page(section, sequence, i64::MAX, false, 1)?
                .is_empty()
                || !complete
                    && row
                        .as_ref()
                        .is_some_and(|row| row.end.sequence() > last.source.sequence() + 2)
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
