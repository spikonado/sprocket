use std::path::PathBuf;

use anyhow::Context;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::read_index::ReadIndex;
use super::sections::{
    POSITION_STRIDE, WorkBatch, WorkEngine, WorkIndex, WorkMembership, WorkPosition, WorkSection,
};
use super::work_index::SqlWorkIndex;
use super::{TranscriptPart, TranscriptStore};

pub struct WorkReplica {
    db: Connection,
}

pub struct SectionPartition {
    pub after: String,
    pub before: Option<String>,
    pub sections: Vec<WorkSection>,
}

pub struct WorkSnapshot {
    pub through: WorkPosition,
    pub total: u32,
    pub complete: bool,
    pub active_run_id: Option<String>,
    pub sections: Vec<SectionPartition>,
    pub memberships: Vec<WorkMembership>,
    pub membership_pages: Vec<u32>,
}

impl WorkReplica {
    fn recover(directory: PathBuf) -> anyhow::Result<Self> {
        match Self::open(directory.clone()) {
            Ok(replica) => Ok(replica),
            Err(error) => {
                let corrupt = matches!(error.downcast_ref::<rusqlite::Error>(),
                    Some(rusqlite::Error::SqliteFailure(failure,_)) if matches!(failure.code,
                        rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase));
                if !corrupt {
                    return Err(error);
                }
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
            CREATE TABLE IF NOT EXISTS memberships (number INTEGER PRIMARY KEY, processed INTEGER NOT NULL, body TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS memberships_section ON memberships(json_extract(body,'$.sectionKey'));
            CREATE TABLE IF NOT EXISTS membership_refresh (start INTEGER PRIMARY KEY);
            CREATE TABLE IF NOT EXISTS sections (key TEXT PRIMARY KEY, body TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS coverage (start INTEGER PRIMARY KEY, end INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS rows (id TEXT PRIMARY KEY, sequence INTEGER NOT NULL UNIQUE, part INTEGER NOT NULL, offset INTEGER NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS changes (id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, generation INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS changes_generation_sequence ON changes(generation, sequence);
            INSERT OR IGNORE INTO state VALUES ('generation', '0');"
        )?;
        SqlWorkIndex::initialize(&db)?;
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

    pub fn through(&self) -> anyhow::Result<WorkPosition> {
        Ok(self.state("through")?.unwrap_or_default())
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

    fn touch_row(db: &Connection, id: &str, generation: i64) -> anyhow::Result<()> {
        db.execute(
            "UPDATE rows SET body=json_set(body,'$.revision',?) WHERE id=?",
            params![generation, id],
        )?;
        db.execute("INSERT INTO changes SELECT id,sequence,? FROM rows WHERE id=? ON CONFLICT(id) DO UPDATE SET generation=excluded.generation",params![generation,id])?;
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

    pub fn save_parts(&mut self, thread_id: &str, parts: &[TranscriptPart]) -> anyhow::Result<()> {
        let generation = self.generation()? + 1;
        let tx = self.db.transaction()?;
        for part in parts {
            let count = part
                .completion
                .as_ref()
                .map_or(1, |completion| completion.items.len().max(1));
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
            for section in ReadIndex(&tx).affected_sections(part.number)? {
                Self::touch_row(&tx, &section, generation)?;
            }
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
            if let Some(completion) = &part.completion {
                for (offset, item) in completion.items.iter().enumerate() {
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
        }
        Self::put_state(&tx, "generation", &generation)?;
        tx.commit()?;
        Ok(())
    }

    pub fn save_snapshot(&mut self, thread_id: &str, snapshot: WorkSnapshot) -> anyhow::Result<()> {
        let generation = self.generation()? + 1;
        let previous: WorkPosition = self.state("cloudThrough")?.unwrap_or_default();
        anyhow::ensure!(
            snapshot.through >= previous,
            "remote work checkpoint regressed"
        );
        let tx = self.db.transaction()?;
        if snapshot.through > previous {
            let end = snapshot.through.part + u32::from(snapshot.through.item > 0);
            for start in ((previous.part / 8 * 8)..end).step_by(8) {
                tx.execute(
                    "INSERT OR IGNORE INTO membership_refresh VALUES (?)",
                    [start],
                )?;
            }
        }
        for partition in snapshot.sections {
            let keys: Vec<String> = tx
                .prepare("SELECT key FROM sections WHERE key>? AND (? IS NULL OR key<=?)")?
                .query_map(
                    params![partition.after, partition.before, partition.before],
                    |row| row.get(0),
                )?
                .collect::<Result<_, _>>()?;
            for key in keys {
                if partition.sections.iter().any(|section| section.key == key) {
                    continue;
                }
                tx.execute("INSERT OR IGNORE INTO membership_refresh SELECT number/8*8 FROM memberships WHERE json_extract(body,'$.sectionKey')=?", [&key])?;
                tx.execute("DELETE FROM sections WHERE key=?", [&key])?;
                tx.execute("INSERT INTO changes SELECT id,sequence,? FROM rows WHERE id=? ON CONFLICT(id) DO UPDATE SET generation=excluded.generation", params![generation,key])?;
                tx.execute("DELETE FROM rows WHERE id=?", [&key])?;
            }
            for section in partition.sections {
                tx.execute("INSERT INTO sections VALUES (?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body", params![section.key,serde_json::to_string(&section)?])?;
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
                Self::put_row(&tx, row, section.first, generation)?;
            }
        }
        for membership in snapshot.memberships {
            tx.execute("INSERT INTO memberships VALUES (?,?,?) ON CONFLICT(number) DO UPDATE SET processed=excluded.processed,body=excluded.body",
                params![membership.number,membership.processed,serde_json::to_string(&membership)?])?;
            ReadIndex(&tx).link(&membership)?;
            for section in ReadIndex(&tx).affected_sections(membership.number)? {
                Self::touch_row(&tx, &section, generation)?;
            }
            tx.execute("INSERT INTO changes SELECT id,sequence,? FROM rows WHERE part=? ON CONFLICT(id) DO UPDATE SET generation=excluded.generation",
                params![generation,membership.number])?;
        }
        for start in snapshot.membership_pages {
            tx.execute("DELETE FROM membership_refresh WHERE start=?", [start])?;
        }
        Self::put_state(&tx, "cloudThrough", &snapshot.through)?;
        Self::put_state(&tx, "total", &snapshot.total)?;
        Self::put_state(&tx, "metadataComplete", &snapshot.complete)?;
        Self::put_state(&tx, "activeRun", &snapshot.active_run_id)?;
        Self::put_state(&tx, "generation", &generation)?;
        tx.commit()?;
        Ok(())
    }

    pub fn pending_membership_pages(&self, limit: u32) -> anyhow::Result<Vec<u32>> {
        Ok(self
            .db
            .prepare("SELECT start FROM membership_refresh ORDER BY start DESC LIMIT ?")?
            .query_map([limit], |row| row.get(0))?
            .collect::<Result<_, _>>()?)
    }

    pub fn pending_batch(&self) -> anyhow::Result<Option<WorkBatch>> {
        self.state("pendingBatch")
    }

    pub fn run_synced(&self, run: &str) -> anyhow::Result<bool> {
        if !self.state::<bool>("metadataComplete")?.unwrap_or(false)
            || self
                .state::<Option<String>>("activeRun")?
                .flatten()
                .as_deref()
                == Some(run)
            || self.pending_batch()?.is_some()
            || self.through()?.part != self.state::<u32>("total")?.unwrap_or(0)
        {
            return Ok(false);
        }
        let unsettled = self
            .db
            .query_row(
                "SELECT 1 FROM work_sections WHERE settled=0 AND run=? LIMIT 1",
                [run],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        let unpublished = self.db.query_row("SELECT 1 FROM sections WHERE json_extract(body,'$.runId')=? AND (json_extract(body,'$.closed')=0 OR json_extract(body,'$.pendingTools')>0) LIMIT 1", [run], |_| Ok(())).optional()?.is_some();
        Ok(!unsettled && !unpublished)
    }

    pub fn acknowledge_batch(&mut self, through: WorkPosition) -> anyhow::Result<()> {
        let pending = self.pending_batch()?.context("work batch missing")?;
        anyhow::ensure!(pending.through == through, "work acknowledgment mismatch");
        self.db
            .execute("DELETE FROM state WHERE key='pendingBatch'", [])?;
        Ok(())
    }

    pub fn advance(&mut self, remote_through: WorkPosition) -> anyhow::Result<Option<WorkBatch>> {
        if let Some(batch) = self.pending_batch()? {
            return Ok(Some(batch));
        }
        let mut engine: WorkEngine = self.state("engine")?.unwrap_or_default();
        let Some(part) = self.part(engine.through.part)? else {
            return Ok(None);
        };
        let limit = if engine.through.part == remote_through.part
            && engine.through.item < remote_through.item
        {
            (remote_through.item - engine.through.item) as usize
        } else {
            engine.batch_limit(&part)
        };
        let tx = self.db.transaction()?;
        let batch = engine.advance(&SqlWorkIndex(&tx), &part, limit)?;
        Self::put_state(&tx, "engine", &engine)?;
        Self::put_state(&tx, "through", &batch.through)?;
        Self::put_state(&tx, "pendingBatch", &batch)?;
        tx.commit()?;
        Ok(Some(batch))
    }

    pub fn finish_inactive(
        &mut self,
        active_run: Option<&str>,
        through: WorkPosition,
    ) -> anyhow::Result<Option<WorkBatch>> {
        if let Some(batch) = self.pending_batch()? {
            return Ok(Some(batch));
        }
        if self.through()? != through {
            return Ok(None);
        }
        let run: Option<String> = self.db.query_row(
            "SELECT run FROM work_sections WHERE settled=0 AND (? IS NULL OR run<>?) ORDER BY run,key LIMIT 1",
            params![active_run,active_run], |row| row.get(0)).optional()?;
        let Some(run) = run else {
            return Ok(None);
        };
        let tx = self.db.transaction()?;
        let keys: Vec<String> = tx
            .prepare(
                "SELECT key FROM work_sections WHERE settled=0 AND run=? ORDER BY key LIMIT 4",
            )?
            .query_map([&run], |row| row.get(0))?
            .collect::<Result<_, _>>()?;
        let index = SqlWorkIndex(&tx);
        let mut sections = Vec::new();
        for key in keys {
            let mut section = index.section(&key)?.context("work section missing")?;
            section.closed = true;
            if section.pending_tools > 0 {
                section.completed_at = None;
            }
            section.pending_tools = 0;
            index.save_section(&section)?;
            tx.execute("UPDATE work_sections SET settled=1 WHERE key=?", [&key])?;
            sections.push(section);
        }
        let batch = WorkBatch {
            expected: through,
            through,
            sections,
            removed: Vec::new(),
            memberships: Vec::new(),
            finished_run_id: Some(run),
        };
        Self::put_state(&tx, "pendingBatch", &batch)?;
        tx.commit()?;
        Ok(Some(batch))
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
        let ready = "(r.kind='work' OR EXISTS (SELECT 1 FROM memberships m WHERE m.number=r.part AND m.processed>r.offset))";
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
        let complete = self.state::<bool>("metadataComplete")?.unwrap_or(false);
        let through: WorkPosition = self.state("cloudThrough")?.unwrap_or_default();
        let mut persisted = Vec::new();
        if complete {
            for (run, stream) in streams {
                let source_key = format!("completion:{run}:{stream}");
                let found = self.db.query_row("SELECT 1 FROM parts p JOIN memberships m USING(number) WHERE p.source_key=? AND p.number<? AND m.processed=p.item_count",
                    params![source_key,through.part], |_| Ok(())).optional()?.is_some();
                if found {
                    persisted.push(json!({"runId":run,"streamId":stream}));
                }
            }
        }
        let indexing = !complete
            || (rows.is_empty()
                && before > 0
                && (downloaded_prefix < total || through.part < total));
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
            None => self.state::<bool>("metadataComplete")?.unwrap_or(false),
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
            parts.extend(WorkEngine::detail(item, &source, result.as_ref()));
        }
        let mut page = json!({"parts":parts,"indexing":!complete && items.is_empty(),"stale":stale,"revision":self.generation()?});
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
        tokio::task::spawn_blocking(move || {
            let _guard = guard;
            operation(&mut WorkReplica::open(path)?)
        })
        .await?
    }
}
