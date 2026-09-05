use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
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
    pub service_tier: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_summary_through_run_id: Option<String>,
    pub last_message_at: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archived_at: Option<f64>,
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

impl ThreadCacheStore {
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
        let cache = CachedThreads {
            user_id: user_id.to_string(),
            threads: records.to_vec(),
        };
        crate::write_atomic(&self.path, &serde_json::to_vec_pretty(&cache)?).await
    }
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
            service_tier: "standard".into(),
            context_summary: None,
            context_summary_through_run_id: None,
            last_message_at: 10.0,
            archived_at: None,
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
}
