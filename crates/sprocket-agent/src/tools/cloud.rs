use std::path::Path;
use std::time::Duration;

use anyhow::Context;
use base64::Engine;
use serde::Deserialize;
use sprocket_workspace::{WorkspaceCancellation, WorkspaceOperationCancelled};
use tokio::io::AsyncReadExt;

use crate::convex::RuntimeClient;

const MAX_UPLOAD_BYTES: u64 = 50_000_000;
const MAX_PARSE_RESPONSE_BYTES: usize = 32 * 1024 * 1024;
/// Fits a 64 MiB page, or a 50 MB document in base64, with the rest of context.dev's response.
const MAX_SCRAPE_RESPONSE_BYTES: usize = 100 * 1024 * 1024;
const MAX_ERROR_BYTES: usize = 16 * 1024;
const PARSE_TIMEOUT: Duration = Duration::from_secs(600);
const SCRAPE_TIMEOUT: Duration = Duration::from_secs(510);

/// A claimed tool job that Convex HTTP actions run against Firecrawl and context.dev.
pub(super) struct CloudJob<'a> {
    pub runtime: &'a RuntimeClient,
    pub run_id: &'a str,
    pub claim_id: &'a str,
    pub job_id: &'a str,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ParsedPage {
    pub page_number: u32,
    pub markdown: String,
}

#[derive(Deserialize)]
struct ParseResponse {
    data: ParsedDocument,
}

