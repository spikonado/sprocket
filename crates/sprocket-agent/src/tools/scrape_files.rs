use std::path::Path;
use std::time::Duration;

use anyhow::Context;
use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
use serde_json::{Value, json};
use sprocket_workspace::{WorkspaceCancellation, WorkspaceOperationCancelled};
use tokio::io::AsyncWriteExt;

pub(super) const MAX_SCRAPE_BYTES: u64 = 64 * 1024 * 1024;
const SCRAPE_INLINE_MAX_CHARS: usize = 20_000;
const OUTLINE_MAX_CHARS: usize = 8_000;
const OUTLINE_HEADING_MAX_CHARS: usize = 200;
const OUTLINE_DESCRIPTION_MAX_CHARS: usize = 1_000;

pub(super) async fn localize_scrape(
    mut result: Value,
    cache_dir: &Path,
    cancellation: &WorkspaceCancellation,
    saved_file: &mut Option<tempfile::NamedTempFile>,
) -> anyhow::Result<Value> {
    let fields = result.as_object_mut().context("invalid scrape response")?;
    let temp = if let Some(download) = fields.remove("scrapeUrl") {
        let url = reqwest::Url::parse(download.as_str().context("invalid scrape download URL")?)?;
        anyhow::ensure!(
            matches!(url.scheme(), "http" | "https"),
            "scrape download requires an http(s) URL"
        );
        download_scrape(url, cache_file(cache_dir, ".md").await?, cancellation).await?
    } else {
        let markdown = fields
            .get("markdown")
            .and_then(Value::as_str)
            .context("scrape response is missing markdown")?;
        if !exceeds_inline_limit(markdown) {
            return Ok(result);
        }
        save_text(cache_dir, markdown, ".md", cancellation).await?
    };
    let path = temp.path().to_owned();
    let outline = super::convert::run_cancellable_blocking(cancellation, move || {
        Ok(markdown_outline(&String::from_utf8_lossy(&std::fs::read(
            path,
        )?)))
    })
    .await?;
    fields.remove("markdown");
    fields.insert(
        "savedTo".into(),
        Value::String(temp.path().display().to_string()),
    );
    fields.insert("outline".into(), outline);
    *saved_file = Some(temp);
    Ok(result)
}

/// Counts UTF-16 units to match the backend's `markdown.length`.
pub(super) fn exceeds_inline_limit(text: &str) -> bool {
    text.encode_utf16().count() > SCRAPE_INLINE_MAX_CHARS
}

#[derive(serde::Deserialize)]
struct FrontMatter {
    title: Option<String>,
    description: Option<String>,
}

/// Keeps every h1 and h2 before any h3, then every h3 before any h4, and so on, so a long page
/// loses its deepest headings rather than its last chapters.
/// Evicting while parsing keeps memory bounded on pages with millions of headings. Once a heading
/// is evicted, later headings of its rank or deeper can never fit either.
fn markdown_outline(markdown: &str) -> Value {
    let mut events =
        Parser::new_ext(markdown, Options::ENABLE_YAML_STYLE_METADATA_BLOCKS).peekable();
    let mut outline = json!({"headings": []});
    if matches!(events.peek(), Some(Event::Start(Tag::MetadataBlock(_)))) {
        let front_matter: String = events
            .by_ref()
            .skip(1)
            .map_while(|event| match event {
                Event::Text(text) => Some(text.into_string()),
                _ => None,
            })
            .collect();
        if let Ok(FrontMatter { title, description }) = serde_yaml_ng::from_str(&front_matter) {
            for (key, value, max_chars) in [
                ("title", title, OUTLINE_HEADING_MAX_CHARS),
                ("description", description, OUTLINE_DESCRIPTION_MAX_CHARS),
            ] {
                let value = clip(value.as_deref().unwrap_or_default().trim(), max_chars);
                if !value.is_empty() {
                    outline[key] = value.into();
                }
            }
        }
    }

    let budget = OUTLINE_MAX_CHARS.saturating_sub(json_chars(&outline));
    let mut used = 0;
    let mut kept: Vec<(u8, usize, Value, usize)> = Vec::new();
    let mut position = 0;
    let mut full_rank = u8::MAX;
    let mut heading = None;
    for event in events {
        let text = match event {
            Event::Start(Tag::Heading { level, .. }) => {
                heading = Some((level, String::new()));
                continue;
            }
            Event::End(TagEnd::Heading(_)) => {
                if let Some((level, text)) = heading.take() {
                    let level = level as u8;
                    let rank = level.max(2);
                    let text = clip(text.trim(), OUTLINE_HEADING_MAX_CHARS);
                    if rank < full_rank && !text.is_empty() {
                        let entry = json!({"level": level, "text": text});
                        let cost = json_chars(&entry) + 1;
                        let at = kept.partition_point(|&(kept_rank, ..)| kept_rank <= rank);
                        kept.insert(at, (rank, position, entry, cost));
                        position += 1;
                        used += cost;
                        while used > budget
                            && let Some((evicted_rank, .., cost)) = kept.pop()
                        {
                            used -= cost;
                            full_rank = evicted_rank;
                        }
                    }
                }
                continue;
            }
            Event::Text(text) | Event::Code(text) => text,
            Event::SoftBreak | Event::HardBreak => " ".into(),
            _ => continue,
        };
        if let Some((_, heading_text)) = heading.as_mut() {
            heading_text.push_str(&text);
        }
    }

    kept.sort_unstable_by_key(|&(_, position, ..)| position);
    outline["headings"] = kept.into_iter().map(|(_, _, entry, _)| entry).collect();
    outline
}

fn json_chars(value: &Value) -> usize {
    value.to_string().chars().count()
}

fn clip(text: &str, max_chars: usize) -> &str {
    text.char_indices()
        .nth(max_chars)
        .map_or(text, |(end, _)| &text[..end])
}

async fn cache_file(cache_dir: &Path, suffix: &str) -> anyhow::Result<tempfile::NamedTempFile> {
    tokio::fs::create_dir_all(cache_dir)
        .await
        .with_context(|| format!("failed to create {}", cache_dir.display()))?;
    Ok(tempfile::Builder::new()
        .prefix("")
        .suffix(suffix)
        .tempfile_in(cache_dir)?)
}

pub(super) async fn save_text(
    cache_dir: &Path,
    contents: &str,
    suffix: &str,
    cancellation: &WorkspaceCancellation,
) -> anyhow::Result<tempfile::NamedTempFile> {
    let temp = cache_file(cache_dir, suffix).await?;
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
