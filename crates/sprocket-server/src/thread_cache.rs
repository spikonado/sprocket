use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

pub const THREAD_SNAPSHOT_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum ThreadSnapshotCategory {
    Active,
    Archived,
}

impl ThreadSnapshotCategory {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Archived => "archived",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CachedThreadSummary {
    pub thread_id: String,
    pub repository_key: String,
    pub title: String,
    pub selected_model: String,
    pub reasoning_effort: String,
    pub service_tier: String,
    pub last_message_at: f64,
    pub thread_status: String,
    #[serde(default, deserialize_with = "deserialize_null_default")]
    pub latest_run_status: Option<String>,
    #[serde(default, deserialize_with = "deserialize_null_default")]
    pub latest_run_id: Option<String>,
    #[serde(default)]
    pub latest_run_started_at: Option<f64>,
    #[serde(default)]
    pub latest_run_claim_expires_at: Option<f64>,
    pub has_active_run: bool,
}

fn deserialize_null_default<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Ok(Option::<T>::deserialize(deserializer)?)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSnapshotFile {
    pub version: u32,
    pub user_id: String,
    pub repository_key: String,
    pub category: ThreadSnapshotCategory,
    pub revision: u64,
    pub synced_at: u64,
    pub threads: Vec<CachedThreadSummary>,
}

pub struct ThreadSnapshotStore {
    root: PathBuf,
    locks: Mutex<std::collections::HashMap<String, Arc<Mutex<()>>>>,
}

impl ThreadSnapshotStore {
    pub fn new(data_dir: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            root: data_dir.join("thread-cache"),
            locks: Mutex::new(std::collections::HashMap::new()),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn snapshot_dir(&self, user_id: &str, repository_key: &str) -> PathBuf {
        self.root
            .join(safe_segment(user_id))
            .join(safe_segment(repository_key))
    }

    fn snapshot_path(
        &self,
        user_id: &str,
        repository_key: &str,
        category: ThreadSnapshotCategory,
    ) -> PathBuf {
        self.snapshot_dir(user_id, repository_key)
            .join(format!("{}.json", category.as_str()))
    }

    async fn lock(
        &self,
        user_id: &str,
        repository_key: &str,
        category: ThreadSnapshotCategory,
    ) -> Arc<Mutex<()>> {
        let key = format!("{user_id}/{repository_key}/{}", category.as_str());
        let mut locks = self.locks.lock().await;
        locks
            .entry(key)
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    pub async fn load(
        &self,
        user_id: &str,
        repository_key: &str,
        category: ThreadSnapshotCategory,
    ) -> anyhow::Result<Option<ThreadSnapshotFile>> {
        let lock = self.lock(user_id, repository_key, category).await;
        let _guard = lock.lock().await;
        self.load_unlocked(user_id, repository_key, category).await
    }

    async fn load_unlocked(
        &self,
        user_id: &str,
        repository_key: &str,
        category: ThreadSnapshotCategory,
    ) -> anyhow::Result<Option<ThreadSnapshotFile>> {
        let path = self.snapshot_path(user_id, repository_key, category);
        if !tokio::fs::try_exists(&path).await? {
            return Ok(None);
        }
        let contents = match tokio::fs::read_to_string(&path).await {
            Ok(contents) => contents,
            Err(_) => {
                self.reset_unlocked(user_id, repository_key, category)
                    .await?;
                return Ok(None);
            }
        };
        match parse_snapshot(&contents, user_id, repository_key, category) {
            Ok(snapshot) => Ok(Some(snapshot)),
            Err(_) => {
                self.reset_unlocked(user_id, repository_key, category)
                    .await?;
                Ok(None)
            }
        }
    }

    pub async fn write(&self, snapshot: &ThreadSnapshotFile) -> anyhow::Result<()> {
        let lock = self
            .lock(
                &snapshot.user_id,
                &snapshot.repository_key,
                snapshot.category,
            )
            .await;
        let _guard = lock.lock().await;
        if self
            .load_unlocked(
                &snapshot.user_id,
                &snapshot.repository_key,
                snapshot.category,
            )
            .await?
            .is_some_and(|current| current.revision > snapshot.revision)
        {
            return Ok(());
        }
        let dir = self.snapshot_dir(&snapshot.user_id, &snapshot.repository_key);
        tokio::fs::create_dir_all(&dir).await?;
        let path = self.snapshot_path(
            &snapshot.user_id,
            &snapshot.repository_key,
            snapshot.category,
        );
        let tmp = path.with_extension("json.tmp");
        let payload = serde_json::to_vec_pretty(snapshot)?;
        tokio::fs::write(&tmp, payload).await?;
        tokio::fs::rename(&tmp, &path).await?;
        Ok(())
    }

    pub async fn reset_repository(
        &self,
        user_id: &str,
        repository_key: &str,
    ) -> anyhow::Result<()> {
        for category in [
            ThreadSnapshotCategory::Active,
            ThreadSnapshotCategory::Archived,
        ] {
            let lock = self.lock(user_id, repository_key, category).await;
            let _guard = lock.lock().await;
            self.reset_unlocked(user_id, repository_key, category)
                .await?;
        }
        Ok(())
    }

    async fn reset_unlocked(
        &self,
        user_id: &str,
        repository_key: &str,
        category: ThreadSnapshotCategory,
    ) -> anyhow::Result<()> {
        let path = self.snapshot_path(user_id, repository_key, category);
        if tokio::fs::try_exists(&path).await? {
            tokio::fs::remove_file(&path).await.ok();
        }
        let tmp = path.with_extension("json.tmp");
        if tokio::fs::try_exists(&tmp).await? {
            tokio::fs::remove_file(&tmp).await.ok();
        }
        Ok(())
    }

    pub async fn list_user_threads(
        &self,
        user_id: &str,
    ) -> anyhow::Result<Vec<CachedThreadSummary>> {
        let mut threads = Vec::new();
        for snapshot in self.load_user_snapshots(user_id).await? {
            threads.extend(snapshot.threads);
        }
        threads.sort_by(|left, right| {
            right
                .last_message_at
                .partial_cmp(&left.last_message_at)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        Ok(threads)
    }

    pub async fn latest_synced_at(&self, user_id: &str) -> anyhow::Result<Option<u64>> {
        let mut latest = None;
        for snapshot in self.load_user_snapshots(user_id).await? {
            if latest.is_none_or(|current| snapshot.synced_at > current) {
                latest = Some(snapshot.synced_at);
            }
        }
        Ok(latest)
    }

    async fn load_user_snapshots(&self, user_id: &str) -> anyhow::Result<Vec<ThreadSnapshotFile>> {
        let mut snapshots = Vec::new();
        let user_dir = self.root.join(safe_segment(user_id));
        if !tokio::fs::try_exists(&user_dir).await? {
            return Ok(snapshots);
        }
        let mut repos = tokio::fs::read_dir(&user_dir).await?;
        while let Some(entry) = repos.next_entry().await? {
            if !entry.file_type().await?.is_dir() {
                continue;
            }
            let mut files = tokio::fs::read_dir(entry.path()).await?;
            while let Some(file) = files.next_entry().await? {
                let path = file.path();
                if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                    continue;
                }
                let contents = match tokio::fs::read_to_string(&path).await {
                    Ok(contents) => contents,
                    Err(_) => continue,
                };
                match serde_json::from_str::<ThreadSnapshotFile>(&contents) {
                    Ok(snapshot)
                        if snapshot.version == THREAD_SNAPSHOT_VERSION
                            && snapshot.user_id == user_id =>
                    {
                        snapshots.push(snapshot);
                    }
                    Ok(_) | Err(_) => {
                        tokio::fs::remove_file(&path).await.ok();
                    }
                }
            }
        }
        Ok(snapshots)
    }

    pub async fn contains_token(&self, token: &str) -> anyhow::Result<bool> {
        contains_token_in_dir(&self.root, token).await
    }
}

fn parse_snapshot(
    contents: &str,
    user_id: &str,
    repository_key: &str,
    category: ThreadSnapshotCategory,
) -> anyhow::Result<ThreadSnapshotFile> {
    let snapshot: ThreadSnapshotFile = serde_json::from_str(contents)?;
    if snapshot.version != THREAD_SNAPSHOT_VERSION
        || snapshot.user_id != user_id
        || snapshot.repository_key != repository_key
        || snapshot.category != category
    {
        anyhow::bail!("thread snapshot identity mismatch");
    }
    Ok(snapshot)
}

pub fn safe_segment(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if matches!(ch, '/' | '\\' | ':' | '.') {
                '_'
            } else {
                ch
            }
        })
        .collect()
}

fn contains_token_in_dir<'a>(
    dir: &'a Path,
    token: &'a str,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = anyhow::Result<bool>> + Send + 'a>> {
    Box::pin(async move {
        if !tokio::fs::try_exists(dir).await? {
            return Ok(false);
        }
        let mut entries = tokio::fs::read_dir(dir).await?;
        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            if entry.file_type().await?.is_dir() {
                if contains_token_in_dir(&path, token).await? {
                    return Ok(true);
                }
                continue;
            }
            let contents = tokio::fs::read_to_string(&path).await.unwrap_or_default();
            if contents.contains(token) {
                return Ok(true);
            }
        }
        Ok(false)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_thread(thread_id: &str, repository_key: &str) -> CachedThreadSummary {
        CachedThreadSummary {
            thread_id: thread_id.to_string(),
            repository_key: repository_key.to_string(),
            title: "Thread".to_string(),
            selected_model: "gpt-5.6-sol".to_string(),
            reasoning_effort: "medium".to_string(),
            service_tier: "standard".to_string(),
            last_message_at: 10.0,
            thread_status: "active".to_string(),
            latest_run_status: None,
            latest_run_id: None,
            latest_run_started_at: None,
            latest_run_claim_expires_at: None,
            has_active_run: false,
        }
    }

    #[tokio::test]
    async fn writes_are_atomic_and_isolated_by_user() {
        let dir =
            std::env::temp_dir().join(format!("sprocket-thread-cache-{}", uuid::Uuid::new_v4()));
        let store = ThreadSnapshotStore::new(dir.clone());
        let snapshot = ThreadSnapshotFile {
            version: THREAD_SNAPSHOT_VERSION,
            user_id: "user-a".into(),
            repository_key: "github.com/spikonado/sprocket".into(),
            category: ThreadSnapshotCategory::Active,
            revision: 3,
            synced_at: 9,
            threads: vec![sample_thread("thread-1", "github.com/spikonado/sprocket")],
        };
        store.write(&snapshot).await.expect("write");
        let loaded = store
            .load(
                "user-a",
                "github.com/spikonado/sprocket",
                ThreadSnapshotCategory::Active,
            )
            .await
            .expect("load")
            .expect("snapshot");
        assert_eq!(loaded, snapshot);
        assert!(
            store
                .load(
                    "user-b",
                    "github.com/spikonado/sprocket",
                    ThreadSnapshotCategory::Active,
                )
                .await
                .expect("other user")
                .is_none()
        );
        let listed = store.list_user_threads("user-a").await.expect("list");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].repository_key, "github.com/spikonado/sprocket");
        assert!(
            !store
                .contains_token("browser-bootstrap-token")
                .await
                .expect("token scan")
        );
        let _ = tokio::fs::remove_dir_all(dir).await;
    }

