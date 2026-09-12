use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CachedThreadRecord {
    #[serde(rename = "_id")]
    pub id: String,
    #[serde(rename = "_creationTime")]
    pub creation_time: f64,
    pub user_id: String,
    pub submission_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repository_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub selected_model: String,
    pub reasoning_effort: String,
    pub fast_mode: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_summary_through_run_id: Option<String>,
    pub last_message_at: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archived_at: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inbox_state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inbox_running: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_completed_at: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_run_started_at: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_pending_question: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snoozed_until: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub woke_at: Option<f64>,
}

pub struct ThreadCacheStore {
    path: PathBuf,
    lock: Mutex<()>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CachedThreads {
    pub(crate) user_id: String,
    pub(crate) threads: Vec<CachedThreadRecord>,
}

#[derive(Default, Serialize)]
pub struct CachedInboxPage {
    pub records: Vec<CachedThreadRecord>,
    pub cursor: Option<String>,
}

impl ThreadCacheStore {
    pub fn inbox_store(&self) -> Arc<Self> {
        Arc::new(Self {
            path: self.path.with_file_name("inbox"),
            lock: Mutex::new(()),
        })
    }

    fn account_path(&self, user_id: &str) -> PathBuf {
        self.path.join(cache_key(user_id))
    }

    pub async fn load_inbox(
        &self,
        user_id: &str,
        cursor: Option<&str>,
    ) -> anyhow::Result<CachedInboxPage> {
        let _guard = self.lock.lock().await;
        let mut entries = match tokio::fs::read_dir(self.account_path(user_id)).await {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(CachedInboxPage::default());
            }
            Err(error) => return Err(error.into()),
        };
        let mut files = std::collections::BTreeSet::new();
        while let Some(entry) = entries.next_entry().await? {
            if entry
                .path()
                .extension()
                .is_none_or(|extension| extension != "json")
            {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if cursor.is_none_or(|after| name.as_str() > after) {
                files.insert(name);
                if files.len() > 101 {
                    files.pop_last();
                }
            }
        }
        let has_more = files.len() > 100;
        let mut page = CachedInboxPage::default();
        for name in files.into_iter().take(100) {
            let bytes = tokio::fs::read(self.account_path(user_id).join(&name)).await?;
            if let Ok(record) = serde_json::from_slice::<CachedThreadRecord>(&bytes)
                && record.user_id == user_id
            {
                page.records.push(record);
            }
            if has_more {
                page.cursor = Some(name);
            }
        }
        Ok(page)
    }

    pub async fn merge(
        &self,
        user_id: &str,
        records: Vec<CachedThreadRecord>,
    ) -> anyhow::Result<()> {
        anyhow::ensure!(
            records.iter().all(|record| record.user_id == user_id),
            "Inbox cache account mismatch"
        );
        anyhow::ensure!(
            records.len() <= 100,
            "Inbox cache batch exceeds 100 records"
        );
        let _guard = self.lock.lock().await;
        let directory = self.account_path(user_id);
        tokio::fs::create_dir_all(&directory).await?;
        for record in records {
            let path = directory.join(format!("{}.json", cache_key(&record.id)));
            let temporary = path.with_extension("tmp");
            tokio::fs::write(&temporary, serde_json::to_vec(&record)?).await?;
            tokio::fs::rename(temporary, path).await?;
        }
        Ok(())
    }

    pub fn new(data_dir: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            path: data_dir.join("thread-cache").join("threads.json"),
            lock: Mutex::new(()),
        })
    }

    pub(crate) async fn load(&self) -> anyhow::Result<Option<CachedThreads>> {
        let _guard = self.lock.lock().await;
        if !tokio::fs::try_exists(&self.path).await? {
            return Ok(None);
        }
        let contents = tokio::fs::read_to_string(&self.path).await?;
        match serde_json::from_str::<CachedThreads>(&contents) {
            Ok(cache) => Ok(Some(cache)),
            Err(_) => {
                tokio::fs::remove_file(&self.path).await.ok();
                Ok(None)
            }
        }
    }

    pub async fn write(&self, user_id: &str, records: &[CachedThreadRecord]) -> anyhow::Result<()> {
        let _guard = self.lock.lock().await;
        let parent = self
            .path
            .parent()
            .expect("thread cache path always has a parent");
        tokio::fs::create_dir_all(parent).await?;
        let temporary = self.path.with_extension("json.tmp");
        let cache = CachedThreads {
            user_id: user_id.to_string(),
            threads: records.to_vec(),
        };
        tokio::fs::write(&temporary, serde_json::to_vec_pretty(&cache)?).await?;
        tokio::fs::rename(temporary, &self.path).await?;
        Ok(())
    }
}

