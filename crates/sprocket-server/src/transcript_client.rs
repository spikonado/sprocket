use std::collections::BTreeMap;
use std::time::Duration;

use anyhow::{Context, anyhow};
use convex::{FunctionResult, QuerySubscription, Value};
use sprocket_agent::{
    RemoteTranscriptState, TranscriptPart, TranscriptStore, fetch_missing_parts, parse_remote_parts,
};
use sprocket_convex::{Client as ConvexClient, SessionCredentialProvider, session_proof_value};
use tokio::time::sleep;

use crate::convex_auth::ConvexTokenProvider;

#[derive(Clone)]
pub struct UserConvexClient {
    client: ConvexClient,
    session_credential: Option<SessionCredentialProvider>,
}

impl UserConvexClient {
    pub async fn connect(
        deployment_url: &str,
        auth_token: String,
        tokens: ConvexTokenProvider,
        session_credential: Option<SessionCredentialProvider>,
    ) -> anyhow::Result<Self> {
        let client = ConvexClient::new(deployment_url).await?;
        // Keep the JWT fetcher even when a session credential is present so
        // an expired on-disk ticket can still fall back to a live access token.
        tokens.update(auth_token.clone()).await;
        client
            .set_auth_token_fetcher(tokens.fetcher_for_token("transcript", &auth_token))
            .await;
        Ok(Self {
            client,
            session_credential,
        })
    }

    pub async fn ensure_migrated(&self, thread_id: &str) -> anyhow::Result<RemoteTranscriptState> {
        let mut args = thread_id_args(thread_id);
        self.add_session_ticket(&mut args).await;
        self.mutation_json("transcript:ensureMigrated", args).await
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
        self.add_session_ticket(&mut args).await;
        let value: serde_json::Value = self.query_json("transcript:getParts", args).await?;
        parse_remote_parts(value)
    }

    pub async fn subscribe_state(&self, thread_id: &str) -> anyhow::Result<QuerySubscription> {
        let mut args = thread_id_args(thread_id);
        self.add_session_ticket(&mut args).await;
        self.client.subscribe("transcript:getState", args).await
    }

    pub async fn attachment_download(
        &self,
        image_upload_id: &str,
    ) -> anyhow::Result<Option<RemoteAttachmentDownload>> {
        let mut args = BTreeMap::new();
        args.insert(
            "imageUploadId".to_string(),
            image_upload_id.to_string().into(),
        );
        self.add_session_ticket(&mut args).await;
        self.query_json("transcript:attachmentDownload", args).await
    }

    async fn query_json<T: for<'de> serde::Deserialize<'de>>(
        &self,
        function: &str,
        args: BTreeMap<String, Value>,
    ) -> anyhow::Result<T> {
        decode_function_result(self.client.query(function, args).await?, function)
    }

    async fn mutation_json<T: for<'de> serde::Deserialize<'de>>(
        &self,
        function: &str,
        args: BTreeMap<String, Value>,
    ) -> anyhow::Result<T> {
        decode_function_result(self.client.mutation(function, args).await?, function)
    }

    async fn add_session_ticket(&self, args: &mut BTreeMap<String, Value>) {
        if let Some(session) = &self.session_credential {
            args.insert(
                "sessionTicket".to_string(),
                session_proof_value(&session.current_ticket().await),
            );
        }
    }
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAttachmentDownload {
    pub name: String,
    pub media_type: String,
    pub storage_id: String,
    pub url: String,
}

fn thread_id_args(thread_id: &str) -> BTreeMap<String, Value> {
    let mut args = BTreeMap::new();
    args.insert("threadId".to_string(), thread_id.to_string().into());
    args
}

pub fn decode_state_update(result: FunctionResult) -> anyhow::Result<RemoteTranscriptState> {
    decode_function_result(result, "transcript:getState")
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

pub async fn download_attachment_bytes(url: &str) -> anyhow::Result<Vec<u8>> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(60))
        .build()
        .context("failed to build attachment HTTP client")?;
    let response = client
        .get(url)
        .send()
        .await
        .context("attachment download")?;
    if !response.status().is_success() {
        anyhow::bail!(
            "attachment download failed with status {}",
            response.status()
        );
    }
    Ok(response.bytes().await?.to_vec())
}

pub async fn retry_after_failure() {
    sleep(Duration::from_secs(2)).await;
}

fn decode_function_result<T: for<'de> serde::Deserialize<'de>>(
    result: FunctionResult,
    function: &str,
) -> anyhow::Result<T> {
    match result {
        FunctionResult::Value(value) => {
            let json_value = convex_value_to_plain_json(value);
            serde_json::from_value(json_value.clone()).with_context(|| {
                format!("failed to decode response from {function}; payload: {json_value}")
            })
        }
        FunctionResult::ErrorMessage(message) => Err(anyhow!("{function}: {message}")),
        FunctionResult::ConvexError(error) => Err(anyhow!("{function}: {}", error.message)),
    }
}

fn convex_value_to_plain_json(value: Value) -> serde_json::Value {
    match value {
        Value::Null => serde_json::Value::Null,
        Value::Int64(number) => serde_json::json!(number),
        Value::Float64(number) => serde_json::json!(number),
        Value::Boolean(boolean) => serde_json::json!(boolean),
        Value::String(text) => serde_json::json!(text),
        Value::Bytes(bytes) => serde_json::json!(bytes),
        Value::Array(values) => serde_json::Value::Array(
            values
                .into_iter()
                .map(convex_value_to_plain_json)
                .collect::<Vec<_>>(),
        ),
        Value::Object(fields) => serde_json::Value::Object(
            fields
                .into_iter()
                .map(|(key, value)| (key, convex_value_to_plain_json(value)))
                .collect(),
        ),
    }
}