    #[tokio::test]
    async fn malformed_snapshots_reset_silently() {
        let dir = std::env::temp_dir().join(format!(
            "sprocket-thread-cache-bad-{}",
            uuid::Uuid::new_v4()
        ));
        let store = ThreadSnapshotStore::new(dir.clone());
        let path = store.snapshot_path("user-a", "alpha", ThreadSnapshotCategory::Active);
        tokio::fs::create_dir_all(path.parent().expect("parent"))
            .await
            .expect("dir");
        tokio::fs::write(&path, "{not-json")
            .await
            .expect("write garbage");
        assert!(
            store
                .load("user-a", "alpha", ThreadSnapshotCategory::Active)
                .await
                .expect("load")
                .is_none()
        );
        assert!(!tokio::fs::try_exists(&path).await.expect("exists"));
        let _ = tokio::fs::remove_dir_all(dir).await;
    }

    #[tokio::test]
    async fn active_and_archived_are_separate_files() {
        let dir = std::env::temp_dir().join(format!(
            "sprocket-thread-cache-cats-{}",
            uuid::Uuid::new_v4()
        ));
        let store = ThreadSnapshotStore::new(dir.clone());
        let active = ThreadSnapshotFile {
            version: THREAD_SNAPSHOT_VERSION,
            user_id: "user-a".into(),
            repository_key: "alpha".into(),
            category: ThreadSnapshotCategory::Active,
            revision: 1,
            synced_at: 1,
            threads: vec![sample_thread("active-1", "alpha")],
        };
        let mut archived_thread = sample_thread("archived-1", "alpha");
        archived_thread.thread_status = "archived".into();
        let archived = ThreadSnapshotFile {
            version: THREAD_SNAPSHOT_VERSION,
            user_id: "user-a".into(),
            repository_key: "alpha".into(),
            category: ThreadSnapshotCategory::Archived,
            revision: 1,
            synced_at: 2,
            threads: vec![archived_thread],
        };
        store.write(&active).await.expect("active");
        store.write(&archived).await.expect("archived");
        let listed = store.list_user_threads("user-a").await.expect("list");
        assert_eq!(listed.len(), 2);
        let _ = tokio::fs::remove_dir_all(dir).await;
    }

