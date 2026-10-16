use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;

use anyhow::Context;
use rig::message::MimeType;
use rig::tool::{ToolExecutionError, ToolOutput};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sprocket_workspace::WorkspaceCancellation;

use super::context::{AgentToolContext, tool_error};
use super::hosted_parse::HostedParseContext;
use super::job::{execute_cloud_tool_job, execute_tool_job_with_id};
use super::parse_file::{
    MAX_PARSE_FILE_IMAGE_BYTES, convert_document, decode_image_info, persist_image_bytes,
    replay_image_tool_output,
};
use super::scrape_files::MAX_SCRAPE_BYTES;

pub(super) const DEFAULT_WEB_SEARCH_RESULTS: u32 = 5;
const DOCUMENT_SNIFF_BYTES: usize = 1024;
const DOCUMENT_TOO_LARGE: &str = "document exceeds the 64 MiB scrape limit; download it with shell tools and split it or extract its text there";

#[derive(Clone)]
pub(crate) struct ScrapeUrlTool(pub(super) AgentToolContext);

#[derive(Clone)]
pub(crate) struct WebSearchTool(pub(super) AgentToolContext);

fn default_web_search_results() -> u32 {
    DEFAULT_WEB_SEARCH_RESULTS
}

fn is_default_web_search_results(num_results: &u32) -> bool {
    *num_results == DEFAULT_WEB_SEARCH_RESULTS
}

pub(super) fn web_search_parameters() -> serde_json::Value {
    let mut schema = json!(schemars::schema_for!(WebSearchArgs));
    schema["properties"]["numResults"]["default"] = json!(DEFAULT_WEB_SEARCH_RESULTS);
    schema
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
pub(crate) struct WebSearchArgs {
    /// Web search query.
    pub(crate) query: String,
    /// Number of results to return, between 1 and 10. Defaults to 5.
    #[serde(
        rename = "numResults",
        default = "default_web_search_results",
        skip_serializing_if = "is_default_web_search_results"
    )]
    #[schemars(default = "default_web_search_results")]
    pub(crate) num_results: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct ScrapeUrlArgs {
    pub(crate) url: String,
    /// Optional question about the page. Web pages then also return the passages most relevant to it as `highlights`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) query: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawDocumentTransport {
    url: String,
    document_url: String,
    content_type: Option<String>,
}

#[derive(Debug)]
enum LocalResource {
    Image(serde_json::Value),
    Document(WebDocument),
    /// Looks like a document, but the local download failed.
    UnreadableDocument,
    Page,
}

#[derive(Debug)]
struct WebDocument {
    url: reqwest::Url,
    bytes: Vec<u8>,
    hint: Option<anydoc::Format>,
}

enum Probe {
    Image(reqwest::Url),
    Document(reqwest::Url),
    /// HEAD was inconclusive, so the GET decides.
    Unknown(reqwest::Url),
    Page,
}

impl rig::tool::Tool for WebSearchTool {
    const NAME: &'static str = "web_search";
    type Error = ToolExecutionError;
    type Args = WebSearchArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        "Search the web. Returns relevant pages with their URL, title, and a text excerpt. Use for current events or information beyond the local workspace."
            .to_string()
    }

    fn parameters(&self) -> serde_json::Value {
        web_search_parameters()
    }

    async fn call(
        &self,
        _context: &mut rig::tool::ToolContext,
        args: Self::Args,
    ) -> Result<Self::Output, Self::Error> {
        let payload = serde_json::to_value(&args).map_err(|e| tool_error(e.into()))?;
        execute_cloud_tool_job(&self.0, Self::NAME, payload).await
    }
}

impl rig::tool::Tool for ScrapeUrlTool {
    const NAME: &'static str = "scrape_url";
    type Error = ToolExecutionError;
    type Args = ScrapeUrlArgs;
    type Output = ToolOutput;

    fn description(&self) -> String {
        "Use to scrape ANY public HTTP(S) URL into a format easily readable by you.".to_string()
    }

    fn parameters(&self) -> serde_json::Value {
        json!(schemars::schema_for!(ScrapeUrlArgs))
    }

