use std::time::Duration;

use anyhow::Context;
use serde_json::Value;
use sprocket_workspace::{WorkspaceCancellation, WorkspaceOperationCancelled};
use tokio::io::AsyncWriteExt;

pub(super) const MAX_SCRAPE_BYTES: u64 = 64 * 1024 * 1024;
const SCRAPE_INLINE_MAX_CHARS: usize = 40_000;

pub(super) async fn localize_scrape(
    mut result: Value,
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
        let temp = tempfile::Builder::new()
            .prefix("sprocket-scrape-")
            .suffix(".json")
            .tempfile()?;
        let temp = download_scrape(url, temp, cancellation).await?;
        record_saved_scrape(fields, temp, saved_file);
    } else {
        anyhow::ensure!(
            fields.get("markdown").is_some_and(Value::is_string),
            "scrape response is missing markdown"
        );
        let archive = serde_json::to_string(fields)?;
        // Match JSON.stringify(...).length in the backend, including surrogate pairs.
        if archive.encode_utf16().count() > SCRAPE_INLINE_MAX_CHARS {
            let temp = tempfile::Builder::new()
                .prefix("sprocket-scrape-")
                .suffix(".json")
                .tempfile()?;
            let mut file = tokio::fs::File::from_std(temp.reopen()?);
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => return Err(WorkspaceOperationCancelled.into()),
                result = async {
                    file.write_all(archive.as_bytes()).await?;
                    file.flush().await
                } => result?,
            }
            record_saved_scrape(fields, temp, saved_file);
        }
    }
    fields.remove("truncated");
    Ok(result)
}

fn record_saved_scrape(
    fields: &mut serde_json::Map<String, Value>,
    temp: tempfile::NamedTempFile,
    saved_file: &mut Option<tempfile::NamedTempFile>,
) {
    fields.insert(
        "markdown".into(),
        Value::String(format!(
            "The scrape was too large to directly output. Instead, it has been saved to {} for you to view.",
            temp.path().display()
        )),
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
