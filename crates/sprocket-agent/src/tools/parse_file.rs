use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};

use anyhow::{Context, anyhow, bail};
use base64::Engine;
use rig::message::{ImageMediaType, MimeType, ToolResultContent};
use rig::tool::{ToolExecutionError, ToolOutput};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sprocket_workspace::{WorkspaceCancellation, WorkspaceOperationCancelled};
use tokio::io::AsyncReadExt;

use super::context::{AgentToolContext, tool_error};
use super::hosted_parse::HostedParseContext;
use super::job::execute_tool_job_with_id;
use crate::types::AgentHistoryToolResultItem;

pub(crate) const PARSE_FILE_TOOL_NAME: &str = "parse_file";

/// Encoded-image ceiling for model input. Attachment files have no size cap;
/// this bound applies only when `parse_file` decodes image bytes for the model.
pub(crate) const MAX_PARSE_FILE_IMAGE_BYTES: usize = 20 * 1024 * 1024;
pub(crate) const MAX_PARSE_FILE_IMAGE_DIMENSION: u32 = 8192;
pub(crate) const MAX_PARSE_FILE_IMAGE_PIXELS: u32 = 36_000_000;
/// Anthropic rejects images over 2000 px per side once a request holds more
/// than 20 images, and Bedrock/Vertex cap each image at 5 MB of base64.
pub(crate) const MAX_MODEL_IMAGE_EDGE: u32 = 2000;
pub(crate) const MAX_MODEL_IMAGE_BYTES: usize = 3_750_000;
const MODEL_IMAGE_JPEG_QUALITY: u8 = 85;
pub(crate) const MAX_PARSE_FILE_PREVIEW_CHARS: usize = 20_000;
const MAX_PARSE_FILE_DOCUMENT_BYTES: u64 = 64 * 1024 * 1024;

pub(super) const IMAGE_SNIFF_BYTES: usize = 16;

#[derive(Clone)]
pub(crate) struct ParseFileTool(pub(super) AgentToolContext);

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct ParseFileArgs {
    /// Relative or absolute path to the file
    pub path: String,
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
    Path { path: String },
}

struct ParsedText {
    path: PathBuf,
    format: String,
    char_count: u64,
    preview: String,
    truncated: bool,
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub(super) struct LocalConversionFailed(pub(super) String);

pub(crate) fn is_parse_file_tool(name: &str) -> bool {
    name == PARSE_FILE_TOOL_NAME
}

impl rig::tool::Tool for ParseFileTool {
    const NAME: &'static str = PARSE_FILE_TOOL_NAME;
    type Error = ToolExecutionError;
    type Args = ParseFileArgs;
    type Output = ToolOutput;

