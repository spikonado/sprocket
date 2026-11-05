use std::path::Path;
use std::time::Duration;

use anyhow::Context;
use serde_json::Value;
use tinker_workspace::{WorkspaceCancellation, WorkspaceOperationCancelled};
use tokio::io::AsyncWriteExt;

pub(super) const MAX_SCRAPE_BYTES: u64 = 64 * 1024 * 1024;
const SCRAPE_INLINE_MAX_CHARS: usize = 20_000;

pub(super) async fn localize_scrape(
    mut result: Value,
    cache_dir: &Path,
    cancellation: &WorkspaceCancellation,
    saved_file: &mut Option<tempfile::NamedTempFile>,
) -> anyhow::Result<Value> {
    let fields = result.as_object_mut().context("invalid scrape response")?;
    if let Some(download) = fields.remove("scrapeUrl") {
        let url = reqwest::Url::parse(download.as_str().context("invalid scrape download URL")?)?;
        anyhow::ensure!(
            matches!(url.scheme(), "http" | "https"),
            "scrape download requires an http(s) URL"
        );
        let temp = download_scrape(url, markdown_file(cache_dir).await?, cancellation).await?;
        record_saved_scrape(fields, temp, saved_file);
    } else {
        let markdown = fields
            .get("markdown")
            .and_then(Value::as_str)
            .context("scrape response is missing markdown")?;
        if exceeds_inline_limit(markdown) {
            let temp = save_markdown(cache_dir, markdown, cancellation).await?;
            record_saved_scrape(fields, temp, saved_file);
        }
    }
    Ok(result)
}

/// Counts UTF-16 units to match the backend's `markdown.length`.
fn exceeds_inline_limit(markdown: &str) -> bool {
    markdown.encode_utf16().count() > SCRAPE_INLINE_MAX_CHARS
}

async fn markdown_file(cache_dir: &Path) -> anyhow::Result<tempfile::NamedTempFile> {
    tokio::fs::create_dir_all(cache_dir)
        .await
        .with_context(|| format!("failed to create {}", cache_dir.display()))?;
    Ok(tempfile::Builder::new()
        .prefix("")
        .suffix(".md")
        .tempfile_in(cache_dir)?)
}

async fn save_markdown(
    cache_dir: &Path,
    contents: &str,
    cancellation: &WorkspaceCancellation,
) -> anyhow::Result<tempfile::NamedTempFile> {
    let temp = markdown_file(cache_dir).await?;
    let mut file = tokio::fs::File::from_std(temp.reopen()?);
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => return Err(WorkspaceOperationCancelled.into()),
        result = async {
            file.write_all(contents.as_bytes()).await?;
            file.flush().await
        } => result?,
    }
    Ok(temp)
}

fn record_saved_scrape(
    fields: &mut serde_json::Map<String, Value>,
    temp: tempfile::NamedTempFile,
    saved_file: &mut Option<tempfile::NamedTempFile>,
) {
    fields.remove("markdown");
    fields.insert(
        "savedTo".into(),
        Value::String(temp.path().display().to_string()),
    );
    *saved_file = Some(temp);
}

async fn download_scrape(
    url: reqwest::Url,
    temp: tempfile::NamedTempFile,
    cancellation: &WorkspaceCancellation,
) -> anyhow::Result<tempfile::NamedTempFile> {
    let transfer = async {
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(60))
            .redirect(reqwest::redirect::Policy::limited(5))
            .build()?;
        let mut response = client.get(url).send().await?.error_for_status()?;
        anyhow::ensure!(
            response
                .content_length()
                .is_none_or(|size| size <= MAX_SCRAPE_BYTES),
            "scrape exceeds the 64 MiB download limit"
        );
        let mut file = tokio::fs::File::from_std(temp.reopen()?);
        let mut received = 0u64;
        while let Some(chunk) = response.chunk().await? {
            received = received.saturating_add(chunk.len() as u64);
            anyhow::ensure!(
                received <= MAX_SCRAPE_BYTES,
                "scrape exceeds the 64 MiB download limit"
            );
            file.write_all(&chunk).await?;
        }
        file.flush().await?;
        Ok::<_, anyhow::Error>(())
    };
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => return Err(WorkspaceOperationCancelled.into()),
        result = transfer => result.context("failed to save the scrape")?,
    }
    Ok(temp)
}

#[cfg(test)]
mod tests;
