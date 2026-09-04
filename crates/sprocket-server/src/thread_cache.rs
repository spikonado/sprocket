use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
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
    root: PathBuf,
    lock: Mutex<()>,
}

impl ThreadCacheStore {
    pub fn new(data_dir: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            root: data_dir.join("thread-cache"),
            lock: Mutex::new(()),
        })
    }

    fn path(&self, user_id: &str) -> PathBuf {
        self.root.join(format!("{}.json", cache_key(user_id)))
    }

    pub async fn load(&self, user_id: &str) -> anyhow::Result<Vec<CachedThreadRecord>> {
        let _guard = self.lock.lock().await;
        let path = self.path(user_id);
        if !tokio::fs::try_exists(&path).await? {
            return Ok(Vec::new());
        }
        let contents = tokio::fs::read_to_string(&path).await?;
        match serde_json::from_str(&contents) {
            Ok(records) => Ok(records),
            Err(_) => {
                tokio::fs::remove_file(path).await.ok();
                Ok(Vec::new())
            }
        }
    }

    pub async fn write(&self, user_id: &str, records: &[CachedThreadRecord]) -> anyhow::Result<()> {
        let _guard = self.lock.lock().await;
        tokio::fs::create_dir_all(&self.root).await?;
        let path = self.path(user_id);
        let temporary = path.with_extension("json.tmp");
        tokio::fs::write(&temporary, serde_json::to_vec_pretty(records)?).await?;
        tokio::fs::rename(temporary, path).await?;
        Ok(())
    }
}

fn cache_key(value: &str) -> String {
    Sha256::digest(value.as_bytes())
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
            store.load("user-a").await.unwrap(),
            vec![record("thread-1")]
        );
        assert!(store.load("user-b").await.unwrap().is_empty());

        store.write("user-a", &[record("thread-2")]).await.unwrap();
        assert_eq!(
            store.load("user-a").await.unwrap(),
            vec![record("thread-2")]
        );
        let _ = tokio::fs::remove_dir_all(dir).await;
    }
}
