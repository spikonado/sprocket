use std::collections::BTreeMap;
use std::time::Duration;

use anyhow::Context;
use rig::message::MimeType;
use rig::tool::{ToolExecutionError, ToolOutput};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::context::{AgentToolContext, tool_error};
use super::job::{execute_cloud_tool_job, execute_tool_job_with_id, run_convex_tool_action};
use super::parse_file::{
    MAX_PARSE_FILE_IMAGE_BYTES, decode_image_info, tool_output_from_image_bytes,
};

pub(super) const DEFAULT_WEB_SEARCH_RESULTS: u32 = 5;

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
pub(crate) struct ScrapeUrlArgs {
    /// HTTP(S) URL of a page or image to read.
    pub(crate) url: String,
    /// Fetch as an image without HEAD discovery. Use when image servers reject HEAD or mislabel content.
    #[serde(
        rename = "asImage",
        default,
        skip_serializing_if = "std::ops::Not::not"
    )]
    pub(crate) as_image: bool,
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
        let description = "Read an HTTP(S) URL as markdown, or return a jpeg, png, gif, or webp image. Use parse_file for local files. Nothing is saved locally. Very long pages are truncated. Images are limited to 20 MiB and 8192 px per side.";
        if self.0.supports_images {
            description.to_string()
        } else {
            format!("{description} This model cannot view images; image URLs are rejected.")
        }
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
        let mut image_output = None;
        let result = execute_tool_job_with_id(
            &self.0.runtime,
            &self.0.run_id,
            &self.0.claim_id,
            Self::NAME,
            &self.0.tool_call_tracker,
            payload,
            |cancellation, job_id| async {
                let image = tokio::select! {
                    biased;
                    _ = cancellation.cancelled() => return Err(super::context::cancelled_error()),
                    result = fetch_web_image(url, self.0.supports_images, args.as_image) => result.map_err(tool_error)?,
                };
                if let Some((metadata, output)) = image {
                    image_output = Some(output);
                    return Ok(metadata);
                }
                let action_args = BTreeMap::from([
                    ("runId".to_string(), self.0.run_id.clone().into()),
                    ("claimId".to_string(), self.0.claim_id.clone().into()),
                    ("jobId".to_string(), job_id.into()),
                ]);
                run_convex_tool_action(&self.0.runtime, cancellation, "webTools:scrapeForTool", action_args).await
            },
        )
        .await?;
        Ok(image_output.unwrap_or_else(|| ToolOutput::json(result)))
    }
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
    as_image: bool,
) -> anyhow::Result<Option<(serde_json::Value, ToolOutput)>> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()?;
    let image_url = if as_image {
        Some(url)
    } else {
        discover_image_url(&client, url).await
    };
    let Some(image_url) = image_url else {
        return Ok(None);
    };
    anyhow::ensure!(supports_images, "The selected model cannot view images.");
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
    let metadata = json!({
        "outputType": "image", "url": response.url().as_str(),
        "mediaType": media_type.to_mime_type(), "byteSize": bytes.len(), "width": width, "height": height,
    });
    Ok(Some((
        metadata,
        tool_output_from_image_bytes(&bytes, media_type),
    )))
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
    async fn image_without_extension_is_returned_in_memory_and_validated_by_signature() {
        let url = serve("image/jpeg", png()).await;
        let (metadata, output) = fetch_web_image(url, true, false).await.unwrap().unwrap();
        assert_eq!(metadata["mediaType"], "image/png");
        assert!(metadata.get("path").is_none());
        assert!(matches!(
            output.into_content().first(),
            Some(rig::message::ToolResultContent::Image(_))
        ));
    }

    #[tokio::test]
    async fn html_is_left_to_the_scraper() {
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
        assert!(fetch_web_image(url, true, false).await.unwrap().is_none());
        let listener = server.await.unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(50), listener.accept())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn image_extension_handles_generic_content_types() {
        let mut url = serve("application/octet-stream", png()).await;
        url.set_path("/image.PNG");
        assert!(fetch_web_image(url, true, false).await.unwrap().is_some());
    }

    #[tokio::test]
    async fn unrecognized_content_is_scraped_but_text_only_models_reject_images() {
        let url = serve("image/svg+xml", b"<svg></svg>".to_vec()).await;
        assert!(fetch_web_image(url, true, false).await.unwrap().is_none());
        let url = serve("image/jpeg", b"<html>mislabelled</html>".to_vec()).await;
        assert!(fetch_web_image(url, true, false).await.is_err());
        let url = serve("image/png", png()).await;
        assert!(
            fetch_web_image(url, false, false)
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
    async fn explicit_image_mode_reads_extensionless_images_without_head() {
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
        let (metadata, _) = fetch_web_image(url, true, true).await.unwrap().unwrap();
        server.await.unwrap();
        assert_eq!(metadata["mediaType"], "image/png");
    }

    #[test]
    fn image_mode_is_optional_and_preserved_when_requested() {
        let args: ScrapeUrlArgs =
            serde_json::from_value(json!({"url": "https://example.com"})).unwrap();
        assert!(!args.as_image);
        assert_eq!(
            serde_json::to_value(args).unwrap(),
            json!({"url": "https://example.com"})
        );
        let args: ScrapeUrlArgs =
            serde_json::from_value(json!({"url": "https://example.com", "asImage": true})).unwrap();
        assert!(args.as_image);
        assert_eq!(serde_json::to_value(args).unwrap()["asImage"], true);
    }
}
