use std::time::Duration;

use reqwest::Url;
use serde_json::{Value, json};
use sprocket_workspace::{WorkspaceCancellation, WorkspaceOperationCancelled};

use super::scrape_files::MAX_SCRAPE_BYTES;

const MARKDOWN_TIMEOUT: Duration = Duration::from_secs(10);

pub(super) async fn try_markdown_url(
    url: Url,
    cancellation: &WorkspaceCancellation,
) -> anyhow::Result<Option<Value>> {
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err(WorkspaceOperationCancelled.into()),
        result = async {
            for url in markdown_urls(url) {
                if let Ok(result) = fetch_markdown(url, MAX_SCRAPE_BYTES).await {
                    return Some(result);
                }
            }
            None
        } => Ok(result),
    }
}

#[cfg(test)]
fn markdown_url(url: Url) -> Option<Url> {
    markdown_urls(url).into_iter().next()
}

fn markdown_urls(mut url: Url) -> Vec<Url> {
    let path = url.path().trim_end_matches('/').to_owned();
    let filename = percent_encoding::percent_decode_str(path.rsplit('/').next().unwrap_or(""))
        .decode_utf8_lossy();
    let extension = filename
        .rsplit_once('.')
        .filter(|(stem, extension)| !stem.is_empty() && !extension.is_empty())
        .map(|(_, extension)| extension);
    match extension {
        Some(extension) if extension.eq_ignore_ascii_case("md") => {}
        Some(_) => return Vec::new(),
        None if filename.eq_ignore_ascii_case(".md") => {}
        None => {
            let mut index = url.clone();
            url.set_path(&format!("{path}.md"));
            url.set_fragment(None);
            index.set_path(&format!("{path}/index.md"));
            index.set_fragment(None);
            return vec![url, index];
        }
    }
    url.set_fragment(None);
    vec![url]
}

async fn fetch_markdown(url: Url, max_bytes: u64) -> anyhow::Result<Value> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(MARKDOWN_TIMEOUT)
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()?;
    let mut response = client
        .get(url)
        .header(reqwest::header::ACCEPT, "text/markdown, text/plain;q=0.9")
        .send()
        .await?;
    anyhow::ensure!(
        response.status() == reqwest::StatusCode::OK,
        "no markdown endpoint"
    );
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    anyhow::ensure!(
        matches!(
            content_type.as_str(),
            "text/markdown" | "text/x-markdown" | "text/plain"
        ),
        "not a markdown response"
    );
    anyhow::ensure!(
        response
            .content_length()
            .is_none_or(|size| size <= max_bytes),
        "markdown exceeds the download limit"
    );
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        anyhow::ensure!(
            bytes.len().saturating_add(chunk.len()) as u64 <= max_bytes,
            "markdown exceeds the download limit"
        );
        bytes.extend_from_slice(&chunk);
    }
    let markdown = String::from_utf8(bytes)?;
    let start = markdown.trim_start_matches('\u{feff}').trim_start();
    anyhow::ensure!(
        !start.is_empty() && !markdown.contains('\0'),
        "empty or binary markdown response"
    );
    anyhow::ensure!(!looks_like_html(start), "HTML fallback instead of markdown");
    Ok(json!({
        "url": response.url().as_str(),
        "markdown": markdown,
        "summary": "Summary not generated; markdown was read directly from the site.",
        "images": [],
    }))
}

fn looks_like_html(mut text: &str) -> bool {
    while let Some(comment) = text.strip_prefix("<!--") {
        let Some((_, rest)) = comment.split_once("-->") else {
            break;
        };
        text = rest.trim_start();
    }
    let Some(tag) = text.strip_prefix('<') else {
        return false;
    };
    if tag.starts_with(['!', '?']) {
        return true;
    }
    let tag = tag.strip_prefix('/').unwrap_or(tag);
    if !tag.starts_with(|c: char| c.is_ascii_alphabetic()) {
        return false;
    }
    let after_name = tag.trim_start_matches(|c: char| c.is_ascii_alphanumeric() || c == '-');
    after_name.starts_with(|c: char| c.is_ascii_whitespace() || c == '>' || c == '/')
}

#[cfg(test)]
mod tests;
