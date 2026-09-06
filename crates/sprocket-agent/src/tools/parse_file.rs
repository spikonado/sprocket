use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, anyhow, bail};
use base64::Engine;
use rig::message::{ImageMediaType, MimeType, ToolResultContent};
use rig::tool::{ToolExecutionError, ToolOutput};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sprocket_workspace::{WorkspaceCancellation, WorkspaceOperationCancelled};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::context::{AgentToolContext, tool_error};
use super::job::execute_tool_job;
use crate::types::AgentHistoryToolResultItem;

pub(crate) const PARSE_FILE_TOOL_NAME: &str = "parse_file";

/// Encoded-image ceiling for model input. Attachment files have no size cap;
/// this bound applies only when `parse_file` decodes image bytes for the model.
pub(crate) const MAX_PARSE_FILE_IMAGE_BYTES: usize = 20 * 1024 * 1024;
pub(crate) const MAX_PARSE_FILE_IMAGE_DIMENSION: u32 = 8192;
pub(crate) const MAX_PARSE_FILE_IMAGE_PIXELS: u32 = 36_000_000;
pub(crate) const MAX_PARSE_FILE_PREVIEW_CHARS: usize = 20_000;
const MAX_PARSE_FILE_DOCUMENT_BYTES: u64 = 64 * 1024 * 1024;

const PARSE_FILE_HTTP_TIMEOUT: Duration = Duration::from_secs(60);
const IMAGE_SNIFF_BYTES: usize = 16;

#[derive(Clone)]
pub(crate) struct ParseFileTool(pub(super) AgentToolContext);

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
pub(crate) struct ParseFileArgs {
    /// Local filesystem path. Provide this or `url`, not both.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// http(s) URL. Provide this or `path`, not both.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum ParseFileRequest {
    Path(String),
    Url(String),
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "outputType",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum ParseFilePersistedOutput {
    Image {
        media_type: String,
        path: String,
        source: ParseFilePersistedSource,
        #[serde(deserialize_with = "sprocket_convex::deserialize_convex_u64")]
        byte_size: u64,
        #[serde(deserialize_with = "sprocket_convex::deserialize_convex_u32")]
        width: u32,
        #[serde(deserialize_with = "sprocket_convex::deserialize_convex_u32")]
        height: u32,
    },
    Text {
        path: String,
        source: ParseFilePersistedSource,
        format: String,
        #[serde(deserialize_with = "sprocket_convex::deserialize_convex_u64")]
        char_count: u64,
        preview: String,
        truncated: bool,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum ParseFilePersistedSource {
    Url { url: String },
    Path { path: String },
}

struct ParsedText {
    path: PathBuf,
    format: String,
    char_count: u64,
    preview: String,
    truncated: bool,
}

pub(crate) fn parse_file_cache_dir(thread_dir: impl AsRef<Path>) -> PathBuf {
    thread_dir.as_ref().join("parse_file")
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
        let docs = "Parse a local file or http(s) URL, up to 64 MiB. Converts Word, PowerPoint, Excel, OpenDocument, RTF, EPUB, CSV, and PDF to Markdown, and returns UTF-8 text for source and other text files. Provide exactly one of path or url. Larger attachments remain available to shell tools.";
        if self.0.supports_images {
            format!(
                "{docs} jpeg, png, gif, and webp are returned as the image itself; images larger than 20 MiB or 8192 px on a side are rejected."
            )
        } else {
            format!("{docs} This model cannot view images; image files are rejected.")
        }
    }

    fn parameters(&self) -> serde_json::Value {
        json!(schemars::schema_for!(ParseFileArgs))
    }

    async fn call(
        &self,
        _context: &mut rig::tool::ToolContext,
        args: Self::Args,
    ) -> Result<Self::Output, Self::Error> {
        parse_file_args(&args).map_err(tool_error)?;
        let payload = serde_json::to_value(&args).map_err(|e| tool_error(e.into()))?;
        let workspace_root = self.0.workspace_root.clone();
        let cache_dir = self.0.parse_file_cache_dir.clone();
        let supports_images = self.0.supports_images;
        let persisted = execute_tool_job(
            &self.0.runtime,
            &self.0.run_id,
            &self.0.claim_id,
            Self::NAME,
            &self.0.tool_call_tracker,
            payload,
            |cancellation| async move {
                let output = fetch_and_persist_parse_file(
                    &workspace_root,
                    &cache_dir,
                    cancellation,
                    supports_images,
                    args,
                )
                .await
                .map_err(tool_error)?;
                serde_json::to_value(output).map_err(|e| tool_error(e.into()))
            },
        )
        .await?;
        replay_parse_file_tool_output(&persisted)
            .await
            .map_err(tool_error)
    }
}

fn parse_file_args(args: &ParseFileArgs) -> anyhow::Result<ParseFileRequest> {
    match (
        args.path
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty()),
        args.url.as_deref().map(str::trim).filter(|s| !s.is_empty()),
    ) {
        (Some(path), None) => {
            reject_embedded_url_as_path(path)?;
            Ok(ParseFileRequest::Path(path.to_string()))
        }
        (None, Some(url)) => Ok(ParseFileRequest::Url(validate_http_url(url)?.to_string())),
        (Some(_), Some(_)) => bail!("provide exactly one of path or url"),
        (None, None) => bail!("provide a local path or an http(s) url"),
    }
}

fn reject_embedded_url_as_path(path: &str) -> anyhow::Result<()> {
    if let Ok(url) = reqwest::Url::parse(path) {
        if matches!(url.scheme(), "http" | "https" | "file" | "data" | "ftp") {
            bail!("path looks like a URL; pass it as url instead");
        }
    }
    Ok(())
}

fn ensure_not_cancelled(cancellation: &WorkspaceCancellation) -> anyhow::Result<()> {
    if cancellation.is_cancelled() {
        Err(WorkspaceOperationCancelled.into())
    } else {
        Ok(())
    }
}

fn validate_http_url(url: &str) -> anyhow::Result<reqwest::Url> {
    let parsed = reqwest::Url::parse(url).context("invalid file URL")?;
    match parsed.scheme() {
        "http" | "https" => Ok(parsed),
        "file" => bail!("file:// URLs are not supported; pass a local path"),
        "data" => bail!("data: URLs are not supported; pass a local path or http(s) URL"),
        other => bail!("unsupported URL scheme {other}; use http(s) or a local path"),
    }
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

fn url_filename(url: &reqwest::Url) -> PathBuf {
    url.path_segments()
        .and_then(|mut segments| segments.next_back())
        .filter(|name| !name.is_empty())
        .map(PathBuf::from)
        .unwrap_or_default()
}

fn url_suffix(url: &reqwest::Url) -> String {
    url_filename(url)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| format!(".{ext}"))
        .unwrap_or_default()
}

fn ensure_image_within_model_bounds(width: u32, height: u32, byte_len: u64) -> anyhow::Result<()> {
    anyhow::ensure!(
        byte_len <= MAX_PARSE_FILE_IMAGE_BYTES as u64,
        "image is {byte_len} bytes; parse_file accepts at most {MAX_PARSE_FILE_IMAGE_BYTES} bytes for images"
    );
    anyhow::ensure!(width > 0 && height > 0, "image has no pixels");
    anyhow::ensure!(
        width <= MAX_PARSE_FILE_IMAGE_DIMENSION && height <= MAX_PARSE_FILE_IMAGE_DIMENSION,
        "image is {width}x{height}; each side must be at most {MAX_PARSE_FILE_IMAGE_DIMENSION}"
    );
    let pixels = u64::from(width).saturating_mul(u64::from(height));
    anyhow::ensure!(
        pixels <= u64::from(MAX_PARSE_FILE_IMAGE_PIXELS),
        "image is {width}x{height}; parse_file accepts at most {MAX_PARSE_FILE_IMAGE_PIXELS} pixels"
    );
    Ok(())
}

fn sniff_supported_image_format(bytes: &[u8]) -> Option<image::ImageFormat> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        return Some(image::ImageFormat::Png);
    }
    if bytes.len() >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF {
        return Some(image::ImageFormat::Jpeg);
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some(image::ImageFormat::Gif);
    }
    if bytes.len() >= 12 && bytes[..4] == *b"RIFF" && bytes[8..12] == *b"WEBP" {
        return Some(image::ImageFormat::WebP);
    }
    None
}

