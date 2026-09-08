use std::collections::BTreeMap;
use std::time::Duration;

use convex::{FunctionResult, QuerySubscription, Value};
use serde::Deserialize;
use sprocket_agent::{
    RemoteTranscriptState, TranscriptPart, TranscriptStore, fetch_missing_parts, parse_remote_parts,
};
use sprocket_convex::{AuthTokenFetcher, Client as ConvexClient, decode_labeled_function_result};
use tokio::time::sleep;

#[derive(Clone)]
pub struct UserConvexClient {
    client: ConvexClient,
}

impl UserConvexClient {
    pub async fn connect_with_fetcher(
        deployment_url: &str,
        fetcher: AuthTokenFetcher,
    ) -> anyhow::Result<Self> {
        let client = ConvexClient::new(deployment_url).await?;
        client.set_auth_token_fetcher(fetcher).await;
        Ok(Self { client })
    }

    pub async fn connect_anonymous(deployment_url: &str) -> anyhow::Result<Self> {
        Ok(Self {
            client: ConvexClient::new(deployment_url).await?,
        })
    }

    pub async fn ensure_migrated(&self, thread_id: &str) -> anyhow::Result<RemoteTranscriptState> {
        self.mutation_json("transcript:ensureMigrated", thread_id_args(thread_id))
            .await
    }

    pub async fn transcript_parts(
        &self,
        thread_id: &str,
        numbers: &[u32],
    ) -> anyhow::Result<Vec<TranscriptPart>> {
        let mut args = thread_id_args(thread_id);
        args.insert(
            "numbers".to_string(),
            Value::Array(
                numbers
                    .iter()
                    .map(|number| Value::Float64(*number as f64))
                    .collect(),
            ),
        );
        let value: serde_json::Value = self.query_json("transcript:getParts", args).await?;
        parse_remote_parts(value)
    }

    pub async fn subscribe_state(&self, thread_id: &str) -> anyhow::Result<QuerySubscription> {
        self.client
            .subscribe("transcript:getState", thread_id_args(thread_id))
            .await
    }

    pub async fn subscribe_recent_threads(
        &self,
        selected_thread_id: Option<&str>,
    ) -> anyhow::Result<QuerySubscription> {
        let mut args = BTreeMap::new();
        if let Some(thread_id) = selected_thread_id {
            args.insert("selectedThreadId".to_string(), thread_id.to_string().into());
        }
        self.client.subscribe("threads:listRecent", args).await
    }

    pub async fn subscribe_artifacts(
        &self,
        repository_key: &str,
        thread_id: Option<&str>,
    ) -> anyhow::Result<QuerySubscription> {
        self.client
            .subscribe(
                "artifacts:getArtifactState",
                artifacts_list_args(repository_key, thread_id),
            )
            .await
    }

    pub(crate) async fn list_artifacts(
        &self,
        repository_key: &str,
        thread_id: Option<&str>,
    ) -> anyhow::Result<Vec<crate::artifact_watch::RemoteArtifact>> {
        let mut args = artifacts_list_args(repository_key, thread_id);
        let mut artifacts = Vec::new();
        let mut revision = None;
        loop {
            let page: ArtifactPage = tokio::time::timeout(
                Duration::from_secs(10),
                self.query("artifacts:listArtifacts", args.clone()),
            )
            .await
            .map_err(|_| anyhow::anyhow!("artifact page timed out"))??;
            if revision.is_some_and(|revision| revision != page.revision) {
                anyhow::bail!("Artifact registry changed during paging; retrying.");
            }
            revision = Some(page.revision);
            artifacts.extend(page.page);
            if page.is_done {
                return Ok(artifacts);
            }
            let cursor = Value::String(page.continue_cursor);
            if args.get("cursor") == Some(&cursor) {
                anyhow::bail!("Artifact page cursor did not advance");
            }
            args.insert("cursor".to_string(), cursor);
        }
    }

