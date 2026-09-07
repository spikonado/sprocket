use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;

use anyhow::{Context, bail};
use convex::Value;
use serde::Deserialize;
use sprocket_workspace::{WorkspaceCancellation, WorkspaceOperationCancelled};
use tokio::io::AsyncReadExt;

use crate::convex::RuntimeClient;

const MAX_UPLOAD_BYTES: u64 = 50_000_000;
const MAX_RESULT_BYTES: usize = 16 * 1024 * 1024;

pub(super) struct HostedParseContext<'a> {
    pub runtime: &'a RuntimeClient,
    pub run_id: &'a str,
    pub claim_id: &'a str,
    pub job_id: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadRequest {
    request_id: String,
    upload_url: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "status", rename_all = "lowercase")]
enum ParseResult {
    Pending,
    Completed { url: String },
    Failed { error: String },
}

pub(super) async fn parse(
    context: &HostedParseContext<'_>,
    path: &Path,
    name_hint: &Path,
    cancellation: &WorkspaceCancellation,
) -> anyhow::Result<String> {
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err(WorkspaceOperationCancelled.into()),
        result = tokio::time::timeout(Duration::from_secs(600), parse_remote(context, path, name_hint)) => {
            result.context("hosted parsing timed out")?
        }
    }
}

async fn parse_remote(
    context: &HostedParseContext<'_>,
    path: &Path,
    name_hint: &Path,
) -> anyhow::Result<String> {
    let file = tokio::fs::File::open(path)
        .await
        .context("failed to open file for hosted parsing")?;
    let metadata = file.metadata().await?;
    anyhow::ensure!(metadata.is_file(), "hosted parsing requires a regular file");
    let size = metadata.len();
    anyhow::ensure!(
        size > 0 && size <= MAX_UPLOAD_BYTES,
        "Firecrawl accepts files up to 50 MB; attachment uploads remain unlimited"
    );
    let claim_args = BTreeMap::from([
        ("runId".into(), Value::from(context.run_id)),
        ("claimId".into(), Value::from(context.claim_id)),
    ]);
    let mut create_args = claim_args.clone();
    create_args.insert("jobId".into(), context.job_id.into());
    let request: UploadRequest = context
        .runtime
        .mutation_json("hostedParse:createUpload", create_args)
        .await?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(Duration::from_secs(30))
        .read_timeout(Duration::from_secs(60))
        .build()?;
    if let Some(upload_url) = request.upload_url {
        let body = futures::stream::try_unfold(file.take(size), |mut file| async move {
            let mut bytes = vec![0; 64 * 1024];
            let read = file.read(&mut bytes).await?;
            if read == 0 {
                return Ok::<_, std::io::Error>(None);
            }
            bytes.truncate(read);
            Ok(Some((bytes, file)))
        });
        let response = client
            .post(upload_url)
            .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
            .header(reqwest::header::CONTENT_LENGTH, size)
            .body(reqwest::Body::wrap_stream(body))
            .send()
            .await
            .map_err(reqwest::Error::without_url)
            .context("failed to upload file for hosted parsing")?
            .error_for_status()
            .map_err(reqwest::Error::without_url)
            .context("hosted parse upload rejected")?;
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct StorageUpload {
            storage_id: String,
        }
        let uploaded: StorageUpload = serde_json::from_str(&read_result(response, 4096).await?)?;
        let mut args = claim_args;
        args.insert("requestId".into(), request.request_id.clone().into());
        args.insert("storageId".into(), uploaded.storage_id.into());
        let filename = name_hint
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("document.pdf");
        args.insert("filename".into(), filename.into());
        let _: serde_json::Value = context
            .runtime
            .mutation_json("hostedParse:start", args)
            .await?;
    }
    let args = BTreeMap::from([
        ("runId".into(), Value::from(context.run_id)),
        ("requestId".into(), request.request_id.into()),
    ]);
    loop {
        let result: ParseResult = context
            .runtime
            .query_json("hostedParse:getResult", args.clone())
            .await?;
        match result {
            ParseResult::Pending => tokio::time::sleep(Duration::from_secs(1)).await,
            ParseResult::Failed { error } => bail!("Firecrawl parsing failed: {error}"),
            ParseResult::Completed { url } => {
                let response = client
                    .get(url)
                    .send()
                    .await
                    .map_err(reqwest::Error::without_url)
                    .context("failed to download parsed text")?
                    .error_for_status()
                    .map_err(reqwest::Error::without_url)
                    .context("parsed text is unavailable")?;
                return read_result(response, MAX_RESULT_BYTES).await;
            }
        }
    }
}

async fn read_result(mut response: reqwest::Response, limit: usize) -> anyhow::Result<String> {
    anyhow::ensure!(
        response
            .content_length()
            .is_none_or(|size| size <= limit as u64),
        "hosted parse response exceeds its size limit"
    );
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(reqwest::Error::without_url)?
    {
        anyhow::ensure!(
            chunk.len() <= limit.saturating_sub(bytes.len()),
            "hosted parse response exceeds its size limit"
        );
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes).context("hosted parse response is not UTF-8")
}