    fn description(&self) -> String {
        let docs = "Use to parse ANY type of file into a format easily readable by you.";
        if self.0.supports_images {
            docs.to_string()
        } else {
            format!(
                "{docs} Your model architecture doesn't support images, so you can't read image files using this tool"
            )
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
        replay_parse_file_tool_output(&persisted)
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

fn ensure_not_cancelled(cancellation: &WorkspaceCancellation) -> anyhow::Result<()> {
    if cancellation.is_cancelled() {
        Err(WorkspaceOperationCancelled.into())
    } else {
        Ok(())
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

fn ensure_image_within_model_bounds(width: u32, height: u32, byte_len: u64) -> anyhow::Result<()> {
    anyhow::ensure!(
        byte_len <= MAX_PARSE_FILE_IMAGE_BYTES as u64,
        "image is {byte_len} bytes; model input accepts at most {MAX_PARSE_FILE_IMAGE_BYTES} bytes for images"
    );
    anyhow::ensure!(width > 0 && height > 0, "image has no pixels");
    anyhow::ensure!(
        width <= MAX_PARSE_FILE_IMAGE_DIMENSION && height <= MAX_PARSE_FILE_IMAGE_DIMENSION,
        "image is {width}x{height}; each side must be at most {MAX_PARSE_FILE_IMAGE_DIMENSION}"
    );
    let pixels = u64::from(width).saturating_mul(u64::from(height));
    anyhow::ensure!(
        pixels <= u64::from(MAX_PARSE_FILE_IMAGE_PIXELS),
        "image is {width}x{height}; model input accepts at most {MAX_PARSE_FILE_IMAGE_PIXELS} pixels"
    );
    Ok(())
}

pub(super) fn sniff_supported_image_format(bytes: &[u8]) -> Option<image::ImageFormat> {
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

pub(super) fn decode_image_info(bytes: &[u8]) -> anyhow::Result<(ImageMediaType, u32, u32)> {
    anyhow::ensure!(!bytes.is_empty(), "image is empty");
    anyhow::ensure!(
        bytes.len() <= MAX_PARSE_FILE_IMAGE_BYTES,
        "image is {} bytes; model input accepts at most {MAX_PARSE_FILE_IMAGE_BYTES} bytes for images",
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

pub(super) struct ModelImage {
    pub bytes: Vec<u8>,
    pub media_type: ImageMediaType,
    pub width: u32,
    pub height: u32,
}

/// Downscales and re-encodes images the provider would reject; others pass through untouched.
pub(super) fn fit_image_for_model(bytes: Vec<u8>) -> anyhow::Result<ModelImage> {
    let (media_type, width, height) = decode_image_info(&bytes)?;
    if width <= MAX_MODEL_IMAGE_EDGE
        && height <= MAX_MODEL_IMAGE_EDGE
        && bytes.len() <= MAX_MODEL_IMAGE_BYTES
    {
        return Ok(ModelImage {
            bytes,
            media_type,
            width,
            height,
        });
    }
    let format = sniff_supported_image_format(&bytes)
        .ok_or_else(|| anyhow!("unknown image format; use jpeg, png, gif, or webp"))?;
    let mut reader = image::ImageReader::new(Cursor::new(&bytes));
    reader.set_format(format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_PARSE_FILE_IMAGE_DIMENSION);
    limits.max_image_height = Some(MAX_PARSE_FILE_IMAGE_DIMENSION);
    limits.max_alloc = Some(u64::from(MAX_PARSE_FILE_IMAGE_PIXELS).saturating_mul(8));
    reader.limits(limits);
    let decoded = reader.decode().context("failed to decode image")?;
    let mut fitted = if width > MAX_MODEL_IMAGE_EDGE || height > MAX_MODEL_IMAGE_EDGE {
        decoded.thumbnail(MAX_MODEL_IMAGE_EDGE, MAX_MODEL_IMAGE_EDGE)
    } else {
        decoded
    };
    if format != image::ImageFormat::Jpeg {
        let png = encode_png(&fitted)?;
        if png.bytes.len() <= MAX_MODEL_IMAGE_BYTES {
            return Ok(png);
        }
    }
    loop {
        let jpeg = encode_jpeg(&fitted)?;
        if jpeg.bytes.len() <= MAX_MODEL_IMAGE_BYTES || fitted.width().max(fitted.height()) <= 1 {
            return Ok(jpeg);
        }
        fitted = fitted.thumbnail(
            (fitted.width() * 3 / 4).max(1),
            (fitted.height() * 3 / 4).max(1),
        );
    }
}

fn encode_png(image: &image::DynamicImage) -> anyhow::Result<ModelImage> {
    let mut bytes = Vec::new();
    image
        .write_to(&mut Cursor::new(&mut bytes), image::ImageFormat::Png)
        .context("failed to encode png")?;
    Ok(ModelImage {
        bytes,
        media_type: ImageMediaType::PNG,
        width: image.width(),
        height: image.height(),
    })
}

fn encode_jpeg(image: &image::DynamicImage) -> anyhow::Result<ModelImage> {
    let mut bytes = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, MODEL_IMAGE_JPEG_QUALITY)
        .encode_image(&image::DynamicImage::ImageRgb8(image.to_rgb8()))
        .context("failed to encode jpeg")?;
    Ok(ModelImage {
        bytes,
        media_type: ImageMediaType::JPEG,
        width: image.width(),
        height: image.height(),
    })
}

pub(super) async fn fit_image_for_model_blocking(bytes: Vec<u8>) -> anyhow::Result<ModelImage> {
    tokio::task::spawn_blocking(move || fit_image_for_model(bytes))
        .await
        .context("image downscaling worker failed")?
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

fn detect_anydoc_format(bytes: &[u8], path: &Path) -> Option<anydoc::Format> {
    anydoc::Format::from_bytes(bytes).or_else(|| anydoc::Format::from_path(path))
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

enum DetectedDocument {
    Converted((String, &'static str)),
    Pdf(Vec<u8>),
}

/// `path` names the document and `hint` gives the format of signatureless
/// content; the path is never read.
pub(super) async fn convert_document(
    bytes: Vec<u8>,
    path: PathBuf,
    hint: Option<anydoc::Format>,
    hosted: Option<&HostedParseContext<'_>>,
    cancellation: &WorkspaceCancellation,
) -> anyhow::Result<(String, &'static str)> {
    anyhow::ensure!(!bytes.is_empty(), "file is empty");
    let detected = run_cancellable_blocking(cancellation, move || {
        Ok(match detect_anydoc_format(&bytes, &path).or(hint) {
            Some(anydoc::Format::Pdf) => DetectedDocument::Pdf(bytes),
            format => DetectedDocument::Converted(convert_file_bytes(bytes, format)?),
        })
    })
    .await?;
    match detected {
        DetectedDocument::Converted(converted) => Ok(converted),
        DetectedDocument::Pdf(bytes) => {
            let markdown = super::pdf_pages::pdf_markdown(bytes, hosted, cancellation).await?;
            Ok((markdown, anydoc_format_name(anydoc::Format::Pdf)))
        }
    }
}

fn convert_file_bytes(
    bytes: Vec<u8>,
    format: Option<anydoc::Format>,
) -> anyhow::Result<(String, &'static str)> {
    if let Some(format) = format {
        let markdown = anydoc::to_markdown_bytes(&bytes, format)
            .map_err(|error| LocalConversionFailed(error.to_string()))?;
        return Ok((markdown, anydoc_format_name(format)));
    }
    let text = String::from_utf8(bytes)
        .map_err(|_| LocalConversionFailed(unsupported_file_error().to_string()))?;
    if text.contains('\0') {
        return Err(LocalConversionFailed(unsupported_file_error().to_string()).into());
    }
    Ok((text, "text"))
}

pub(super) async fn persist_image_bytes(
    cache_dir: &Path,
    bytes: &[u8],
    media_type: &ImageMediaType,
) -> anyhow::Result<PathBuf> {
    anyhow::ensure!(
        !cache_dir.as_os_str().is_empty(),
        "image cache directory is not configured"
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

async fn read_file_bounded(
    path: &Path,
    max_bytes: u64,
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
    let mut limited = file.take(max_bytes);
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

async fn read_image_bytes_bounded(
    path: &Path,
    cancellation: &WorkspaceCancellation,
) -> anyhow::Result<Vec<u8>> {
    let bytes =
        read_file_bounded(path, MAX_PARSE_FILE_IMAGE_BYTES as u64 + 1, cancellation).await?;
    anyhow::ensure!(
        bytes.len() <= MAX_PARSE_FILE_IMAGE_BYTES,
        "image is {} bytes; parse_file accepts at most {MAX_PARSE_FILE_IMAGE_BYTES} bytes for images",
        bytes.len()
    );
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

pub(super) async fn run_cancellable_blocking<T: Send + 'static>(
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

async fn replay_image_output(
    media_type: &str,
    path: &str,
    byte_size: u64,
    width: u32,
    height: u32,
) -> anyhow::Result<ToolOutput> {
    anyhow::ensure!(
        !path.is_empty(),
        "image tool output is missing a cached path"
    );
    let bytes = read_image_bytes_bounded(Path::new(path), &WorkspaceCancellation::new())
        .await
        .with_context(|| format!("failed to read cached image {path}"))?;
    let media_type = ImageMediaType::from_mime_type(media_type)
        .ok_or_else(|| anyhow!("image tool output has unsupported media type {media_type}"))?;
    let (decoded_type, decoded_width, decoded_height) = decode_image_info(&bytes)?;
    anyhow::ensure!(
        decoded_type == media_type
            && decoded_width == width
            && decoded_height == height
            && bytes.len() as u64 == byte_size,
        "cached image {path} does not match persisted metadata"
    );
    // Images cached before fitting existed still reach the model through replay.
    let image = fit_image_for_model_blocking(bytes).await?;
    Ok(ToolOutput::content(vec![
        ToolResultContent::text(format!("Image saved to: {path}")),
        ToolResultContent::image_base64(
            base64::engine::general_purpose::STANDARD.encode(image.bytes),
            Some(image.media_type),
            None,
        ),
    ])?)
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

/// Missing cache is an error so history hydration can fall back to text.
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

pub(super) async fn replay_image_tool_output(
    output: &serde_json::Value,
) -> anyhow::Result<ToolOutput> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ImageReference {
        media_type: String,
        path: String,
        #[serde(deserialize_with = "sprocket_convex::deserialize_convex_u64")]
        byte_size: u64,
        #[serde(deserialize_with = "sprocket_convex::deserialize_convex_u32")]
        width: u32,
        #[serde(deserialize_with = "sprocket_convex::deserialize_convex_u32")]
        height: u32,
    }

    let image: ImageReference = serde_json::from_value(output.clone())
        .context("image tool output is not replay metadata")?;
    replay_image_output(
        &image.media_type,
        &image.path,
        image.byte_size,
        image.width,
        image.height,
    )
    .await
}

pub(crate) async fn replay_local_tool_history_items(
    output: &serde_json::Value,
) -> anyhow::Result<Vec<AgentHistoryToolResultItem>> {
    let tool_output =
        if output.get("outputType").and_then(serde_json::Value::as_str) == Some("image") {
            replay_image_tool_output(output).await?
        } else {
            replay_parse_file_tool_output(output).await?
        };
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
mod tests;