fn cache_key(id: &str) -> String {
    Sha256::digest(id.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(id: &str) -> CachedThreadRecord {
        CachedThreadRecord {
            id: id.into(),
            creation_time: 1.0,
            user_id: "user-a".into(),
            submission_id: "submission-1".into(),
            status: Some("completed".into()),
            repository_key: Some("alpha".into()),
            project_id: None,
            title: Some("Thread".into()),
            selected_model: "gpt-5.6-sol".into(),
            reasoning_effort: "medium".into(),
            fast_mode: false,
            context_summary: None,
            context_summary_through_run_id: None,
            last_message_at: 10.0,
            archived_at: None,
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn atomically_replaces_a_users_records() {
        let dir =
            std::env::temp_dir().join(format!("sprocket-thread-cache-{}", uuid::Uuid::new_v4()));
        let store = ThreadCacheStore::new(dir.clone());
        store.write("user-a", &[record("thread-1")]).await.unwrap();
        assert_eq!(
            store.load().await.unwrap().unwrap().threads,
            vec![record("thread-1")]
        );

        store.write("user-a", &[record("thread-2")]).await.unwrap();
        assert_eq!(
            store.load().await.unwrap().unwrap().threads,
            vec![record("thread-2")]
        );
        let _ = tokio::fs::remove_dir_all(dir).await;
    }

    #[tokio::test]
    async fn records_the_cache_owner() {
        let dir =
            std::env::temp_dir().join(format!("sprocket-thread-cache-{}", uuid::Uuid::new_v4()));
        let store = ThreadCacheStore::new(dir.clone());
        store.write("user-a", &[record("thread-1")]).await.unwrap();

        assert_eq!(store.load().await.unwrap().unwrap().user_id, "user-a");

        let _ = tokio::fs::remove_dir_all(dir).await;
    }

    #[tokio::test]
    async fn inbox_merges_pages_without_crossing_accounts_or_dropping_history() {
        let dir = tempfile::tempdir().unwrap();
        let store = ThreadCacheStore::new(dir.path().to_path_buf()).inbox_store();
        store
            .merge("user-a", vec![record("../first")])
            .await
            .unwrap();
        store.merge("user-a", vec![record("second")]).await.unwrap();
        let mut updated = record("second");
        updated.inbox_state = Some("pinned".into());
        store.merge("user-a", vec![updated]).await.unwrap();
        let cached = store.load_inbox("user-a", None).await.unwrap().records;
        assert_eq!(cached.len(), 2);
        assert_eq!(
            cached
                .iter()
                .find(|row| row.id == "second")
                .unwrap()
                .inbox_state
                .as_deref(),
            Some("pinned")
        );
        assert!(
            store
                .load_inbox("user-b", None)
                .await
                .unwrap()
                .records
                .is_empty()
        );
        assert!(store.merge("user-b", vec![record("second")]).await.is_err());
    }

    #[tokio::test]
    async fn inbox_reads_bounded_pages_without_losing_records() {
        let dir = tempfile::tempdir().unwrap();
        let store = ThreadCacheStore::new(dir.path().to_path_buf()).inbox_store();
        for batch in 0..3 {
            store
                .merge(
                    "user-a",
                    (0..80)
                        .map(|index| record(&format!("{batch}-{index}")))
                        .collect(),
                )
                .await
                .unwrap();
        }
        let mut cursor = None;
        let mut ids = std::collections::BTreeSet::new();
        loop {
            let page = store.load_inbox("user-a", cursor.as_deref()).await.unwrap();
            assert!(page.records.len() <= 100);
            for record in page.records {
                assert!(ids.insert(record.id));
            }
            cursor = page.cursor;
            if cursor.is_none() {
                break;
            }
        }
        assert_eq!(ids.len(), 240);
    }
}