    pub async fn sync_artifact(
        &self,
        artifact_id: &str,
        repository_key: &str,
        thread_id: Option<&str>,
        expected_revision: u64,
        local_path: &str,
        content: &str,
    ) -> anyhow::Result<bool> {
        let mut args = artifacts_list_args(repository_key, thread_id);
        args.insert("artifactId".to_string(), artifact_id.to_string().into());
        args.insert(
            "expectedRevision".to_string(),
            Value::Float64(expected_revision as f64),
        );
        args.insert("localPath".to_string(), local_path.to_string().into());
        args.insert("content".to_string(), content.to_string().into());
        self.mutation_json("artifacts:syncArtifact", args).await
    }

    pub async fn attachment_download_by_storage_id(
        &self,
        storage_id: &str,
    ) -> anyhow::Result<Option<RemoteAttachmentDownload>> {
        let mut args = BTreeMap::new();
        args.insert("storageId".to_string(), storage_id.to_string().into());
        self.query_json("transcript:attachmentDownloadByStorageId", args)
            .await
    }

    async fn query_json<T: for<'de> serde::Deserialize<'de>>(
        &self,
        function: &str,
        args: BTreeMap<String, Value>,
    ) -> anyhow::Result<T> {
        decode_labeled_function_result(self.client.query(function, args).await?, function)
    }

    async fn mutation_json<T: for<'de> serde::Deserialize<'de>>(
        &self,
        function: &str,
        args: BTreeMap<String, Value>,
    ) -> anyhow::Result<T> {
        decode_labeled_function_result(self.client.mutation(function, args).await?, function)
    }

    pub async fn mutate<T: for<'de> serde::Deserialize<'de>>(
        &self,
        function: &str,
        args: BTreeMap<String, Value>,
    ) -> anyhow::Result<T> {
        self.mutation_json(function, args).await
    }

    pub async fn query<T: for<'de> serde::Deserialize<'de>>(
        &self,
        function: &str,
        args: BTreeMap<String, Value>,
    ) -> anyhow::Result<T> {
        self.query_json(function, args).await
    }
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAttachmentDownload {
    pub name: String,
    pub media_type: String,
    pub storage_id: String,
    pub url: String,
    #[serde(deserialize_with = "sprocket_convex::deserialize_convex_u64")]
    pub size: u64,
}

fn thread_id_args(thread_id: &str) -> BTreeMap<String, Value> {
    let mut args = BTreeMap::new();
    args.insert("threadId".to_string(), thread_id.to_string().into());
    args
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactPage {
    page: Vec<crate::artifact_watch::RemoteArtifact>,
    is_done: bool,
    continue_cursor: String,
    #[serde(deserialize_with = "sprocket_convex::deserialize_convex_u64")]
    revision: u64,
}

fn artifacts_list_args(repository_key: &str, thread_id: Option<&str>) -> BTreeMap<String, Value> {
    let mut args = BTreeMap::new();
    args.insert(
        "repositoryKey".to_string(),
        repository_key.to_string().into(),
    );
    if let Some(thread_id) = thread_id {
        args.insert("threadId".to_string(), thread_id.to_string().into());
    }
    args
}

pub fn decode_thread_records_update(
    result: FunctionResult,
) -> anyhow::Result<Vec<crate::thread_cache::CachedThreadRecord>> {
    decode_labeled_function_result(result, "threads:listRecent")
}

pub fn decode_state_update(result: FunctionResult) -> anyhow::Result<RemoteTranscriptState> {
    decode_labeled_function_result(result, "transcript:getState")
}

pub async fn sync_range(
    store: &TranscriptStore,
    client: &UserConvexClient,
    user_id: &str,
    thread_id: &str,
    start: u32,
    end_exclusive: u32,
) -> anyhow::Result<()> {
    fetch_missing_parts(store, user_id, thread_id, start, end_exclusive, |numbers| {
        let client = client.clone();
        let thread_id = thread_id.to_string();
        async move { client.transcript_parts(&thread_id, &numbers).await }
    })
    .await?;
    Ok(())
}

pub async fn retry_after_failure() {
    sleep(Duration::from_secs(2)).await;
}
