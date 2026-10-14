use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;

use anyhow::Context;
use rig::message::MimeType;
use rig::tool::{ToolExecutionError, ToolOutput};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::context::{AgentToolContext, tool_error, tool_failure};
use super::job::{execute_cloud_tool_job, execute_tool_job_with_id};
use super::parse_file::{
    MAX_PARSE_FILE_IMAGE_BYTES, decode_image_info, persist_image_bytes, replay_image_tool_output,
};

pub(super) const DEFAULT_WEB_SEARCH_RESULTS: u32 = 5;

#[derive(Clone)]
pub(crate) struct ScrapeUrlTool(pub(super) AgentToolContext);

#[derive(Clone)]
pub(crate) struct ScreenshotUrlTool(pub(super) AgentToolContext);

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
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
pub(crate) struct ScreenshotUrlArgs {
    pub(crate) url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScreenshotTransport {
    url: String,
    screenshot_url: String,
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
                if let Some(raw_url) = super::github_url::github_raw_url(&url) {
                    let result = super::github_url::fetch_github_file(raw_url, self.0.supports_images, &cache_dir, &cancellation).await.map_err(tool_error)?;
                    return if result.get("outputType").and_then(serde_json::Value::as_str) == Some("image") {
                        Ok(result)
                    } else {
                        super::scrape_files::localize_scrape(result, &cancellation, saved_file).await.map_err(tool_error)
                    };
                }
                let image = tokio::select! {
                    biased;
                    _ = cancellation.cancelled() => return Err(super::context::cancelled_error()),
                    result = fetch_web_image(url.clone(), self.0.supports_images, &cache_dir) => result.map_err(tool_error)?,
                };
                if let Some(metadata) = image {
                    return Ok(metadata);
                }
                if let Some(result) = super::markdown_url::try_markdown_url(url, &cancellation).await.map_err(tool_error)? {
                    return super::scrape_files::localize_scrape(result, &cancellation, saved_file).await.map_err(tool_error);
                }
                let action_args = BTreeMap::from([
                    ("runId".to_string(), self.0.run_id.clone().into()),
                    ("claimId".to_string(), self.0.claim_id.clone().into()),
                    ("jobId".to_string(), job_id.into()),
                ]);
                let result = super::firecrawl::run(&self.0.runtime, cancellation.clone(), action_args, "scrape").await?;
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

impl rig::tool::Tool for ScreenshotUrlTool {
    const NAME: &'static str = "screenshot_url";
    type Error = ToolExecutionError;
    type Args = ScreenshotUrlArgs;
    type Output = ToolOutput;

    fn description(&self) -> String {
        "Use to take a viewport screenshot of ANY public HTTP(S) URL. Returns the saved local path and the image.".to_string()
    }

    fn parameters(&self) -> serde_json::Value {
        json!(schemars::schema_for!(ScreenshotUrlArgs))
    }

    async fn call(
        &self,
        _context: &mut rig::tool::ToolContext,
        args: Self::Args,
    ) -> Result<Self::Output, Self::Error> {
        if !self.0.supports_images {
            return Err(tool_failure("The selected model cannot view images."));
        }
        validate_web_url(&args.url).map_err(tool_error)?;
        let cache_dir = self.0.transcript_dir.join(Self::NAME);
        let payload = serde_json::to_value(&args).map_err(|e| tool_error(e.into()))?;
        let result = execute_tool_job_with_id(
            &self.0,
            Self::NAME,
            payload,
            |cancellation, job_id| async move {
                let action_args = BTreeMap::from([
                    ("runId".to_string(), self.0.run_id.clone().into()),
                    ("claimId".to_string(), self.0.claim_id.clone().into()),
                    ("jobId".to_string(), job_id.into()),
                ]);
                let result = super::firecrawl::run(
                    &self.0.runtime,
                    cancellation.clone(),
                    action_args,
                    "screenshot",
                )
                .await?;
                tokio::select! {
                    biased;
                    _ = cancellation.cancelled() => return Err(super::context::cancelled_error()),
                    result = fetch_screenshot(result, &cache_dir) => result.map_err(tool_error),
                }
            },
        )
        .await?;
        replay_image_tool_output(&result).await.map_err(tool_error)
    }
}

async fn fetch_screenshot(
    result: serde_json::Value,
    cache_dir: &Path,
) -> anyhow::Result<serde_json::Value> {
    let transport: ScreenshotTransport =
        serde_json::from_value(result).context("invalid screenshot response")?;
    let page_url = validate_web_url(&transport.url)?;
    let screenshot_url = validate_web_url(&transport.screenshot_url)?;
    let mut metadata = download_image(&image_client()?, screenshot_url, cache_dir).await?;
    metadata["url"] = json!(page_url.as_str());
    Ok(metadata)
}

fn validate_web_url(value: &str) -> anyhow::Result<reqwest::Url> {
    let url = reqwest::Url::parse(value.trim()).context("invalid URL")?;
    anyhow::ensure!(
        matches!(url.scheme(), "http" | "https"),
        "Only http(s) URLs can be scraped."
    );
    Ok(url)
}

async fn fetch_web_image(
    url: reqwest::Url,
    supports_images: bool,
    cache_dir: &Path,
) -> anyhow::Result<Option<serde_json::Value>> {
    let client = image_client()?;
    let Some(image_url) = discover_image_url(&client, url).await else {
        return Ok(None);
    };
    anyhow::ensure!(supports_images, "The selected model cannot view images.");
    download_image(&client, image_url, cache_dir)
        .await
        .map(Some)
}

fn image_client() -> reqwest::Result<reqwest::Client> {
    reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(30))
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

async fn discover_image_url(client: &reqwest::Client, url: reqwest::Url) -> Option<reqwest::Url> {
    // HEAD avoids consuming a single-use page before the cloud scraper's GET.
    if let Ok(response) = client.head(url.clone()).send().await {
        if response.status().is_success() {
            let media_type = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .unwrap_or("")
                .split(';')
                .next()
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase();
            return match media_type.as_str() {
                "image/jpeg" | "image/png" | "image/gif" | "image/webp" => {
                    Some(response.url().clone())
                }
                "" | "application/octet-stream" if has_image_extension(response.url()) => {
                    Some(response.url().clone())
                }
                _ => None,
            };
        }
    }
    has_image_extension(&url).then_some(url)
}

fn has_image_extension(url: &reqwest::Url) -> bool {
    url.path().rsplit('.').next().is_some_and(|extension| {
        matches!(
            extension.to_ascii_lowercase().as_str(),
            "jpeg" | "jpg" | "png" | "gif" | "webp"
        )
    })
}

#[cfg(test)]
mod tests;
