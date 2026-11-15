use std::collections::BTreeSet;
use std::ops::Range;
use std::path::PathBuf;

use anyhow::Context;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::json;

use super::read_index::ReadIndex;
use super::sections::WorkPosition;
use super::{TranscriptPart, TranscriptStore};

const SCHEMA_VERSION: i64 = 4;
const SCHEMA: &str = "CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE parts (number INTEGER PRIMARY KEY, source_key TEXT NOT NULL UNIQUE, run TEXT NOT NULL, body TEXT NOT NULL);
    CREATE INDEX parts_run_number ON parts(run, number);
    CREATE TABLE rows (id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL);
    CREATE INDEX rows_sequence ON rows(sequence);
    INSERT INTO state VALUES ('generation', '0');";

fn save_monitor_text(
    db: &Connection,
    part: &TranscriptPart,
    offset: u32,
    kind: &str,
    text: &str,
) -> anyhow::Result<()> {
    let id = if kind == "prompt" {
        format!("prompt-{}", part.number)
    } else {
        format!("text-{}-{offset}", part.number)
    };
    db.execute(
        "INSERT INTO rows VALUES (?,?,?,?)",
        params![
            id,
            i64::try_from(
                WorkPosition {
                    part: part.number,
                    item: offset
                }
                .sequence()
            )?,
            kind,
            json!({"text": text, "runId": part.run_id}).to_string()
        ],
    )?;
    Ok(())
}

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
            Err(error) if Self::is_corrupt(&error) => Self::rebuild(directory),
            Err(error) => Err(error),
        }
    }

    pub fn open(directory: PathBuf) -> anyhow::Result<Self> {
        std::fs::create_dir_all(&directory)?;
        let mut db = Connection::open(directory.join("history.sqlite3"))?;
        db.busy_timeout(std::time::Duration::from_secs(10))?;
        db.pragma_update_and_check(None, "journal_mode", "WAL", |_| Ok(()))?;
        db.pragma_update(None, "synchronous", "FULL")?;
        if Self::schema_version(&db)? != SCHEMA_VERSION {
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            if Self::schema_version(&tx)? != SCHEMA_VERSION {
                let tables: Vec<String> = tx
                    .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")?
                    .query_map([], |row| row.get(0))?.collect::<Result<_, _>>()?;
                for table in tables {
                    tx.execute_batch(&format!("DROP TABLE \"{table}\";"))?;
                }
                tx.execute_batch(SCHEMA)?;
                ReadIndex::initialize(&tx)?;
                Self::put_state(&tx, "replicaId", &uuid::Uuid::new_v4().to_string())?;
                tx.pragma_update(None, "user_version", SCHEMA_VERSION)?;
            }
            tx.commit()?;
        }
        Ok(Self { db })
    }

    fn schema_version(db: &Connection) -> anyhow::Result<i64> {
        Ok(db.pragma_query_value(None, "user_version", |row| row.get(0))?)
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

    pub fn parts_range(&self, start: u32, end: u32) -> anyhow::Result<Vec<TranscriptPart>> {
        let bodies: Vec<String> = self
            .db
            .prepare("SELECT body FROM parts WHERE number>=? AND number<? ORDER BY number")?
            .query_map(params![start, end], |row| row.get(0))?
            .collect::<Result<_, _>>()?;
        bodies
            .into_iter()
            .map(|body| serde_json::from_str(&body).map_err(Into::into))
            .collect()
    }

    pub fn run_range(&self, run: &str) -> anyhow::Result<Option<Range<u32>>> {
        let (start, end): (Option<u32>, Option<u32>) = self.db.query_row(
            "SELECT MIN(number), MAX(number) FROM parts WHERE run=?",
            [run],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        Ok(start
            .zip(end)
            .map(|(start, end)| start..end.saturating_add(1)))
    }

    pub(crate) fn generation(&self) -> anyhow::Result<i64> {
        Ok(self.state("generation")?.unwrap_or(0))
    }

    pub fn save_parts(&mut self, _thread_id: &str, parts: &[TranscriptPart]) -> anyhow::Result<()> {
        let generation = self.generation()? + 1;
        let tx = self.db.transaction()?;
        let mut changed_runs = BTreeSet::new();
        for part in parts {
            let part = part.without_ephemeral_urls();
            anyhow::ensure!(
                part.content_items().len() <= 8192,
                "invalid completion item count"
            );
            let body = serde_json::to_string(&part)?;
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
            if let Some(prompt) = &part.prompt
                && prompt.hidden.is_none()
            {
                save_monitor_text(&tx, &part, 0, "prompt", &prompt.text)?;
            }
            for (offset, item) in part.content_items().iter().enumerate() {
                if item["type"] == "text"
                    && let Some(text) = item["text"].as_str()
                    && !text.trim().is_empty()
                {
                    save_monitor_text(&tx, &part, u32::try_from(offset)?, "text", text)?;
                }
            }
            changed_runs.insert(part.run_id);
        }
        for run in changed_runs {
            let bodies: Vec<String> = tx
                .prepare("SELECT body FROM parts WHERE run=? ORDER BY number")?
                .query_map([&run], |row| row.get(0))?
                .collect::<Result<_, _>>()?;
            let parts: Vec<TranscriptPart> = bodies
                .iter()
                .map(|body| serde_json::from_str(body))
                .collect::<Result<_, _>>()?;
            ReadIndex(&tx).rebuild_run(&parts)?;
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
}

impl TranscriptStore {
    pub async fn read_parts_range(
        &self,
        user: &str,
        thread: &str,
        start: u32,
        end: u32,
    ) -> anyhow::Result<Vec<TranscriptPart>> {
        self.with_work_replica(user, thread, move |replica| replica.parts_range(start, end))
            .await
    }

    pub async fn read_run_range(
        &self,
        user: &str,
        thread: &str,
        run: &str,
    ) -> anyhow::Result<Option<Range<u32>>> {
        let run = run.to_owned();
        self.with_work_replica(user, thread, move |replica| replica.run_range(&run))
            .await
    }

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
        let guard = self.lock_thread(user, thread).await.lock_owned().await;
        let resets = self.replica_resets.clone();
        let scope = (user.to_owned(), thread.to_owned());
        tokio::task::spawn_blocking(move || {
            let _guard = guard;
            let result = (|| operation(&mut WorkReplica::open(path.clone())?))();
            if let Err(error) = &result
                && WorkReplica::is_corrupt(error)
            {
                WorkReplica::rebuild(path)?;
                let _ = resets.send(scope);
            }
            result
        })
        .await?
    }
}