fn image_media_type(format: image::ImageFormat) -> anyhow::Result<ImageMediaType> {
    match format {
        image::ImageFormat::Png => Ok(ImageMediaType::PNG),
        image::ImageFormat::Jpeg => Ok(ImageMediaType::JPEG),
        image::ImageFormat::Gif => Ok(ImageMediaType::GIF),
        image::ImageFormat::WebP => Ok(ImageMediaType::WEBP),
        other => bail!("unsupported image format {other:?}; use jpeg, png, gif, or webp"),
    }
}

fn decode_image_info(bytes: &[u8]) -> anyhow::Result<(ImageMediaType, u32, u32)> {
    anyhow::ensure!(!bytes.is_empty(), "image is empty");
    anyhow::ensure!(
        bytes.len() <= MAX_PARSE_FILE_IMAGE_BYTES,
        "image is {} bytes; parse_file accepts at most {MAX_PARSE_FILE_IMAGE_BYTES} bytes for images",
        bytes.len()
    );
    let format = sniff_supported_image_format(bytes)
        .ok_or_else(|| anyhow!("unknown image format; use jpeg, png, gif, or webp"))?;
    let media_type = image_media_type(format)?;
    let mut reader = image::ImageReader::new(Cursor::new(bytes));
    reader.set_format(format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_PARSE_FILE_IMAGE_DIMENSION);
    limits.max_image_height = Some(MAX_PARSE_FILE_IMAGE_DIMENSION);
    limits.max_alloc = Some(u64::from(MAX_PARSE_FILE_IMAGE_PIXELS).saturating_mul(4));
    reader.limits(limits);
    let (width, height) = reader
        .into_dimensions()
        .context("failed to decode image header")?;
    ensure_image_within_model_bounds(width, height, bytes.len() as u64)?;
    Ok((media_type, width, height))
}

fn media_type_extension(media_type: &ImageMediaType) -> &'static str {
    match media_type {
        ImageMediaType::JPEG => "jpg",
        ImageMediaType::PNG => "png",
        ImageMediaType::GIF => "gif",
        ImageMediaType::WEBP => "webp",
        ImageMediaType::HEIC => "heic",
        ImageMediaType::HEIF => "heif",
        ImageMediaType::SVG => "svg",
    }
}

fn anydoc_format_name(format: anydoc::Format) -> &'static str {
    match format {
        anydoc::Format::Doc => "doc",
        anydoc::Format::Docx => "docx",
        anydoc::Format::Odt => "odt",
        anydoc::Format::Pdf => "pdf",
        anydoc::Format::Ppt => "ppt",
        anydoc::Format::Pptx => "pptx",
        anydoc::Format::Rtf => "rtf",
        anydoc::Format::Epub => "epub",
        anydoc::Format::Excel => "excel",
        anydoc::Format::Ods => "ods",
        anydoc::Format::Odp => "odp",
        anydoc::Format::Csv => "csv",
    }
}

fn detect_anydoc_format(bytes: &[u8], path: &Path, name_hint: &Path) -> Option<anydoc::Format> {
    anydoc::Format::from_bytes(bytes)
        .or_else(|| anydoc::Format::from_path(path))
        .or_else(|| anydoc::Format::from_path(name_hint))
}

fn ocr_unavailable_message(detail: impl std::fmt::Display) -> String {
    format!(
        "{detail}. parse_file converts PDFs locally and does not run OCR, and it will not send the file to a hosted OCR service"
    )
}

fn map_anydoc_error(error: anydoc::ConvertError) -> anyhow::Error {
    match &error {
        anydoc::ConvertError::NeedsOcr { .. } => anyhow!("{}", ocr_unavailable_message(&error)),
        _ => error.into(),
    }
}

fn preview_text(text: &str) -> (String, bool) {
    let total = text.chars().count();
    if total <= MAX_PARSE_FILE_PREVIEW_CHARS {
        (text.to_string(), false)
    } else {
        (
            text.chars().take(MAX_PARSE_FILE_PREVIEW_CHARS).collect(),
            true,
        )
    }
}

fn model_text(preview: &str, truncated: bool, char_count: u64, path: &str) -> String {
    if !truncated {
        return preview.to_string();
    }
    format!("{preview}\n\n...[truncated] full parsed text is {char_count} characters at {path}")
}

fn unsupported_file_error() -> anyhow::Error {
    anyhow!(
        "unsupported file; parse_file reads jpeg, png, gif, webp, office documents (Word, PowerPoint, Excel, OpenDocument, RTF, EPUB, CSV, PDF), and UTF-8 text"
    )
}

