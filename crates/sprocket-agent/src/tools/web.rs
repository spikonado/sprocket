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
        execute_cloud_tool_job(
            &self.0.runtime,
            &self.0.run_id,
            &self.0.claim_id,
            Self::NAME,
            &self.0.tool_call_tracker,
            payload,
        )
        .await
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
            &self.0.runtime,
            &self.0.run_id,
            &self.0.claim_id,
            Self::NAME,
            &self.0.tool_call_tracker,
            payload,
            |cancellation, job_id| async move {
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
            &self.0.runtime,
            &self.0.run_id,
            &self.0.claim_id,
            Self::NAME,
            &self.0.tool_call_tracker,
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
    let (media_type, width, height) = decode_image_info(&bytes)?;
    let path = persist_image_bytes(cache_dir, &bytes, &media_type).await?;
    Ok(json!({
        "outputType": "image", "url": response.url().as_str(),
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
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn serve(content_type: &str, bytes: Vec<u8>) -> reqwest::Url {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let header = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            bytes.len()
        );
        tokio::spawn(async move {
            for _ in 0..2 {
                let Ok(Ok((mut stream, _))) =
                    tokio::time::timeout(Duration::from_secs(2), listener.accept()).await
                else {
                    break;
                };
                let mut request = [0; 4096];
                stream.read(&mut request).await.unwrap();
                stream.write_all(header.as_bytes()).await.unwrap();
                if !request.starts_with(b"HEAD ") {
                    let _ = stream.write_all(&bytes).await;
                }
            }
        });
        reqwest::Url::parse(&format!("http://{address}/without-extension")).unwrap()
    }

    fn png() -> Vec<u8> {
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(1, 1)
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        bytes.into_inner()
    }

    #[tokio::test]
    async fn screenshot_saves_pixels_locally_for_history() {
        let cache = tempfile::tempdir().unwrap();
        let store = crate::transcript::TranscriptStore::new(cache.path().join("transcripts"));
        let directory = store.thread_dir("user", "thread").join("screenshot_url");
        let mut download = serve("application/octet-stream", png()).await;
        download.set_query(Some("signature=temporary-secret"));
        let metadata = fetch_screenshot(
            json!({
                "url": "https://example.com/page", "screenshotUrl": download.as_str(),
            }),
            &directory,
        )
        .await
        .unwrap();
        assert_eq!(metadata["url"], "https://example.com/page");
        assert_eq!(metadata["mediaType"], "image/png");
        assert_eq!(metadata["width"], 1);
        assert!(!metadata.to_string().contains("temporary-secret"));
        assert_image_history("screenshot_url", metadata, &directory).await;
        assert!(!directory.with_file_name("parse_file").exists());
    }

    #[tokio::test]
    async fn screenshot_rejects_missing_fields_and_non_http_downloads() {
        let cache = tempfile::tempdir().unwrap();
        for result in [
            json!({"url": "https://example.com"}),
            json!({"url": "https://example.com", "screenshotUrl": "file:///tmp/image.png"}),
            json!({"url": "file:///tmp/page.html", "screenshotUrl": "https://example.com/image.png"}),
        ] {
            assert!(fetch_screenshot(result, cache.path()).await.is_err());
        }
    }

    #[tokio::test]
    async fn screenshot_rejects_non_images_and_oversized_dimensions() {
        let cache = tempfile::tempdir().unwrap();
        let mut oversized = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(8193, 1)
            .write_to(&mut oversized, image::ImageFormat::Png)
            .unwrap();
        for bytes in [
            b"<html>not a screenshot</html>".to_vec(),
            oversized.into_inner(),
        ] {
            let download = serve("image/png", bytes).await;
            assert!(
                fetch_screenshot(
                    json!({
                        "url": "https://example.com", "screenshotUrl": download.as_str(),
                    }),
                    cache.path()
                )
                .await
                .is_err()
            );
        }
    }

    #[tokio::test]
    async fn image_without_extension_is_saved_locally_and_validated_by_signature() {
        let cache = tempfile::tempdir().unwrap();
        let directory = cache.path().join("scrape_url");
        let url = serve("image/jpeg", png()).await;
        let metadata = fetch_web_image(url, true, &directory)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(metadata["mediaType"], "image/png");
        assert_image_history("scrape_url", metadata, &directory).await;
    }

    async fn assert_image_history(name: &str, mut metadata: serde_json::Value, cache: &Path) {
        use crate::types::{
            AgentHistoryContent, AgentHistoryMessage, AgentHistoryRole, AgentHistoryToolResultItem,
        };
        use base64::Engine;

        let path = Path::new(metadata["path"].as_str().unwrap());
        assert_eq!(path.parent().unwrap(), cache.canonicalize().unwrap());
        assert_eq!(tokio::fs::read(path).await.unwrap(), png());
        assert!(!metadata.to_string().contains("iVBORw0KGgo"));
        let output = replay_image_tool_output(&metadata).await.unwrap();
        let saved_path = format!("Image saved to: {}", path.display());
        let expected = rig::message::ToolResultContent::image_base64(
            base64::engine::general_purpose::STANDARD.encode(png()),
            Some(rig::message::ImageMediaType::PNG),
            None,
        );
        assert_eq!(
            serde_json::to_value(output.into_content()).unwrap(),
            json!([
                rig::message::ToolResultContent::text(saved_path.clone()),
                expected
            ])
        );

        metadata["url"] = json!("http://127.0.0.1:1/unavailable");
        let part = serde_json::from_value(json!({
            "number": 1, "sourceKey": "tool:1", "kind": "tool", "runId": "run",
            "tool": {"callId": "call", "name": name, "status": "completed", "output": metadata}
        }))
        .unwrap();
        let mut history = vec![AgentHistoryMessage {
            role: AgentHistoryRole::User,
            assistant_id: None,
            contents: vec![AgentHistoryContent::ToolResult {
                id: "call".into(),
                call_id: Some("call".into()),
                items: vec![AgentHistoryToolResultItem::Text {
                    text: metadata.to_string(),
                }],
            }],
        }];
        super::super::hydrate_tool_history(&mut history, std::slice::from_ref(&part), true).await;
        let AgentHistoryContent::ToolResult { items, .. } = &history[0].contents[0] else {
            panic!("missing result")
        };
        let [
            AgentHistoryToolResultItem::Text { text },
            AgentHistoryToolResultItem::Image { image_json },
        ] = items.as_slice()
        else {
            panic!("missing saved path and image")
        };
        assert_eq!(text, &saved_path);
        let rig::message::ToolResultContent::Image(expected) = expected else {
            unreachable!()
        };
        assert_eq!(image_json, &serde_json::to_string(&expected).unwrap());

        super::super::hydrate_tool_history(&mut history, std::slice::from_ref(&part), false).await;
        let serialized = serde_json::to_string(&history).unwrap();
        assert!(serialized.contains("Image omitted"));
        assert!(!serialized.contains("imageJson"));

        tokio::fs::remove_file(metadata["path"].as_str().unwrap())
            .await
            .unwrap();
        super::super::hydrate_tool_history(&mut history, &[part], true).await;
        let serialized = serde_json::to_string(&history).unwrap();
        assert!(serialized.contains("not available in the local cache"));
        assert!(!serialized.contains("imageJson"));
    }

    #[tokio::test]
    async fn image_download_fails_when_local_persistence_fails() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let url = serve("image/png", png()).await;
        assert!(fetch_web_image(url, true, file.path()).await.is_err());
    }

    #[tokio::test]
    async fn html_is_left_to_the_scraper() {
        let cache = tempfile::tempdir().unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = reqwest::Url::parse(&format!("http://{}/page", listener.local_addr().unwrap()))
            .unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            stream.read(&mut request).await.unwrap();
            assert!(request.starts_with(b"HEAD "));
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 50\r\nConnection: close\r\n\r\n").await.unwrap();
            listener
        });
        assert!(
            fetch_web_image(url, true, cache.path())
                .await
                .unwrap()
                .is_none()
        );
        let listener = server.await.unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(50), listener.accept())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn image_extension_handles_generic_content_types() {
        let cache = tempfile::tempdir().unwrap();
        let mut url = serve("application/octet-stream", png()).await;
        url.set_path("/image.PNG");
        assert!(
            fetch_web_image(url, true, cache.path())
                .await
                .unwrap()
                .is_some()
        );
    }

    #[tokio::test]
    async fn unrecognized_content_is_scraped_but_text_only_models_reject_images() {
        let cache = tempfile::tempdir().unwrap();
        let url = serve("image/svg+xml", b"<svg></svg>".to_vec()).await;
        assert!(
            fetch_web_image(url, true, cache.path())
                .await
                .unwrap()
                .is_none()
        );
        let url = serve("image/jpeg", b"<html>mislabelled</html>".to_vec()).await;
        assert!(fetch_web_image(url, true, cache.path()).await.is_err());
        let url = serve("image/png", png()).await;
        assert!(
            fetch_web_image(url, false, cache.path())
                .await
                .unwrap_err()
                .to_string()
                .contains("cannot view")
        );
    }

    #[test]
    fn urls_must_be_http() {
        for url in [
            "file:///tmp/file",
            "data:image/png;base64,abc",
            "ftp://example.com",
        ] {
            assert!(validate_web_url(url).is_err());
        }
    }

    #[tokio::test]
    async fn screenshot_download_reads_extensionless_images_without_head() {
        let cache = tempfile::tempdir().unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = reqwest::Url::parse(&format!("http://{}/opaque", listener.local_addr().unwrap()))
            .unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            stream.read(&mut request).await.unwrap();
            assert!(request.starts_with(b"GET "));
            let bytes = png();
            let headers = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                bytes.len()
            );
            stream.write_all(headers.as_bytes()).await.unwrap();
            stream.write_all(&bytes).await.unwrap();
        });
        let metadata = fetch_screenshot(
            json!({
                "url": "https://example.com/page", "screenshotUrl": url.as_str(),
            }),
            cache.path(),
        )
        .await
        .unwrap();
        server.await.unwrap();
        assert_eq!(metadata["mediaType"], "image/png");
    }
}
