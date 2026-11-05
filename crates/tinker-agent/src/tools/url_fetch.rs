use std::path::{Path, PathBuf};

use reqwest::Url;
use rig::message::MimeType;
use serde_json::json;

use super::convert::{
    IMAGE_SNIFF_BYTES, MAX_PARSE_FILE_IMAGE_BYTES, fit_image_for_model_blocking,
    persist_image_bytes, sniff_supported_image_format,
};

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

pub(super) async fn persist_web_image(
    bytes: Vec<u8>,
    url: &Url,
    cache_dir: &Path,
) -> anyhow::Result<serde_json::Value> {
    let image = fit_image_for_model_blocking(bytes).await?;
    let path = persist_image_bytes(cache_dir, &image.bytes, &image.media_type).await?;
    Ok(json!({
        "outputType": "image", "url": url.as_str(),
        "path": path,
        "mediaType": image.media_type.to_mime_type(), "byteSize": image.bytes.len(),
        "width": image.width, "height": image.height,
    }))
}

#[cfg(test)]
mod tests;
