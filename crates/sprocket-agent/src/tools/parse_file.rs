use std::io::Read;
use std::path::{Path, PathBuf};

use anyhow::{Context, anyhow, bail};
use rig::message::MimeType;
use rig::tool::{ToolExecutionError, ToolOutput};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sprocket_workspace::WorkspaceCancellation;

use super::context::{AgentToolContext, tool_error};
use super::convert::{
    IMAGE_SNIFF_BYTES, LocalConversionFailed, ParseFilePersistedOutput, ParseFilePersistedSource,
    convert_document, ensure_not_cancelled, fit_image_for_model, persist_image_bytes, preview_text,
    read_file_bounded, read_image_bytes_bounded, replay_tool_output, run_cancellable_blocking,
    sniff_supported_image_format,
};
use super::hosted_parse::HostedParseContext;
use super::job::execute_tool_job_with_id;

pub(crate) const PARSE_FILE_TOOL_NAME: &str = "parse_file";
const MAX_PARSE_FILE_DOCUMENT_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Clone)]
pub(crate) struct ParseFileTool(pub(super) AgentToolContext);

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct ParseFileArgs {
    /// Relative or absolute path to the file
    pub path: String,
}

struct ParsedText {
    path: PathBuf,
    format: String,
    char_count: u64,
    preview: String,
    truncated: bool,
}

pub(crate) fn is_parse_file_tool(name: &str) -> bool {
    name == PARSE_FILE_TOOL_NAME
}

impl rig::tool::Tool for ParseFileTool {
    const NAME: &'static str = PARSE_FILE_TOOL_NAME;
    type Error = ToolExecutionError;
    type Args = ParseFileArgs;
    type Output = ToolOutput;

    fn description(&self) -> String {
        let docs = "Read a local file as text or an image. Supports jpeg, png, gif, webp, PDF, Word, PowerPoint, Excel, OpenDocument, RTF, EPUB, and CSV.";
        if self.0.supports_images {
            docs.to_string()
        } else {
            format!("{docs} This model can't view images, so image files fail.")
        }
    }

    fn parameters(&self) -> serde_json::Value {
        parse_file_parameters()
    }

    async fn call(
        &self,
        _context: &mut rig::tool::ToolContext,
        args: Self::Args,
    ) -> Result<Self::Output, Self::Error> {
        parse_file_args(&args).map_err(tool_error)?;
        let payload = serde_json::to_value(&args).map_err(|e| tool_error(e.into()))?;
        let cwd = self.0.cwd.get();
        let cache_dir = self.0.transcript_dir.join(Self::NAME);
        let supports_images = self.0.supports_images;
        let persisted = execute_tool_job_with_id(
            &self.0,
            Self::NAME,
            payload,
            |cancellation, job_id| async move {
                let hosted = HostedParseContext {
                    runtime: &self.0.runtime,
                    run_id: &self.0.run_id,
                    claim_id: &self.0.claim_id,
                    job_id: &job_id,
                };
                let output = persist_parse_file(
                    &cwd,
                    &cache_dir,
                    cancellation,
                    supports_images,
                    args,
                    Some(&hosted),
                )
                .await
                .map_err(tool_error)?;
                serde_json::to_value(output).map_err(|e| tool_error(e.into()))
            },
        )
        .await?;
        replay_tool_output(&persisted, Some(&self.0.image_urls()))
            .await
            .map_err(tool_error)
    }
}

fn parse_file_parameters() -> serde_json::Value {
    json!(schemars::schema_for!(ParseFileArgs))
}

fn parse_file_args(args: &ParseFileArgs) -> anyhow::Result<String> {
    let path = args.path.trim();
    anyhow::ensure!(!path.is_empty(), "provide a local path");
    reject_embedded_url_as_path(path)?;
    Ok(path.to_string())
}