fn tool_output_from_image_bytes(bytes: &[u8], media_type: ImageMediaType) -> ToolOutput {
    ToolOutput::one(ToolResultContent::image_base64(
        base64::engine::general_purpose::STANDARD.encode(bytes),
        Some(media_type),
        None,
    ))
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

fn convert_non_image_blocking(
    path: PathBuf,
    name_hint: PathBuf,
    cache_dir: PathBuf,
    cancellation: WorkspaceCancellation,
) -> anyhow::Result<ParsedText> {
    ensure_not_cancelled(&cancellation)?;
    let file =
        std::fs::File::open(&path).with_context(|| format!("failed to open {}", path.display()))?;
    let metadata = file.metadata()?;
    anyhow::ensure!(metadata.is_file(), "{} is not a file", path.display());
    ensure_document_size(metadata.len())?;
    let mut bytes = Vec::new();
    file.take(MAX_PARSE_FILE_DOCUMENT_BYTES + 1)
        .read_to_end(&mut bytes)
        .with_context(|| format!("failed to read {}", path.display()))?;
    ensure_document_size(bytes.len() as u64)?;
    ensure_not_cancelled(&cancellation)?;
    anyhow::ensure!(!bytes.is_empty(), "file is empty");
    if let Some(format) = detect_anydoc_format(&bytes, &path, &name_hint) {
        let markdown = anydoc::to_markdown_bytes(&bytes, format).map_err(map_anydoc_error)?;
        return persist_parsed_text(
            &cache_dir,
            &markdown,
            anydoc_format_name(format),
            &cancellation,
        );
    }
    let text = String::from_utf8(bytes).map_err(|_| unsupported_file_error())?;
    if text.contains('\0') {
        return Err(unsupported_file_error());
    }
    persist_parsed_text(&cache_dir, &text, "text", &cancellation)
}

async fn persist_image_bytes(
    cache_dir: &Path,
    bytes: &[u8],
    media_type: &ImageMediaType,
) -> anyhow::Result<PathBuf> {
    anyhow::ensure!(
        !cache_dir.as_os_str().is_empty(),
        "parse_file cache directory is not configured"
    );
    tokio::fs::create_dir_all(cache_dir)
        .await
        .with_context(|| format!("failed to create {}", cache_dir.display()))?;
    let filename = format!(
        "{}.{}",
        uuid::Uuid::new_v4(),
        media_type_extension(media_type)
    );
    let path = cache_dir.join(filename);
    let temp = tempfile::NamedTempFile::new_in(cache_dir)
        .with_context(|| format!("failed to stage image in {}", cache_dir.display()))?;
    tokio::fs::write(temp.path(), bytes)
        .await
        .with_context(|| format!("failed to write {}", temp.path().display()))?;
    temp.persist(&path)
        .map_err(|error| anyhow!("failed to persist {}: {error}", path.display()))?;
    tokio::fs::canonicalize(&path)
        .await
        .with_context(|| format!("failed to resolve {}", path.display()))
}

async fn read_image_bytes_bounded(
    path: &Path,
    cancellation: &WorkspaceCancellation,
) -> anyhow::Result<Vec<u8>> {
    ensure_not_cancelled(cancellation)?;
    let file = tokio::fs::File::open(path)
        .await
        .with_context(|| format!("failed to open {}", path.display()))?;
    let metadata = file
        .metadata()
        .await
        .with_context(|| format!("failed to stat {}", path.display()))?;
    anyhow::ensure!(metadata.is_file(), "{} is not a file", path.display());
    let mut limited = file.take(MAX_PARSE_FILE_IMAGE_BYTES as u64 + 1);
    let mut bytes = Vec::new();
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err(WorkspaceOperationCancelled.into()),
        result = limited.read_to_end(&mut bytes) => {
            result.with_context(|| format!("failed to read {}", path.display()))?;
            anyhow::ensure!(
                bytes.len() <= MAX_PARSE_FILE_IMAGE_BYTES,
                "image is {} bytes; parse_file accepts at most {MAX_PARSE_FILE_IMAGE_BYTES} bytes for images",
                bytes.len()
            );
            Ok(bytes)
        }
    }
}

async fn peek_file(path: &Path, cancellation: &WorkspaceCancellation) -> anyhow::Result<Vec<u8>> {
    ensure_not_cancelled(cancellation)?;
    let file = tokio::fs::File::open(path)
        .await
        .with_context(|| format!("failed to open {}", path.display()))?;
    let metadata = file
        .metadata()
        .await
        .with_context(|| format!("failed to stat {}", path.display()))?;
    anyhow::ensure!(metadata.is_file(), "{} is not a file", path.display());
    let mut limited = file.take(IMAGE_SNIFF_BYTES as u64);
    let mut bytes = Vec::new();
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err(WorkspaceOperationCancelled.into()),
        result = limited.read_to_end(&mut bytes) => {
            result.with_context(|| format!("failed to read {}", path.display()))?;
            Ok(bytes)
        }
    }
}

fn http_client() -> anyhow::Result<reqwest::Client> {
    reqwest::Client::builder()
        .no_proxy()
        .timeout(PARSE_FILE_HTTP_TIMEOUT)
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .context("failed to build parse_file HTTP client")
}

fn ensure_document_size(size: u64) -> anyhow::Result<()> {
    anyhow::ensure!(
        size <= MAX_PARSE_FILE_DOCUMENT_BYTES,
        "parse_file accepts at most 64 MiB per document or download; use shell tools for larger files. Attachment uploads are not limited"
    );
    Ok(())
}

async fn stream_http_to_path(
    client: reqwest::Client,
    url: reqwest::Url,
    path: &Path,
    cancellation: &WorkspaceCancellation,
) -> anyhow::Result<()> {
    let mut response = client
        .get(url.clone())
        .send()
        .await
        .with_context(|| format!("failed to fetch {url}"))?
        .error_for_status()
        .with_context(|| format!("file URL returned an error status: {url}"))?;
    if let Some(size) = response.content_length() {
        ensure_document_size(size)?;
    }
    let mut file = tokio::fs::File::create(path)
        .await
        .with_context(|| format!("failed to create {}", path.display()))?;
    let mut received = 0u64;
    loop {
        ensure_not_cancelled(cancellation)?;
        let chunk = tokio::select! {
            biased;
            _ = cancellation.cancelled() => {
                return Err(WorkspaceOperationCancelled.into());
            }
            chunk = response.chunk() => {
                chunk.context("failed to read file body")?
            }
        };
        let Some(chunk) = chunk else {
            break;
        };
        received = received.saturating_add(chunk.len() as u64);
        ensure_document_size(received)?;
        file.write_all(&chunk)
            .await
            .with_context(|| format!("failed to write {}", path.display()))?;
    }
    file.flush()
        .await
        .with_context(|| format!("failed to flush {}", path.display()))?;
    file.sync_all()
        .await
        .with_context(|| format!("failed to sync {}", path.display()))?;
    Ok(())
}

