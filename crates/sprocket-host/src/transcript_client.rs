use std::collections::BTreeMap;
use std::time::Duration;

use anyhow::Context;
use convex::Value;
use serde::Deserialize;
use sprocket_convex::{
    AuthTokenFetcher, Client as ConvexClient, Subscription, decode_labeled_function_result,
};
use tokio::time::sleep;

pub const THREAD_NOT_FOUND: &str = "Thread not found.";
pub(crate) const ARTIFACT_BINDING_BATCH_SIZE: usize = 8;

#[derive(Clone)]
pub struct UserConvexClient {
    client: ConvexClient,
}

impl UserConvexClient {
    pub async fn subscribe(
        &self,
        function: &str,
        args: BTreeMap<String, Value>,
    ) -> anyhow::Result<Subscription> {
        self.client.subscribe(function, args).await
    }

    pub async fn transcript_parts_page(
        &self,
        thread_id: &str,
        start: u32,
        end: u32,
    ) -> anyhow::Result<Vec<sprocket_transcript::TranscriptPart>> {
        let mut args = thread_id_args(thread_id);
        args.insert("start".into(), Value::Float64(f64::from(start)));
        args.insert("end".into(), Value::Float64(f64::from(end)));
        args.insert("order".into(), "desc".to_owned().into());
        let page: Option<serde_json::Value> =
            self.query_json("transcript:getPartsPage", args).await?;
        sprocket_transcript::parse_remote_page(page.context(THREAD_NOT_FOUND)?, thread_id)
    }

    pub async fn transcript_total_parts(&self, thread_id: &str) -> anyhow::Result<u32> {
        let state: Option<sprocket_transcript::RemoteTranscriptState> = self
            .query("transcript:getState", thread_id_args(thread_id))
            .await?;
        Ok(state.context(THREAD_NOT_FOUND)?.total_parts)
    }

    pub(crate) async fn connect_with_fetcher(
        deployment_url: &str,
        fetcher: AuthTokenFetcher,
    ) -> anyhow::Result<Self> {
        let client = ConvexClient::new(deployment_url).await?;
        client.set_auth_token_fetcher(fetcher).await?;
        Ok(Self { client })
    }

    pub(crate) async fn is_closed(&self) -> bool {
        self.client.is_closed().await
    }

    pub(crate) fn into_rpc_client(self) -> ConvexClient {
        self.client
    }

    pub async fn subscribe_artifact_state(
        &self,
        repository_key: &str,
    ) -> anyhow::Result<Subscription> {
        self.client
            .subscribe(
                "artifacts:getArtifactState",
                artifacts_list_args(repository_key),
            )
            .await
    }

    pub async fn list_artifacts(&self, repository_key: &str) -> anyhow::Result<ArtifactSnapshot> {
        let mut args = artifacts_list_args(repository_key);
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
                return Ok(ArtifactSnapshot {
                    artifacts,
                    revision: page.revision,
                });
            }
            let cursor = Value::String(page.continue_cursor);
            if args.get("cursor") == Some(&cursor) {
                anyhow::bail!("Artifact page cursor did not advance");
            }
            args.insert("cursor".to_string(), cursor);
        }
    }

    pub(crate) async fn subscribe_artifact_bindings(
        &self,
        artifact_ids: &[String],
    ) -> anyhow::Result<Subscription> {
        self.subscribe("artifactBindings:getState", artifact_ids_args(artifact_ids))
            .await
    }

    pub(crate) async fn list_artifacts_with_bindings(
        &self,
        repository_key: &str,
        artifact_ids: &[String],
    ) -> anyhow::Result<ArtifactSnapshot> {
        let mut snapshot = self.list_artifacts(repository_key).await?;
        // Project pages may predate a bound artifact's transfer or deletion.
        snapshot
            .artifacts
            .retain(|artifact| !artifact_ids.contains(&artifact.id));
        for batch in artifact_ids.chunks(ARTIFACT_BINDING_BATCH_SIZE) {
            let artifacts: Vec<crate::artifact_watch::RemoteArtifact> = tokio::time::timeout(
                Duration::from_secs(10),
                self.query("artifactBindings:getArtifacts", artifact_ids_args(batch)),
            )
            .await??;
            snapshot.artifacts.extend(artifacts);
        }
        Ok(snapshot)
    }

    pub async fn sync_artifact(
        &self,
        artifact_id: &str,
        repository_key: &str,
        expected_revision: u64,
        content: &str,
    ) -> anyhow::Result<bool> {
        let mut args = artifacts_list_args(repository_key);
        args.insert("artifactId".to_string(), artifact_id.to_string().into());
        args.insert(
            "expectedRevision".to_string(),
            Value::Float64(expected_revision as f64),
        );
        args.insert("content".to_string(), content.to_string().into());
        self.mutation_json("artifacts:syncArtifact", args).await
    }

    pub async fn file_download(&self, file_id: &str) -> anyhow::Result<Option<FileDownload>> {
        let mut args = BTreeMap::new();
        args.insert("fileId".to_string(), file_id.to_string().into());
        self.mutation_json("files:downloadUrl", args).await
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

    pub async fn act<T: for<'de> serde::Deserialize<'de>>(
        &self,
        function: &str,
        args: BTreeMap<String, Value>,
    ) -> anyhow::Result<T> {
        decode_labeled_function_result(self.client.action(function, args).await?, function)
    }
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDownload {
    pub name: String,
    pub media_type: String,
    pub url: String,
    #[serde(deserialize_with = "sprocket_convex::deserialize_convex_u64")]
    pub size: u64,
}

pub(crate) fn thread_id_args(thread_id: &str) -> BTreeMap<String, Value> {
    let mut args = BTreeMap::new();
    args.insert("threadId".to_string(), thread_id.to_string().into());
    args
}

pub struct ArtifactSnapshot {
    pub artifacts: Vec<crate::artifact_watch::RemoteArtifact>,
    pub revision: u64,
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

fn artifacts_list_args(repository_key: &str) -> BTreeMap<String, Value> {
    let mut args = BTreeMap::new();
    args.insert(
        "repositoryKey".to_string(),
        repository_key.to_string().into(),
    );
    args
}

fn artifact_ids_args(artifact_ids: &[String]) -> BTreeMap<String, Value> {
    BTreeMap::from([(
        "artifactIds".into(),
        Value::Array(artifact_ids.iter().cloned().map(Value::String).collect()),
    )])
}

pub async fn retry_after_failure() {
    sleep(Duration::from_secs(2)).await;
}