    async fn call(
        &self,
        _context: &mut rig::tool::ToolContext,
        args: Self::Args,
    ) -> Result<Self::Output, Self::Error> {
        let url = validate_web_url(&args.url).map_err(tool_error)?;
        let payload = serde_json::to_value(&args).map_err(|e| tool_error(e.into()))?;
        let mut scrape_file = None;
        let saved_file = &mut scrape_file;
        let cache_dir = self.0.transcript_dir.join(Self::NAME);
        let result = execute_tool_job_with_id(
            &self.0,
            Self::NAME,
            payload,
            |cancellation, job_id| async move {
                let hosted = HostedParseContext {
                    runtime: &self.0.runtime,
                    run_id: &self.0.run_id,
                    claim_id: &self.0.claim_id,
                    job_id: &job_id,
                };
                if let Some(raw_url) = super::github_url::github_raw_url(&url) {
                    let result = super::github_url::fetch_github_file(raw_url, self.0.supports_images, &cache_dir, Some(&hosted), &cancellation).await.map_err(tool_error)?;
                    return if result.get("outputType").and_then(serde_json::Value::as_str) == Some("image") {
                        Ok(result)
                    } else {
                        super::scrape_files::localize_scrape(result, &cancellation, saved_file).await.map_err(tool_error)
                    };
                }
                let local = tokio::select! {
                    biased;
                    _ = cancellation.cancelled() => return Err(super::context::cancelled_error()),
                    result = fetch_local_resource(url.clone(), self.0.supports_images, &cache_dir) => result.map_err(tool_error)?,
                };
                let document = match local {
                    LocalResource::Image(metadata) => return Ok(metadata),
                    LocalResource::Document(document) => Some(document),
                    LocalResource::UnreadableDocument => fetch_raw_document(&self.0, &job_id, &cancellation).await?,
                    LocalResource::Page => {
                        if let Some(result) = super::markdown_url::try_markdown_url(url, &cancellation).await.map_err(tool_error)? {
                            return super::scrape_files::localize_scrape(result, &cancellation, saved_file).await.map_err(tool_error);
                        }
                        None
                    }
                };
                // Documents are parsed locally; the cloud page scrape only sees web pages.
                if let Some(document) = document {
                    let result = convert_web_document(document, &hosted, &cancellation).await.map_err(tool_error)?;
                    return super::scrape_files::localize_scrape(result, &cancellation, saved_file).await.map_err(tool_error);
                }
                let result = super::web_request::run(&self.0.runtime, cancellation.clone(), web_request_args(&self.0, &job_id), "scrape").await?;
                super::scrape_files::localize_scrape(result, &cancellation, saved_file).await.map_err(tool_error)
            },
        )
        .await?;
        if let Some(file) = scrape_file.as_mut() {
            file.disable_cleanup(true);
        }
        if result.get("outputType").and_then(serde_json::Value::as_str) == Some("image") {
            replay_image_tool_output(&result).await.map_err(tool_error)
        } else {
            Ok(ToolOutput::json(result))
        }
    }
}

pub(super) fn web_request_args(
    context: &AgentToolContext,
    job_id: &str,
) -> BTreeMap<String, convex::Value> {
    BTreeMap::from([
        ("runId".to_string(), context.run_id.clone().into()),
        ("claimId".to_string(), context.claim_id.clone().into()),
        ("jobId".to_string(), job_id.into()),
    ])
}

/// Fetches the bytes of a document the cloud scraper can reach but we cannot,
/// so it is still parsed locally. `None` means the URL serves no document after all.
async fn fetch_raw_document(
    context: &AgentToolContext,
    job_id: &str,
    cancellation: &WorkspaceCancellation,
) -> Result<Option<WebDocument>, ToolExecutionError> {
    let mut args = web_request_args(context, job_id);
    args.insert("rawDocument".into(), true.into());
    let result =
        super::web_request::run(&context.runtime, cancellation.clone(), args, "scrape").await?;
    let download = async {
        let transport: RawDocumentTransport = serde_json::from_value(result)?;
        let url = validate_web_url(&transport.url)?;
        let document_url = validate_web_url(&transport.document_url)?;
        let (_, bytes) =
            super::github_url::download_file(&scrape_client()?, document_url, MAX_SCRAPE_BYTES)
                .await
                .context("failed to download the document the cloud scraper fetched")?;
        let csv = is_csv(
            &normalize_media_type(transport.content_type.as_deref().unwrap_or_default()),
            &url,
        );
        Ok::<_, anyhow::Error>((url, bytes, csv))
    };
    let (url, bytes, csv) = tokio::select! {
        biased;
        _ = cancellation.cancelled() => return Err(super::context::cancelled_error()),
        result = download => result.map_err(tool_error)?,
    };
    Ok(is_document(&bytes, csv).then(|| WebDocument {
        url,
        bytes,
        hint: csv.then_some(anydoc::Format::Csv),
    }))
}