async fn download_http_to_temp(
    url: reqwest::Url,
    cancellation: &WorkspaceCancellation,
) -> anyhow::Result<tempfile::NamedTempFile> {
    ensure_not_cancelled(cancellation)?;
    let suffix = url_suffix(&url);
    let mut builder = tempfile::Builder::new();
    builder.prefix("sprocket-parse-file-");
    if !suffix.is_empty() {
        builder.suffix(&suffix);
    }
    let temp = builder
        .tempfile()
        .context("failed to create parse_file download tempfile")?;
    let client = http_client()?;
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err(WorkspaceOperationCancelled.into()),
        result = stream_http_to_path(client, url, temp.path(), cancellation) => {
            result?;
            Ok(temp)
        }
    }
}

async fn run_cancellable_blocking<T: Send + 'static>(
    cancellation: &WorkspaceCancellation,
    work: impl FnOnce() -> anyhow::Result<T> + Send + 'static,
) -> anyhow::Result<T> {
    ensure_not_cancelled(cancellation)?;
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err(WorkspaceOperationCancelled.into()),
        result = tokio::task::spawn_blocking(work) => {
            result.context("parse_file worker failed")?
        }
    }
}

async fn persist_image_file(
    path: &Path,
    source: ParseFilePersistedSource,
    cache_dir: &Path,
    cancellation: &WorkspaceCancellation,
) -> anyhow::Result<ParseFilePersistedOutput> {
    let bytes = read_image_bytes_bounded(path, cancellation).await?;
    ensure_not_cancelled(cancellation)?;
    let (media_type, width, height) = decode_image_info(&bytes)?;
    ensure_not_cancelled(cancellation)?;
    let cached = persist_image_bytes(cache_dir, &bytes, &media_type).await?;
    Ok(ParseFilePersistedOutput::Image {
        media_type: media_type.to_mime_type().to_string(),
        path: cached.to_string_lossy().into_owned(),
        source,
        byte_size: bytes.len() as u64,
        width,
        height,
    })
}

async fn persist_non_image_file(
    path: PathBuf,
    name_hint: PathBuf,
    source: ParseFilePersistedSource,
    cache_dir: PathBuf,
    cancellation: &WorkspaceCancellation,
) -> anyhow::Result<ParseFilePersistedOutput> {
    let worker_cancellation = cancellation.clone();
    let parsed = run_cancellable_blocking(cancellation, move || {
        convert_non_image_blocking(path, name_hint, cache_dir, worker_cancellation)
    })
    .await?;
    Ok(ParseFilePersistedOutput::Text {
        path: parsed.path.to_string_lossy().into_owned(),
        source,
        format: parsed.format,
        char_count: parsed.char_count,
        preview: parsed.preview,
        truncated: parsed.truncated,
    })
}

async fn fetch_and_persist_parse_file(
    workspace_root: &Path,
    cache_dir: &Path,
    cancellation: WorkspaceCancellation,
    supports_images: bool,
    args: ParseFileArgs,
) -> anyhow::Result<ParseFilePersistedOutput> {
    let request = parse_file_args(&args)?;
    ensure_not_cancelled(&cancellation)?;
    let (file_path, name_hint, source, _temp) = match request {
        ParseFileRequest::Path(path) => {
            let resolved = resolve_local_path(workspace_root, &path);
            (
                resolved.clone(),
                resolved,
                ParseFilePersistedSource::Path { path },
                None,
            )
        }
        ParseFileRequest::Url(url) => {
            let parsed = validate_http_url(&url)?;
            let name_hint = url_filename(&parsed);
            let temp = download_http_to_temp(parsed, &cancellation).await?;
            let file_path = temp.path().to_path_buf();
            (
                file_path,
                name_hint,
                ParseFilePersistedSource::Url { url },
                Some(temp),
            )
        }
    };
    ensure_not_cancelled(&cancellation)?;
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
            name_hint,
            source,
            cache_dir.to_path_buf(),
            &cancellation,
        )
        .await
    }
}

async fn replay_image_output(
    media_type: &str,
    path: &str,
    byte_size: u64,
    width: u32,
    height: u32,
) -> anyhow::Result<ToolOutput> {
    anyhow::ensure!(
        !path.is_empty(),
        "parse_file tool output is missing a cached path"
    );
    let bytes = read_image_bytes_bounded(Path::new(path), &WorkspaceCancellation::new())
        .await
        .with_context(|| format!("failed to read cached image {path}"))?;
    let media_type = ImageMediaType::from_mime_type(media_type)
        .ok_or_else(|| anyhow!("parse_file tool output has unsupported media type {media_type}"))?;
    let (decoded_type, decoded_width, decoded_height) = decode_image_info(&bytes)?;
    anyhow::ensure!(
        decoded_type == media_type
            && decoded_width == width
            && decoded_height == height
            && bytes.len() as u64 == byte_size,
        "cached image {path} does not match persisted metadata"
    );
    Ok(tool_output_from_image_bytes(&bytes, media_type))
}

async fn replay_text_output(
    path: &str,
    preview: &str,
    truncated: bool,
    char_count: u64,
) -> anyhow::Result<ToolOutput> {
    anyhow::ensure!(
        !path.is_empty(),
        "parse_file tool output is missing a cached path"
    );
    let exists = tokio::fs::try_exists(path)
        .await
        .with_context(|| format!("failed to read cached text {path}"))?;
    anyhow::ensure!(exists, "failed to read cached text {path}");
    Ok(ToolOutput::text(model_text(
        preview, truncated, char_count, path,
    )))
}

/// Rebuild the model-visible Rig output from persisted metadata plus the local cache file.
/// Missing cache is an error so the caller can fall back to text; this never fetches `source`.
pub(crate) async fn replay_parse_file_tool_output(
    output: &serde_json::Value,
) -> anyhow::Result<ToolOutput> {
    let persisted: ParseFilePersistedOutput = serde_json::from_value(output.clone())
        .context("parse_file tool output is not replay metadata")?;
    match persisted {
        ParseFilePersistedOutput::Image {
            media_type,
            path,
            byte_size,
            width,
            height,
            ..
        } => replay_image_output(&media_type, &path, byte_size, width, height).await,
        ParseFilePersistedOutput::Text {
            path,
            preview,
            truncated,
            char_count,
            ..
        } => replay_text_output(&path, &preview, truncated, char_count).await,
    }
}