fn reject_embedded_url_as_path(path: &str) -> anyhow::Result<()> {
    if let Ok(url) = reqwest::Url::parse(path) {
        match url.scheme() {
            "http" | "https" => bail!("path looks like a URL; use scrape_url for http(s) URLs"),
            "file" | "data" | "ftp" => bail!("pass a local filesystem path, not a URL"),
            _ => {}
        }
    }
    Ok(())
}

fn expand_user_path(path: &str) -> PathBuf {
    if let Some(home) = sprocket_workspace::home_dir() {
        if path == "~" {
            return home;
        }
        if let Some(rest) = path.strip_prefix("~/") {
            return home.join(rest);
        }
        if let Some(rest) = path.strip_prefix("~\\") {
            return home.join(rest);
        }
    }
    PathBuf::from(path)
}

fn resolve_local_path(workspace_root: &Path, path: &str) -> PathBuf {
    let expanded = expand_user_path(path);
    if expanded.is_absolute() {
        expanded
    } else {
        workspace_root.join(expanded)
    }
}

fn persist_parsed_text(
    cache_dir: &Path,
    text: &str,
    format: &str,
    cancellation: &WorkspaceCancellation,
) -> anyhow::Result<ParsedText> {
    ensure_not_cancelled(cancellation)?;
    anyhow::ensure!(
        !cache_dir.as_os_str().is_empty(),
        "parse_file cache directory is not configured"
    );
    std::fs::create_dir_all(cache_dir)
        .with_context(|| format!("failed to create {}", cache_dir.display()))?;
    let ext = if format == "text" { "txt" } else { "md" };
    let path = cache_dir.join(format!("{}.{}", uuid::Uuid::new_v4(), ext));
    let temp = tempfile::NamedTempFile::new_in(cache_dir)
        .with_context(|| format!("failed to stage text in {}", cache_dir.display()))?;
    std::fs::write(temp.path(), text)
        .with_context(|| format!("failed to write {}", temp.path().display()))?;
    ensure_not_cancelled(cancellation)?;
    temp.persist(&path)
        .map_err(|error| anyhow!("failed to persist {}: {error}", path.display()))?;
    let path = std::fs::canonicalize(&path)
        .with_context(|| format!("failed to resolve {}", path.display()))?;
    let (preview, truncated) = preview_text(text);
    Ok(ParsedText {
        path,
        format: format.to_string(),
        char_count: text.chars().count() as u64,
        preview,
        truncated,
    })
}

fn read_document_blocking(path: &Path) -> anyhow::Result<Vec<u8>> {
    let file =
        std::fs::File::open(path).with_context(|| format!("failed to open {}", path.display()))?;
    let metadata = file.metadata()?;
    anyhow::ensure!(metadata.is_file(), "{} is not a file", path.display());
    ensure_document_size(metadata.len())?;
    let mut bytes = Vec::new();
    file.take(MAX_PARSE_FILE_DOCUMENT_BYTES + 1)
        .read_to_end(&mut bytes)
        .with_context(|| format!("failed to read {}", path.display()))?;
    ensure_document_size(bytes.len() as u64)?;
    Ok(bytes)
}

async fn peek_file(path: &Path, cancellation: &WorkspaceCancellation) -> anyhow::Result<Vec<u8>> {
    read_file_bounded(path, IMAGE_SNIFF_BYTES as u64, cancellation).await
}

fn ensure_document_size(size: u64) -> anyhow::Result<()> {
    anyhow::ensure!(
        size <= MAX_PARSE_FILE_DOCUMENT_BYTES,
        "parse_file accepts at most 64 MiB per document; use shell tools for larger files. Attachment uploads are not limited"
    );
    Ok(())
}

async fn persist_image_file(
    path: &Path,
    source: ParseFilePersistedSource,
    cache_dir: &Path,
    cancellation: &WorkspaceCancellation,
) -> anyhow::Result<ParseFilePersistedOutput> {
    let bytes = read_image_bytes_bounded(path, cancellation).await?;
    ensure_not_cancelled(cancellation)?;
    let image = run_cancellable_blocking(cancellation, move || fit_image_for_model(bytes)).await?;
    ensure_not_cancelled(cancellation)?;
    let cached = persist_image_bytes(cache_dir, &image.bytes, &image.media_type).await?;
    Ok(ParseFilePersistedOutput::Image {
        media_type: image.media_type.to_mime_type().to_string(),
        path: cached.to_string_lossy().into_owned(),
        source,
        byte_size: image.bytes.len() as u64,
        width: image.width,
        height: image.height,
    })
}