async fn convert_web_document(
    WebDocument { url, bytes, hint }: WebDocument,
    hosted: &HostedParseContext<'_>,
    cancellation: &WorkspaceCancellation,
) -> anyhow::Result<serde_json::Value> {
    let name = super::github_url::url_file_name(&url);
    let (markdown, _) = convert_document(bytes, name, hint, Some(hosted), cancellation)
        .await
        .with_context(|| format!("failed to parse the document at {url}"))?;
    Ok(json!({
        "url": url.as_str(),
        "markdown": markdown,
        "images": [],
    }))
}

fn validate_web_url(value: &str) -> anyhow::Result<reqwest::Url> {
    let url = reqwest::Url::parse(value.trim()).context("invalid URL")?;
    anyhow::ensure!(
        matches!(url.scheme(), "http" | "https"),
        "Only http(s) URLs can be scraped."
    );
    Ok(url)
}

async fn fetch_local_resource(
    url: reqwest::Url,
    supports_images: bool,
    cache_dir: &Path,
) -> anyhow::Result<LocalResource> {
    let client = scrape_client()?;
    match probe(&client, url).await {
        Probe::Image(image_url) => {
            anyhow::ensure!(supports_images, "The selected model cannot view images.");
            download_image(&client, image_url, cache_dir)
                .await
                .map(LocalResource::Image)
        }
        Probe::Document(document_url) => download_document(&client, document_url, true).await,
        Probe::Unknown(unknown_url) => download_document(&client, unknown_url, false).await,
        Probe::Page => Ok(LocalResource::Page),
    }
}

fn scrape_client() -> reqwest::Result<reqwest::Client> {
    reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(Duration::from_secs(30))
        .read_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(300))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
}

async fn download_image(
    client: &reqwest::Client,
    image_url: reqwest::Url,
    cache_dir: &Path,
) -> anyhow::Result<serde_json::Value> {
    let mut response = client.get(image_url).send().await?.error_for_status()?;
    anyhow::ensure!(
        response
            .content_length()
            .is_none_or(|size| size <= MAX_PARSE_FILE_IMAGE_BYTES as u64),
        "image exceeds the 20 MiB limit"
    );
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        anyhow::ensure!(
            bytes.len().saturating_add(chunk.len()) <= MAX_PARSE_FILE_IMAGE_BYTES,
            "image exceeds the 20 MiB limit"
        );
        bytes.extend_from_slice(&chunk);
    }
    persist_web_image(&bytes, response.url(), cache_dir).await
}

pub(super) async fn persist_web_image(
    bytes: &[u8],
    url: &reqwest::Url,
    cache_dir: &Path,
) -> anyhow::Result<serde_json::Value> {
    let (media_type, width, height) = decode_image_info(bytes)?;
    let path = persist_image_bytes(cache_dir, bytes, &media_type).await?;
    Ok(json!({
        "outputType": "image", "url": url.as_str(),
        "path": path,
        "mediaType": media_type.to_mime_type(), "byteSize": bytes.len(), "width": width, "height": height,
    }))
}

async fn probe(client: &reqwest::Client, url: reqwest::Url) -> Probe {
    // HEAD avoids consuming a single-use page before the cloud scraper's GET.
    let head = client.head(url.clone()).send().await.ok();
    let (url, media_type) = match head.filter(|response| response.status().is_success()) {
        Some(response) => (response.url().clone(), media_type(response.headers())),
        None => (url, String::new()),
    };
    match media_type.as_str() {
        "text/html" | "application/xhtml+xml" => Probe::Page,
        "image/jpeg" | "image/png" | "image/gif" | "image/webp" => Probe::Image(url),
        "" | "application/octet-stream" if has_image_extension(&url) => Probe::Image(url),
        other
            if is_document_media_type(other)
                || is_download_media_type(other)
                || has_document_extension(&url) =>
        {
            Probe::Document(url)
        }
        _ if has_html_extension(&url) => Probe::Page,
        _ => Probe::Unknown(url),
    }
}

