use std::path::{Path, PathBuf};
use std::time::Duration;

use reqwest::Url;
use serde_json::{Value, json};
use sprocket_workspace::{WorkspaceCancellation, WorkspaceOperationCancelled};

use super::hosted_parse::HostedParseContext;
use super::parse_file::{
    IMAGE_SNIFF_BYTES, MAX_PARSE_FILE_IMAGE_BYTES, convert_document, sniff_supported_image_format,
};
use super::scrape_files::MAX_SCRAPE_BYTES;

pub(super) fn github_raw_url(url: &Url) -> Option<Url> {
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    let mut raw = match url.host_str()? {
        "raw.githubusercontent.com" => url.clone(),
        "github.com" | "www.github.com" if url.port().is_none() => {
            let segments: Vec<_> = url.path_segments()?.collect();
            if segments.len() < 5
                || segments.iter().any(|segment| segment.is_empty())
                || !matches!(segments[2], "blob" | "raw" | "blame")
            {
                return None;
            }
            let mut raw = Url::parse("https://raw.githubusercontent.com").ok()?;
            raw.set_path(&format!(
                "/{}/{}/{}",
                segments[0],
                segments[1],
                segments[3..].join("/")
            ));
            raw.set_query(url.query());
            raw
        }
        _ => return None,
    };
    raw.set_fragment(None);
    Some(raw)
}

pub(super) async fn fetch_github_file(
    url: Url,
    supports_images: bool,
    cache_dir: &Path,
    hosted: Option<&HostedParseContext<'_>>,
    cancellation: &WorkspaceCancellation,
) -> anyhow::Result<Value> {
    let (url, bytes) = tokio::select! {
        biased;
        _ = cancellation.cancelled() => return Err(WorkspaceOperationCancelled.into()),
        result = async {
            let client = reqwest::Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(30))
                .redirect(reqwest::redirect::Policy::limited(5))
                .build()?;
            download_file(&client, url, MAX_SCRAPE_BYTES).await
        } => result?,
    };
    if sniff_supported_image_format(&bytes).is_some() {
        anyhow::ensure!(supports_images, "The selected model cannot view images.");
        return super::web::persist_web_image(&bytes, &url, cache_dir).await;
    }
    let (markdown, _) =
        convert_document(bytes, url_file_name(&url), None, hosted, cancellation).await?;
    Ok(json!({
        "url": url.as_str(),
        "markdown": markdown,
        "summary": "Summary not generated; file was read directly from GitHub.",
        "images": [],
    }))
}

pub(super) fn url_file_name(url: &Url) -> PathBuf {
    let filename = url.path_segments().and_then(Iterator::last).unwrap_or("");
    PathBuf::from(
        percent_encoding::percent_decode_str(filename)
            .decode_utf8_lossy()
            .as_ref(),
    )
}

pub(super) async fn download_file(
    client: &reqwest::Client,
    url: Url,
    mut max_bytes: u64,
) -> anyhow::Result<(Url, Vec<u8>)> {
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(reqwest::Error::without_url)?;
    let status = response.status();
    anyhow::ensure!(status == reqwest::StatusCode::OK, "HTTP {status}");
    let content_length = response.content_length();
    anyhow::ensure!(
        content_length.is_none_or(|size| size <= max_bytes),
        "file exceeds the download limit"
    );
    let mut bytes = Vec::new();
    let mut prefix = Vec::with_capacity(IMAGE_SNIFF_BYTES);
    while let Some(chunk) = response.chunk().await? {
        let prefix_bytes = chunk.len().min(IMAGE_SNIFF_BYTES - prefix.len());
        prefix.extend_from_slice(&chunk[..prefix_bytes]);
        if sniff_supported_image_format(&prefix).is_some() {
            max_bytes = max_bytes.min(MAX_PARSE_FILE_IMAGE_BYTES as u64);
        }
        anyhow::ensure!(
            content_length.is_none_or(|size| size <= max_bytes),
            "file exceeds the download limit"
        );
        anyhow::ensure!(
            bytes.len().saturating_add(chunk.len()) as u64 <= max_bytes,
            "file exceeds the download limit"
        );
        bytes.extend_from_slice(&chunk);
    }
    Ok((response.url().clone(), bytes))
}

#[cfg(test)]
mod tests;