pub(crate) async fn replay_parse_file_history_items(
    output: &serde_json::Value,
) -> anyhow::Result<Vec<AgentHistoryToolResultItem>> {
    let tool_output = replay_parse_file_tool_output(output).await?;
    tool_output
        .into_content()
        .into_iter()
        .map(|content| match content {
            ToolResultContent::Image(image) => Ok(AgentHistoryToolResultItem::Image {
                image_json: serde_json::to_string(&image)
                    .context("failed to serialize replayed image")?,
            }),
            ToolResultContent::Text(text) => {
                Ok(AgentHistoryToolResultItem::Text { text: text.text })
            }
            ToolResultContent::Json { value } => Ok(AgentHistoryToolResultItem::Text {
                text: value.to_string(),
            }),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replay_metadata_accepts_convex_float_numbers() {
        let output: ParseFilePersistedOutput = serde_json::from_value(json!({
            "outputType": "image", "mediaType": "image/png", "path": "/cache/image.png",
            "source": { "type": "path", "path": "image.png" },
            "byteSize": 123.0, "width": 1.0, "height": 2.0
        }))
        .unwrap();
        assert!(matches!(
            output,
            ParseFilePersistedOutput::Image {
                byte_size: 123,
                width: 1,
                height: 2,
                ..
            }
        ));
    }
    use rig::message::{DocumentSourceKind, ToolResultContent};
    use sprocket_workspace::{WorkspaceCancellation, WorkspaceOperationCancelled};
    use std::io::{Read, Write};
    use std::net::TcpListener;

    const SAMPLE_RTF: &str = "{\\rtf1\\ansi\\ansicpg1252\\deff0\n{\\fonttbl{\\f0\\fcharset0 Arial;}}\n{\\stylesheet{\\s0 Normal;}}\n\\pard\\plain\\s0 Body before.\\par\n\\pard\\plain\\s0 Hello from RTF.\\par\n}\n"; // codespell:ignore pard
    const SAMPLE_CSV: &str = "name,qty\nwidget,2\ngadget,9\n";

    fn tiny_png() -> Vec<u8> {
        let mut bytes = Vec::new();
        image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(1, 1, image::Rgb([255, 0, 0])))
            .write_to(&mut Cursor::new(&mut bytes), image::ImageFormat::Png)
            .expect("encode png");
        bytes
    }

    fn tiny_jpeg() -> Vec<u8> {
        let mut bytes = Vec::new();
        image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(1, 1, image::Rgb([0, 255, 0])))
            .write_to(&mut Cursor::new(&mut bytes), image::ImageFormat::Jpeg)
            .expect("encode jpeg");
        bytes
    }

    fn temp_dir(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "sprocket-parse-file-{label}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&path).expect("temp dir");
        path
    }

    fn serve_bytes_once(
        status_line: &str,
        content_type: &str,
        body: &[u8],
        url_path: &str,
    ) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("listener");
        let addr = listener.local_addr().expect("addr");
        let status_line = status_line.to_string();
        let content_type = content_type.to_string();
        let body = body.to_vec();
        std::thread::spawn(move || {
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
            let mut buf = [0u8; 1024];
            let _ = stream.read(&mut buf);
            let header = format!(
                "{status_line}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(header.as_bytes());
            let _ = stream.write_all(&body);
        });
        format!("http://{addr}{url_path}")
    }

    fn assert_png_image_output(output: &ToolOutput, png: &[u8]) {
        match output.as_content() {
            [ToolResultContent::Image(image)] => {
                assert_eq!(image.media_type, Some(ImageMediaType::PNG));
                match &image.data {
                    DocumentSourceKind::Base64(data) => {
                        assert_eq!(
                            base64::engine::general_purpose::STANDARD
                                .decode(data)
                                .expect("base64"),
                            png
                        );
                    }
                    other => panic!("expected base64 image, got {other:?}"),
                }
            }
            other => panic!("expected one Rig image block, got {other:?}"),
        }
    }

    fn assert_text_contains(output: &ToolOutput, needle: &str) {
        match output.as_content() {
            [ToolResultContent::Text(text)] => {
                assert!(
                    text.text.contains(needle),
                    "expected {needle:?} in {}",
                    text.text
                );
            }
            other => panic!("expected one text block, got {other:?}"),
        }
    }

    async fn persist(
        workspace: &Path,
        cache: &Path,
        args: ParseFileArgs,
    ) -> anyhow::Result<ParseFilePersistedOutput> {
        persist_with_images(workspace, cache, true, args).await
    }

    async fn persist_with_images(
        workspace: &Path,
        cache: &Path,
        supports_images: bool,
        args: ParseFileArgs,
    ) -> anyhow::Result<ParseFilePersistedOutput> {
        fetch_and_persist_parse_file(
            workspace,
            cache,
            WorkspaceCancellation::new(),
            supports_images,
            args,
        )
        .await
    }

    #[test]
    fn args_require_exactly_one_source() {
        let neither = parse_file_args(&ParseFileArgs {
            path: None,
            url: None,
        })
        .expect_err("empty");
        assert!(neither.to_string().contains("path or an http"));

        let both = parse_file_args(&ParseFileArgs {
            path: Some("/tmp/a.png".into()),
            url: Some("https://example.com/a.png".into()),
        })
        .expect_err("both");
        assert!(both.to_string().contains("exactly one"));

        let url = parse_file_args(&ParseFileArgs {
            path: None,
            url: Some("https://example.com/a.png".into()),
        })
        .expect("url");
        assert_eq!(
            url,
            ParseFileRequest::Url("https://example.com/a.png".into())
        );

        let path = parse_file_args(&ParseFileArgs {
            path: Some("shots/a.png".into()),
            url: None,
        })
        .expect("path");
        assert_eq!(path, ParseFileRequest::Path("shots/a.png".into()));
    }

    #[test]
    fn rejects_non_http_urls_and_url_shaped_paths() {
        let file = validate_http_url("file:///tmp/a.png").expect_err("file");
        assert!(file.to_string().contains("file://"));
        let data = validate_http_url("data:image/png;base64,aaa").expect_err("data");
        assert!(data.to_string().contains("data:"));
        let ftp = validate_http_url("ftp://example.com/a.png").expect_err("ftp");
        assert!(ftp.to_string().contains("ftp"));
        let as_path = parse_file_args(&ParseFileArgs {
            path: Some("https://example.com/a.png".into()),
            url: None,
        })
        .expect_err("url as path");
        assert!(as_path.to_string().contains("url instead"));
    }

    #[test]
    fn windows_drive_path_is_not_treated_as_a_url() {
        let parsed = parse_file_args(&ParseFileArgs {
            path: Some(r"C:\Users\me\shot.png".into()),
            url: None,
        })
        .expect("drive path");
        assert_eq!(
            parsed,
            ParseFileRequest::Path(r"C:\Users\me\shot.png".into())
        );
    }

    #[test]
    fn decode_sniffs_magic_and_rejects_unknown_or_truncated_headers() {
        let png = tiny_png();
        let (media_type, width, height) = decode_image_info(&png).expect("png");
        assert_eq!(media_type, ImageMediaType::PNG);
        assert_eq!((width, height), (1, 1));

        let jpeg = tiny_jpeg();
        let (media_type, _, _) = decode_image_info(&jpeg).expect("jpeg");
        assert_eq!(media_type, ImageMediaType::JPEG);

        let text = decode_image_info(b"not an image").expect_err("text");
        assert!(text.to_string().contains("unknown image format"), "{text}");

        let bmp = decode_image_info(b"BM\0\0\0\0\0\0\0\0\0\0").expect_err("bmp");
        assert!(bmp.to_string().contains("unknown image format"), "{bmp}");

        let truncated = decode_image_info(&png[..8]).expect_err("truncated png");
        assert!(
            truncated.to_string().contains("header") || truncated.to_string().contains("format"),
            "{truncated}"
        );
    }

    #[test]
    fn model_bounds_are_separate_from_attachment_storage() {
        ensure_image_within_model_bounds(1, 1, 16).expect("ok");
        let too_big =
            ensure_image_within_model_bounds(1, 1, (MAX_PARSE_FILE_IMAGE_BYTES as u64) + 1)
                .expect_err("bytes");
        assert!(
            too_big
                .to_string()
                .contains(&MAX_PARSE_FILE_IMAGE_BYTES.to_string())
        );
        let too_wide = ensure_image_within_model_bounds(MAX_PARSE_FILE_IMAGE_DIMENSION + 1, 1, 16)
            .expect_err("width");
        assert!(too_wide.to_string().contains("8192"));
        let too_many_pixels = ensure_image_within_model_bounds(7000, 7000, 16).expect_err("pixels");
        assert!(too_many_pixels.to_string().contains("pixels"));
    }

    #[tokio::test]
    async fn refuses_oversized_local_documents_without_removing_the_attachment() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("large.txt");
        std::fs::File::create(&source)
            .unwrap()
            .set_len(MAX_PARSE_FILE_DOCUMENT_BYTES + 1)
            .unwrap();
        let cache = dir.path().join("parsed");
        let error = persist(
            dir.path(),
            &cache,
            ParseFileArgs {
                path: Some(source.to_string_lossy().into_owned()),
                url: None,
            },
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("64 MiB"), "{error}");
        assert!(source.exists());
        assert!(!cache.exists());
    }

    #[tokio::test]
    async fn bounds_http_documents_with_and_without_content_length() {
        for declared in [true, false] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                stream.read(&mut [0; 1024]).unwrap();
                let length = if declared {
                    format!("Content-Length: {}\r\n", MAX_PARSE_FILE_DOCUMENT_BYTES + 1)
                } else {
                    String::new()
                };
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\n{length}Connection: close\r\n\r\n"
                )
                .unwrap();
                if !declared {
                    let chunk = vec![b'x'; 1024 * 1024];
                    for _ in 0..=MAX_PARSE_FILE_DOCUMENT_BYTES / chunk.len() as u64 {
                        if stream.write_all(&chunk).is_err() {
                            break;
                        }
                    }
                }
            });
            let temp = tempfile::NamedTempFile::new().unwrap();
            let error = stream_http_to_path(
                http_client().unwrap(),
                validate_http_url(&format!("http://{address}/large.txt")).unwrap(),
                temp.path(),
                &WorkspaceCancellation::new(),
            )
            .await
            .unwrap_err();
            assert!(error.to_string().contains("64 MiB"), "{error}");
            assert!(temp.as_file().metadata().unwrap().len() <= MAX_PARSE_FILE_DOCUMENT_BYTES);
            server.join().unwrap();
        }
    }

    #[test]
    fn needs_ocr_refuses_hosted_fallback() {
        let message = ocr_unavailable_message("pages 2, 5-7, 12 of 20 need OCR");
        assert!(message.contains("2, 5-7, 12"), "{message}");
        assert!(message.contains("does not run OCR"), "{message}");
        assert!(message.contains("hosted OCR"), "{message}");
        assert!(!message.to_lowercase().contains("firecrawl"));
    }

    #[test]
    fn csv_without_signature_is_named_from_the_path() {
        let csv = SAMPLE_CSV.as_bytes();
        assert!(anydoc::Format::from_bytes(csv).is_none());
        assert_eq!(
            detect_anydoc_format(csv, Path::new("export.bin"), Path::new("data.csv")),
            Some(anydoc::Format::Csv)
        );
    }

    #[tokio::test]
    async fn persist_and_replay_round_trip_from_a_local_path() {
        let png = tiny_png();
        let workspace = temp_dir("workspace");
        let cache = temp_dir("cache");
        let source = workspace.join("shot.png");
        tokio::fs::write(&source, &png).await.expect("write");

        let persisted = persist(
            &workspace,
            &cache,
            ParseFileArgs {
                path: Some("shot.png".into()),
                url: None,
            },
        )
        .await
        .expect("persist");

        match &persisted {
            ParseFilePersistedOutput::Image {
                media_type,
                width,
                height,
                byte_size,
                path,
                source,
            } => {
                assert_eq!(media_type, "image/png");
                assert_eq!((*width, *height), (1, 1));
                assert_eq!(*byte_size, png.len() as u64);
                assert_eq!(
                    Path::new(path).parent(),
                    Some(std::fs::canonicalize(&cache).expect("cache").as_path())
                );
                match source {
                    ParseFilePersistedSource::Path { path } => assert_eq!(path, "shot.png"),
                    other => panic!("expected path source, got {other:?}"),
                }
            }
            other => panic!("expected image output, got {other:?}"),
        }

        let value = serde_json::to_value(&persisted).expect("value");
        assert!(!value.to_string().contains("iVBORw0KGgo"));
        assert_eq!(value["outputType"], "image");
        assert_eq!(value["mediaType"], "image/png");

        let output = replay_parse_file_tool_output(&value).await.expect("replay");
        assert_png_image_output(&output, &png);

        let history = replay_parse_file_history_items(&value)
            .await
            .expect("history");
        assert_eq!(history.len(), 1);
        match &history[0] {
            AgentHistoryToolResultItem::Image { image_json } => {
                assert!(image_json.contains("base64") || image_json.contains("iVBORw0KGgo"));
            }
            other => panic!("expected history image, got {other:?}"),
        }

        let _ = tokio::fs::remove_dir_all(workspace).await;
        let _ = tokio::fs::remove_dir_all(cache).await;
    }

    #[tokio::test]
    async fn http_response_bytes_become_rig_image_output() {
        let png = tiny_png();
        let url = serve_bytes_once(
            "HTTP/1.1 200 OK",
            "application/octet-stream",
            &png,
            "/shot.png",
        );
        let workspace = temp_dir("http-workspace");
        let cache = temp_dir("http-cache");

        let persisted = persist(
            &workspace,
            &cache,
            ParseFileArgs {
                path: None,
                url: Some(url),
            },
        )
        .await
        .expect("http persist");

        let value = serde_json::to_value(&persisted).expect("value");
        assert!(value.get("data").is_none());
        assert!(!value.to_string().contains("iVBORw0KGgo"));
        match &persisted {
            ParseFilePersistedOutput::Image { source, .. } => match source {
                ParseFilePersistedSource::Url { .. } => {}
                other => panic!("expected url source, got {other:?}"),
            },
            other => panic!("expected image output, got {other:?}"),
        }

        let output = replay_parse_file_tool_output(&value).await.expect("replay");
        assert!(
            !matches!(output.as_content(), [ToolResultContent::Json { .. }]),
            "HTTP parse_file image must yield a Rig image, not persisted JSON"
        );
        assert_png_image_output(&output, &png);

        let _ = tokio::fs::remove_dir_all(workspace).await;
        let _ = tokio::fs::remove_dir_all(cache).await;
    }

    #[tokio::test]
    async fn rtf_converts_through_anydoc() {
        let workspace = temp_dir("rtf");
        let cache = temp_dir("rtf-cache");
        tokio::fs::write(workspace.join("note.rtf"), SAMPLE_RTF)
            .await
            .expect("write");

        let persisted = persist(
            &workspace,
            &cache,
            ParseFileArgs {
                path: Some("note.rtf".into()),
                url: None,
            },
        )
        .await
        .expect("rtf");

        match &persisted {
            ParseFilePersistedOutput::Text {
                format,
                preview,
                truncated,
                path,
                ..
            } => {
                assert_eq!(format, "rtf");
                assert!(!*truncated);
                assert!(preview.contains("Hello from RTF"), "{preview}");
                let cached = tokio::fs::read_to_string(path).await.expect("cache");
                assert!(cached.contains("Hello from RTF"));
            }
            other => panic!("expected text output, got {other:?}"),
        }

        let value = serde_json::to_value(&persisted).expect("value");
        assert_eq!(value["outputType"], "text");
        let output = replay_parse_file_tool_output(&value).await.expect("replay");
        assert_text_contains(&output, "Hello from RTF");

        let history = replay_parse_file_history_items(&value)
            .await
            .expect("history");
        match &history[0] {
            AgentHistoryToolResultItem::Text { text } => {
                assert!(text.contains("Hello from RTF"));
            }
            other => panic!("expected history text, got {other:?}"),
        }

        let _ = tokio::fs::remove_dir_all(workspace).await;
        let _ = tokio::fs::remove_dir_all(cache).await;
    }

    #[tokio::test]
    async fn csv_uses_filename_fallback_over_http() {
        let url = serve_bytes_once(
            "HTTP/1.1 200 OK",
            "application/octet-stream",
            SAMPLE_CSV.as_bytes(),
            "/export.csv",
        );
        let workspace = temp_dir("csv-http");
        let cache = temp_dir("csv-http-cache");

        let persisted = persist(
            &workspace,
            &cache,
            ParseFileArgs {
                path: None,
                url: Some(url),
            },
        )
        .await
        .expect("csv http");

        match &persisted {
            ParseFilePersistedOutput::Text {
                format, preview, ..
            } => {
                assert_eq!(format, "csv");
                assert!(
                    preview.contains("widget") && preview.contains("gadget"),
                    "{preview}"
                );
            }
            other => panic!("expected text output, got {other:?}"),
        }

        let _ = tokio::fs::remove_dir_all(workspace).await;
        let _ = tokio::fs::remove_dir_all(cache).await;
    }

    #[tokio::test]
    async fn utf8_source_is_returned_as_text() {
        let workspace = temp_dir("utf8");
        let cache = temp_dir("utf8-cache");
        tokio::fs::write(workspace.join("main.rs"), "fn main() {}\n")
            .await
            .expect("write");

        let persisted = persist(
            &workspace,
            &cache,
            ParseFileArgs {
                path: Some("main.rs".into()),
                url: None,
            },
        )
        .await
        .expect("utf8");

        match persisted {
            ParseFilePersistedOutput::Text {
                format, preview, ..
            } => {
                assert_eq!(format, "text");
                assert!(preview.contains("fn main()"));
            }
            other => panic!("expected text output, got {other:?}"),
        }

        let _ = tokio::fs::remove_dir_all(workspace).await;
        let _ = tokio::fs::remove_dir_all(cache).await;
    }

    #[tokio::test]
    async fn text_only_model_rejects_images_and_still_parses_documents() {
        let workspace = temp_dir("text-model");
        let cache = temp_dir("text-model-cache");
        tokio::fs::write(workspace.join("shot.png"), tiny_png())
            .await
            .expect("png");
        tokio::fs::write(workspace.join("note.rtf"), SAMPLE_RTF)
            .await
            .expect("rtf");

        let image = persist_with_images(
            &workspace,
            &cache,
            false,
            ParseFileArgs {
                path: Some("shot.png".into()),
                url: None,
            },
        )
        .await
        .expect_err("image");
        assert!(
            image.to_string().contains("does not support images"),
            "{image}"
        );

        let doc = persist_with_images(
            &workspace,
            &cache,
            false,
            ParseFileArgs {
                path: Some("note.rtf".into()),
                url: None,
            },
        )
        .await
        .expect("rtf on text model");
        match doc {
            ParseFilePersistedOutput::Text { preview, .. } => {
                assert!(preview.contains("Hello from RTF"));
            }
            other => panic!("expected text output, got {other:?}"),
        }

        let _ = tokio::fs::remove_dir_all(workspace).await;
        let _ = tokio::fs::remove_dir_all(cache).await;
    }

    #[tokio::test]
    async fn long_text_is_cached_in_full_and_previewed_for_convex() {
        let workspace = temp_dir("truncate");
        let cache = temp_dir("truncate-cache");
        let tail = "UNIQUE-PARSE-FILE-TAIL";
        let full = format!("{}{tail}", "x".repeat(MAX_PARSE_FILE_PREVIEW_CHARS + 32));
        tokio::fs::write(workspace.join("long.txt"), &full)
            .await
            .expect("write");

        let persisted = persist(
            &workspace,
            &cache,
            ParseFileArgs {
                path: Some("long.txt".into()),
                url: None,
            },
        )
        .await
        .expect("long");

        match &persisted {
            ParseFilePersistedOutput::Text {
                preview,
                truncated,
                char_count,
                path,
                ..
            } => {
                assert!(*truncated);
                assert_eq!(*char_count, full.chars().count() as u64);
                assert_eq!(preview.chars().count(), MAX_PARSE_FILE_PREVIEW_CHARS);
                assert!(!preview.contains(tail));
                let cached = tokio::fs::read_to_string(path).await.expect("cache");
                assert!(cached.ends_with(tail));
            }
            other => panic!("expected text output, got {other:?}"),
        }

        let value = serde_json::to_value(&persisted).expect("value");
        assert!(!value.to_string().contains(tail));
        assert_eq!(value["truncated"], true);

        let output = replay_parse_file_tool_output(&value).await.expect("replay");
        match output.as_content() {
            [ToolResultContent::Text(text)] => {
                assert!(text.text.contains("...[truncated]"));
                assert!(text.text.contains("characters at"));
                assert!(!text.text.contains(tail));
            }
            other => panic!("expected text, got {other:?}"),
        }

        let _ = tokio::fs::remove_dir_all(workspace).await;
        let _ = tokio::fs::remove_dir_all(cache).await;
    }

    #[tokio::test]
    async fn missing_replay_cache_does_not_fetch_the_original_url() {
        let value = serde_json::json!({
            "outputType": "image",
            "mediaType": "image/png",
            "path": "/tmp/sprocket-parse-file-missing-cache.png",
            "source": { "type": "url", "url": "http://127.0.0.1:1/should-not-fetch.png" },
            "byteSize": 16,
            "width": 1,
            "height": 1
        });
        let error = replay_parse_file_tool_output(&value)
            .await
            .expect_err("missing cache");
        let message = format!("{error:#}");
        assert!(
            message.contains("cached image") || message.contains("failed to open"),
            "{message}"
        );
        assert!(!message.contains("failed to fetch"));

        let text = serde_json::json!({
            "outputType": "text",
            "path": "/tmp/sprocket-parse-file-missing-text.md",
            "source": { "type": "url", "url": "http://127.0.0.1:1/should-not-fetch.csv" },
            "format": "csv",
            "charCount": 4,
            "preview": "name",
            "truncated": false
        });
        let text_error = replay_parse_file_tool_output(&text)
            .await
            .expect_err("missing text cache");
        let text_message = format!("{text_error:#}");
        assert!(text_message.contains("cached text"), "{text_message}");
        assert!(!text_message.contains("failed to fetch"));
    }

    #[tokio::test]
    async fn local_and_replay_reads_are_bounded_without_trusting_size_metadata() {
        let workspace = temp_dir("oversize");
        let cache = temp_dir("oversize-cache");
        let path = workspace.join("huge.png");
        tokio::fs::write(&path, tiny_png()).await.expect("write");
        let file = tokio::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .await
            .expect("open");
        file.set_len(MAX_PARSE_FILE_IMAGE_BYTES as u64 + 64)
            .await
            .expect("set_len");
        drop(file);

        let live = persist(
            &workspace,
            &cache,
            ParseFileArgs {
                path: Some("huge.png".into()),
                url: None,
            },
        )
        .await
        .expect_err("live oversize");
        assert!(
            live.to_string()
                .contains(&MAX_PARSE_FILE_IMAGE_BYTES.to_string())
        );

        let spoofed = serde_json::json!({
            "outputType": "image",
            "mediaType": "image/png",
            "path": path,
            "source": { "type": "path", "path": "huge.png" },
            "byteSize": 16,
            "width": 1,
            "height": 1
        });
        let replay = replay_parse_file_tool_output(&spoofed)
            .await
            .expect_err("replay oversize");
        assert!(
            format!("{replay:#}").contains(&MAX_PARSE_FILE_IMAGE_BYTES.to_string()),
            "{replay:#}"
        );

        let _ = tokio::fs::remove_dir_all(workspace).await;
        let _ = tokio::fs::remove_dir_all(cache).await;
    }

    #[tokio::test]
    async fn local_path_rejects_missing_files_and_directories() {
        let workspace = temp_dir("missing");
        let cache = temp_dir("missing-cache");
        let missing = persist(
            &workspace,
            &cache,
            ParseFileArgs {
                path: Some("nope.png".into()),
                url: None,
            },
        )
        .await
        .expect_err("missing");
        assert!(
            missing.to_string().contains("failed to open")
                || missing.to_string().contains("No such")
        );

        let dir_error = persist(
            &workspace,
            &cache,
            ParseFileArgs {
                path: Some(".".into()),
                url: None,
            },
        )
        .await
        .expect_err("dir");
        assert!(dir_error.to_string().contains("not a file"));

        let _ = tokio::fs::remove_dir_all(workspace).await;
        let _ = tokio::fs::remove_dir_all(cache).await;
    }

    #[tokio::test]
    async fn binary_non_document_is_rejected() {
        let workspace = temp_dir("binary");
        let cache = temp_dir("binary-cache");
        tokio::fs::write(workspace.join("blob.bin"), [0u8, 1, 2, 3, 255])
            .await
            .expect("write");
        let error = persist(
            &workspace,
            &cache,
            ParseFileArgs {
                path: Some("blob.bin".into()),
                url: None,
            },
        )
        .await
        .expect_err("binary");
        assert!(error.to_string().contains("unsupported file"), "{error}");

        let _ = tokio::fs::remove_dir_all(workspace).await;
        let _ = tokio::fs::remove_dir_all(cache).await;
    }

    #[tokio::test]
    async fn cancellation_stops_a_local_read() {
        let workspace = temp_dir("cancel");
        let cache = temp_dir("cancel-cache");
        tokio::fs::write(workspace.join("shot.png"), tiny_png())
            .await
            .expect("write");
        let cancellation = WorkspaceCancellation::new();
        cancellation.cancel();
        let error = fetch_and_persist_parse_file(
            &workspace,
            &cache,
            cancellation,
            true,
            ParseFileArgs {
                path: Some("shot.png".into()),
                url: None,
            },
        )
        .await
        .expect_err("cancelled");
        assert!(
            error.is::<WorkspaceOperationCancelled>() || error.to_string().contains("cancelled")
        );

        let _ = tokio::fs::remove_dir_all(workspace).await;
        let _ = tokio::fs::remove_dir_all(cache).await;
    }

    #[test]
    fn cache_dir_lives_beside_user_attachments() {
        assert_eq!(
            parse_file_cache_dir(Path::new("/threads/u/t")),
            PathBuf::from("/threads/u/t/parse_file")
        );
        assert!(is_parse_file_tool("parse_file"));
        assert!(!is_parse_file_tool("read_skill"));
        assert!(!is_parse_file_tool("read_image"));
    }
}