    #[tokio::test]
    async fn older_download_does_not_replace_newer_snapshot() {
        let dir = std::env::temp_dir().join(format!(
            "sprocket-thread-cache-revision-{}",
            uuid::Uuid::new_v4()
        ));
        let store = ThreadSnapshotStore::new(dir.clone());
        let mut newer = ThreadSnapshotFile {
            version: THREAD_SNAPSHOT_VERSION,
            user_id: "user-a".into(),
            repository_key: "alpha".into(),
            category: ThreadSnapshotCategory::Active,
            revision: 2,
            synced_at: 2,
            threads: vec![sample_thread("newer", "alpha")],
        };
        store.write(&newer).await.expect("newer write");
        newer.revision = 1;
        newer.synced_at = 3;
        newer.threads = vec![sample_thread("older", "alpha")];
        store.write(&newer).await.expect("older write ignored");

        let loaded = store
            .load("user-a", "alpha", ThreadSnapshotCategory::Active)
            .await
            .expect("load")
            .expect("snapshot");
        assert_eq!(loaded.revision, 2);
        assert_eq!(loaded.threads[0].thread_id, "newer");
        let _ = tokio::fs::remove_dir_all(dir).await;
    }

    #[tokio::test]
    async fn resetting_a_repository_removes_all_categories() {
        let dir = std::env::temp_dir().join(format!(
            "sprocket-thread-cache-reset-{}",
            uuid::Uuid::new_v4()
        ));
        let store = ThreadSnapshotStore::new(dir.clone());
        for category in [
            ThreadSnapshotCategory::Active,
            ThreadSnapshotCategory::Archived,
        ] {
            store
                .write(&ThreadSnapshotFile {
                    version: THREAD_SNAPSHOT_VERSION,
                    user_id: "user-a".into(),
                    repository_key: "alpha".into(),
                    category,
                    revision: 1,
                    synced_at: 1,
                    threads: vec![sample_thread("thread-1", "alpha")],
                })
                .await
                .expect("write");
        }

        store
            .reset_repository("user-a", "alpha")
            .await
            .expect("reset");

        assert!(
            store
                .list_user_threads("user-a")
                .await
                .expect("list")
                .is_empty()
        );
        let _ = tokio::fs::remove_dir_all(dir).await;
    }
}