/// Reads a document fully, but stops after the first bytes when they show it
/// is not one. Expected documents that fail to download or arrive as another
/// body, such as a bot challenge, go to the raw fetch instead of the page scrape.
async fn download_document(
    client: &reqwest::Client,
    url: reqwest::Url,
    expected: bool,
) -> anyhow::Result<LocalResource> {
    let failed = |document: bool| {
        if document {
            LocalResource::UnreadableDocument
        } else {
            LocalResource::Page
        }
    };
    let mut response = match client.get(url).send().await {
        Ok(response) if response.status().is_success() => response,
        _ => return Ok(failed(expected)),
    };
    let url = response.url().clone();
    let media_type = media_type(response.headers());
    let csv = is_csv(&media_type, &url);
    let expected = expected || csv || is_document_media_type(&media_type);
    let declared_too_large = response
        .content_length()
        .is_some_and(|size| size > MAX_SCRAPE_BYTES);
    let mut bytes = Vec::new();
    let mut identified = false;
    loop {
        let chunk = match response.chunk().await {
            Ok(chunk) => chunk,
            Err(_) => return Ok(failed(expected || identified)),
        };
        if let Some(chunk) = &chunk {
            bytes.extend_from_slice(chunk);
        }
        if !identified {
            match sniff_document(&bytes, chunk.is_none(), csv) {
                Some(true) => identified = true,
                Some(false) => return Ok(failed(expected)),
                None => {}
            }
        }
        if identified {
            anyhow::ensure!(
                !declared_too_large && bytes.len() as u64 <= MAX_SCRAPE_BYTES,
                DOCUMENT_TOO_LARGE
            );
        }
        if chunk.is_none() {
            break;
        }
    }
    Ok(LocalResource::Document(WebDocument {
        url,
        bytes,
        hint: csv.then_some(anydoc::Format::Csv),
    }))
}

/// Cheap checks only: the conversion worker identifies the exact format.
/// `None` means the bytes so far cannot tell yet.
fn sniff_document(bytes: &[u8], complete: bool, csv: bool) -> Option<bool> {
    const OLE_SIGNATURE: [u8; 8] = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
    let prefix = &bytes[..bytes.len().min(DOCUMENT_SNIFF_BYTES)];
    if prefix.starts_with(b"PK\x03\x04")
        || prefix.starts_with(&OLE_SIGNATURE)
        || prefix.starts_with(b"{\\rtf")
        || prefix.windows(5).any(|window| window == b"%PDF-")
    {
        return Some(true);
    }
    (complete || prefix.len() >= DOCUMENT_SNIFF_BYTES).then(|| csv && is_text(prefix))
}

fn is_document(bytes: &[u8], csv: bool) -> bool {
    sniff_document(bytes, true, csv) == Some(true)
}

fn is_text(prefix: &[u8]) -> bool {
    !prefix.contains(&0)
        && std::str::from_utf8(prefix).map_or_else(|error| error.error_len().is_none(), |_| true)
}

fn media_type(headers: &reqwest::header::HeaderMap) -> String {
    normalize_media_type(
        headers
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default(),
    )
}

fn normalize_media_type(value: &str) -> String {
    value
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
}

fn is_csv(media_type: &str, url: &reqwest::Url) -> bool {
    media_type == "text/csv" || (media_type != "text/html" && has_csv_extension(url))
}

fn is_document_media_type(media_type: &str) -> bool {
    matches!(
        media_type,
        "application/pdf"
            | "application/x-pdf"
            | "application/msword"
            | "application/vnd.ms-excel"
            | "application/vnd.ms-powerpoint"
            | "application/rtf"
            | "text/rtf"
            | "text/csv"
            | "application/epub+zip"
    ) || media_type.starts_with("application/vnd.openxmlformats-officedocument.")
        || media_type.starts_with("application/vnd.oasis.opendocument.")
}

fn is_download_media_type(media_type: &str) -> bool {
    matches!(
        media_type,
        "application/octet-stream"
            | "binary/octet-stream"
            | "application/x-download"
            | "application/force-download"
    )
}

fn has_document_extension(url: &reqwest::Url) -> bool {
    anydoc::Format::from_path(&super::github_url::url_file_name(url)).is_some()
}

fn has_csv_extension(url: &reqwest::Url) -> bool {
    anydoc::Format::from_path(&super::github_url::url_file_name(url)) == Some(anydoc::Format::Csv)
}

fn has_image_extension(url: &reqwest::Url) -> bool {
    matches!(
        url_extension(url).as_str(),
        "jpeg" | "jpg" | "png" | "gif" | "webp"
    )
}

fn has_html_extension(url: &reqwest::Url) -> bool {
    matches!(url_extension(url).as_str(), "html" | "htm" | "xhtml")
}

fn url_extension(url: &reqwest::Url) -> String {
    url.path()
        .rsplit('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase()
}

#[cfg(test)]
mod tests;