async fn persist_non_image_file(
    path: PathBuf,
    source: ParseFilePersistedSource,
    cache_dir: PathBuf,
    cancellation: &WorkspaceCancellation,
    hosted: Option<&HostedParseContext<'_>>,
) -> anyhow::Result<ParseFilePersistedOutput> {
    let local = convert_local_file(path.clone(), cache_dir.clone(), cancellation, hosted).await;
    let parsed = if let Some(hosted) = hosted {
        local_or_hosted(local, cache_dir, cancellation, || {
            super::hosted_parse::parse(hosted, &path, &path, cancellation)
        })
        .await?
    } else {
        local?
    };
    Ok(ParseFilePersistedOutput::Text {
        path: parsed.path.to_string_lossy().into_owned(),
        source,
        format: parsed.format,
        char_count: parsed.char_count,
        preview: parsed.preview,
        truncated: parsed.truncated,
    })
}

async fn convert_local_file(
    path: PathBuf,
    cache_dir: PathBuf,
    cancellation: &WorkspaceCancellation,
    hosted: Option<&HostedParseContext<'_>>,
) -> anyhow::Result<ParsedText> {
    let worker_path = path.clone();
    let bytes =
        run_cancellable_blocking(cancellation, move || read_document_blocking(&worker_path))
            .await?;
    let (text, format) = convert_document(bytes, path, None, hosted, cancellation).await?;
    let worker_cancellation = cancellation.clone();
    run_cancellable_blocking(cancellation, move || {
        persist_parsed_text(&cache_dir, &text, format, &worker_cancellation)
    })
    .await
}

async fn local_or_hosted<F, Fut>(
    local: anyhow::Result<ParsedText>,
    cache_dir: PathBuf,
    cancellation: &WorkspaceCancellation,
    fallback: F,
) -> anyhow::Result<ParsedText>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = anyhow::Result<String>>,
{
    let error = match local {
        Ok(parsed) => return Ok(parsed),
        Err(error) if error.is::<LocalConversionFailed>() => error,
        Err(error) => return Err(error),
    };
    ensure_not_cancelled(cancellation)?;
    let markdown = fallback()
        .await
        .with_context(|| format!("local conversion failed: {error}; hosted fallback failed"))?;
    let worker_cancellation = cancellation.clone();
    run_cancellable_blocking(cancellation, move || {
        persist_parsed_text(&cache_dir, &markdown, "firecrawl", &worker_cancellation)
    })
    .await
}

async fn persist_parse_file(
    workspace_root: &Path,
    cache_dir: &Path,
    cancellation: WorkspaceCancellation,
    supports_images: bool,
    args: ParseFileArgs,
    hosted: Option<&HostedParseContext<'_>>,
) -> anyhow::Result<ParseFilePersistedOutput> {
    let path = parse_file_args(&args)?;
    ensure_not_cancelled(&cancellation)?;
    let file_path = resolve_local_path(workspace_root, &path);
    let source = ParseFilePersistedSource::Path { path };
    let prefix = peek_file(&file_path, &cancellation).await?;
    if sniff_supported_image_format(&prefix).is_some() {
        anyhow::ensure!(
            supports_images,
            "the selected model does not support images; parse_file can still convert documents and UTF-8 text"
        );
        persist_image_file(&file_path, source, cache_dir, &cancellation).await
    } else {
        persist_non_image_file(
            file_path,
            source,
            cache_dir.to_path_buf(),
            &cancellation,
            hosted,
        )
        .await
    }
}

#[cfg(test)]
mod tests;
