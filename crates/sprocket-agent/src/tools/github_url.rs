use std::path::Path;
use std::time::Duration;

use reqwest::Url;
use serde_json::{Value, json};
use sprocket_workspace::{WorkspaceCancellation, WorkspaceOperationCancelled};

use super::convert::{convert_document, sniff_supported_image_format};
use super::hosted_parse::HostedParseContext;
use super::scrape_files::MAX_SCRAPE_BYTES;
use super::url_fetch::{download_file, persist_web_image, url_file_name};

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
        return persist_web_image(bytes, &url, cache_dir).await;
    }
    let (markdown, _) =
        convert_document(bytes, url_file_name(&url), None, hosted, cancellation).await?;
    Ok(json!({
        "url": url.as_str(),
        "markdown": markdown,
        "images": [],
    }))
}

#[cfg(test)]
mod tests;