#[derive(Deserialize)]
struct ParsedDocument {
    markdown: Option<String>,
    pages: Option<Vec<ParsedPage>>,
    metadata: Option<ParseMetadata>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ParseMetadata {
    num_pages: Option<u64>,
    total_pages: Option<u64>,
}

#[derive(Deserialize)]
struct ScrapeResponse {
    url: Option<String>,
    markdown: Option<ScrapeOutput<String>>,
    bytes: Option<ScrapeOutput<ScrapedBytes>>,
}

#[derive(Deserialize)]
struct ScrapeOutput<T> {
    success: Option<bool>,
    data: Option<T>,
    error_code: Option<String>,
    message: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScrapedBytes {
    base64: String,
    content_type: Option<String>,
}

pub(super) struct RawDocument {
    pub url: String,
    pub bytes: Vec<u8>,
    pub content_type: Option<String>,
}

pub(super) async fn parse(
    job: &CloudJob<'_>,
    path: &Path,
    name_hint: &Path,
    cancellation: &WorkspaceCancellation,
) -> anyhow::Result<String> {
    parse_document(job, path, name_hint, false, cancellation)
        .await?
        .markdown
        .filter(|markdown| !markdown.trim().is_empty())
        .context("Firecrawl parse did not return markdown.")
}

pub(super) async fn parse_pages(
    job: &CloudJob<'_>,
    path: &Path,
    name_hint: &Path,
    cancellation: &WorkspaceCancellation,
) -> anyhow::Result<Vec<ParsedPage>> {
    parse_document(job, path, name_hint, true, cancellation)
        .await?
        .pages
        .context("Firecrawl parse did not return pages.")
}

pub(super) async fn scrape_markdown(
    job: &CloudJob<'_>,
    url: &reqwest::Url,
    cancellation: &WorkspaceCancellation,
) -> anyhow::Result<serde_json::Value> {
    let response = scrape(job, false, cancellation).await?;
    let markdown = response
        .markdown
        .context("context.dev did not return markdown.")?
        .require()?
        .unwrap_or_default();
    Ok(serde_json::json!({
        "url": resolved_url(response.url, url),
        "markdown": markdown,
    }))
}

pub(super) async fn scrape_raw(
    job: &CloudJob<'_>,
    url: &reqwest::Url,
    cancellation: &WorkspaceCancellation,
) -> anyhow::Result<RawDocument> {
    let response = scrape(job, true, cancellation).await?;
    let output = response
        .bytes
        .context("context.dev did not return the document.")?;
    anyhow::ensure!(
        output.error_code.as_deref() != Some("CONTENT_TOO_LARGE"),
        "Document exceeds the 50 MB raw fetch limit."
    );
    let data = output.require()?;
    let bytes = data
        .as_ref()
        .map(|data| base64::engine::general_purpose::STANDARD.decode(&data.base64))
        .transpose()
        .context("context.dev returned an invalid document")?
        .unwrap_or_default();
    anyhow::ensure!(!bytes.is_empty(), "context.dev returned an empty document.");
    Ok(RawDocument {
        url: resolved_url(response.url, url),
        bytes,
        content_type: data.and_then(|data| data.content_type),
    })
}

fn resolved_url(resolved: Option<String>, requested: &reqwest::Url) -> String {
    resolved
        .filter(|url| !url.is_empty())
        .unwrap_or_else(|| requested.to_string())
}

impl<T> ScrapeOutput<T> {
    /// Failed outputs arrive inside HTTP 200 responses.
    fn require(self) -> anyhow::Result<Option<T>> {
        if self.success == Some(false) {
            let message = self
                .message
                .filter(|message| !message.trim().is_empty())
                .unwrap_or_else(|| "The page could not be scraped.".into());
            let code = self.error_code.as_deref().unwrap_or("UNKNOWN");
            anyhow::bail!(
                "This webpage returned an error: {} ({code})",
                message.trim()
            );
        }
        Ok(self.data)
    }
}

async fn scrape(
    job: &CloudJob<'_>,
    raw_document: bool,
    cancellation: &WorkspaceCancellation,
) -> anyhow::Result<ScrapeResponse> {
    let params: &[(&str, &str)] = if raw_document {
        &[("rawDocument", "true")]
    } else {
        &[]
    };
    let request = job.post("/agent/scrape", params, None, MAX_SCRAPE_RESPONSE_BYTES);
    let bytes = tokio::select! {
        biased;
        _ = cancellation.cancelled() => return Err(WorkspaceOperationCancelled.into()),
        result = tokio::time::timeout(SCRAPE_TIMEOUT, request) => {
            result.context("cloud scrape timed out")??
        }
    };
    serde_json::from_slice(&bytes).context("cloud scrape returned an invalid response")
}

async fn parse_document(
    job: &CloudJob<'_>,
    path: &Path,
    name_hint: &Path,
    pages: bool,
    cancellation: &WorkspaceCancellation,
) -> anyhow::Result<ParsedDocument> {
    let bytes = tokio::select! {
        biased;
        _ = cancellation.cancelled() => return Err(WorkspaceOperationCancelled.into()),
        result = tokio::time::timeout(PARSE_TIMEOUT, upload(job, path, name_hint, pages)) => {
            result.context("hosted parsing timed out")??
        }
    };
    decode_parsed(&bytes)
}

fn decode_parsed(bytes: &[u8]) -> anyhow::Result<ParsedDocument> {
    let document = serde_json::from_slice::<ParseResponse>(bytes)
        .context("Firecrawl parse returned an invalid response.")?
        .data;
    if let Some(ParseMetadata {
        num_pages: Some(parsed),
        total_pages: Some(total),
    }) = document.metadata
    {
        anyhow::ensure!(total <= parsed, "Parsed document was truncated.");
    }
    Ok(document)
}

async fn upload(
    job: &CloudJob<'_>,
    path: &Path,
    name_hint: &Path,
    pages: bool,
) -> anyhow::Result<Vec<u8>> {
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
    let body = futures::stream::try_unfold(file.take(size), |mut file| async move {
        let mut bytes = vec![0; 64 * 1024];
        let read = file.read(&mut bytes).await?;
        if read == 0 {
            return Ok::<_, std::io::Error>(None);
        }
        bytes.truncate(read);
        Ok(Some((bytes, file)))
    });
    let filename = name_hint
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("document.pdf");
    let mut params = vec![("filename", filename)];
    if pages {
        params.push(("pages", "true"));
    }
    job.post(
        "/agent/parse",
        &params,
        Some((reqwest::Body::wrap_stream(body), size)),
        MAX_PARSE_RESPONSE_BYTES,
    )
    .await
}

impl CloudJob<'_> {
    async fn post(
        &self,
        path: &str,
        params: &[(&str, &str)],
        upload: Option<(reqwest::Body, u64)>,
        limit: usize,
    ) -> anyhow::Result<Vec<u8>> {
        let mut url = reqwest::Url::parse(&self.runtime.http_action_url(path))?;
        url.query_pairs_mut()
            .extend_pairs([
                ("runId", self.run_id),
                ("claimId", self.claim_id),
                ("jobId", self.job_id),
            ])
            .extend_pairs(params);
        let client = reqwest::Client::builder()
            .no_proxy()
            .connect_timeout(Duration::from_secs(30))
            .build()?;
        let mut request = client
            .post(url)
            .bearer_auth(self.runtime.execution_secret());
        if let Some((body, size)) = upload {
            request = request
                .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
                .header(reqwest::header::CONTENT_LENGTH, size)
                .body(body);
        }
        let response = request.send().await.map_err(reqwest::Error::without_url)?;
        success_body(response, limit).await
    }
}

/// The HTTP actions answer failures with a plain-text message meant for the agent.
async fn success_body(response: reqwest::Response, limit: usize) -> anyhow::Result<Vec<u8>> {
    let status = response.status();
    if !status.is_success() {
        let message = read_limited(response, MAX_ERROR_BYTES)
            .await
            .map(|bytes| String::from_utf8_lossy(&bytes).trim().to_owned())
            .unwrap_or_default();
        anyhow::ensure!(!message.is_empty(), "cloud request failed ({status})");
        anyhow::bail!(message);
    }
    read_limited(response, limit).await
}

async fn read_limited(mut response: reqwest::Response, limit: usize) -> anyhow::Result<Vec<u8>> {
    anyhow::ensure!(
        response
            .content_length()
            .is_none_or(|size| size <= limit as u64),
        "cloud response exceeds its size limit"
    );
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(reqwest::Error::without_url)?
    {
        anyhow::ensure!(
            chunk.len() <= limit.saturating_sub(bytes.len()),
            "cloud response exceeds its size limit"
        );
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests;
