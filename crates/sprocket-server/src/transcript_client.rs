use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, anyhow};
use convex::{FunctionResult, QuerySubscription, Value};
use sprocket_agent::{
    RemoteTranscriptState, TranscriptPart, TranscriptStore, fetch_missing_parts, parse_remote_parts,
};
use sprocket_convex::{AuthTokenFetcher, Client as ConvexClient};
use tokio::time::sleep;

#[derive(Clone)]
pub struct UserConvexClient {
    client: ConvexClient,
}

impl UserConvexClient {
    pub async fn connect(deployment_url: &str, auth_token: String) -> anyhow::Result<Self> {
        let client = ConvexClient::new(deployment_url).await?;
        let fetcher = static_token_fetcher(auth_token);
        client.set_auth_token_fetcher(fetcher).await;
        Ok(Self { client })
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

    pub async fn attachment_download(
        &self,
        image_upload_id: &str,
    ) -> anyhow::Result<Option<RemoteAttachmentDownload>> {
        let mut args = BTreeMap::new();
        args.insert(
            "imageUploadId".to_string(),
            image_upload_id.to_string().into(),
        );
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
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAttachmentDownload {
    pub name: String,
    pub media_type: String,
    pub storage_id: String,
    pub url: String,
}

fn static_token_fetcher(token: String) -> AuthTokenFetcher {
    Arc::new(move |_force_refresh| {
        let token = token.clone();
        Box::pin(async move {
            if token.trim().is_empty() {
                return Err(anyhow!("transcript auth token is empty"));
            }
            Ok(token)
        })
    })
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
    let mut builder = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(60));
    if let Some(host) = reqwest::Url::parse(url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(str::to_owned))
    {
        builder = builder.retry(reqwest::retry::for_host(host).classify_fn(|req_rep| {
            if *req_rep.method() != reqwest::Method::GET {
                return req_rep.success();
            }
            match req_rep.status().map(|status| status.as_u16()) {
                Some(429 | 502 | 503 | 504) => req_rep.retryable(),
                _ => req_rep.success(),
            }
        }));
    }
    let client = builder
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
