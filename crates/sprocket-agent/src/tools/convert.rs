//! Shared local image/document conversion used by parse_file, scrape_url, and GitHub fetches.

use std::io::Cursor;
use std::path::{Path, PathBuf};

use anyhow::{Context, anyhow, bail};
use base64::Engine;
use rig::message::{ImageMediaType, MimeType, ToolResultContent};
use rig::tool::ToolOutput;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sprocket_workspace::{WorkspaceCancellation, WorkspaceOperationCancelled};
use tokio::io::AsyncReadExt;

use super::hosted_parse::HostedParseContext;
use super::image_urls::{ConvexImageUrls, ImageUrlMap};
use crate::types::AgentHistoryToolResultItem;

/// Encoded-image ceiling for model input. Attachment files have no size cap;
/// this bound applies only when converting image bytes for the model.
pub(crate) const MAX_PARSE_FILE_IMAGE_BYTES: usize = 20 * 1024 * 1024;
pub(crate) const MAX_PARSE_FILE_IMAGE_DIMENSION: u32 = 8192;
pub(crate) const MAX_PARSE_FILE_IMAGE_PIXELS: u32 = 36_000_000;
/// Anthropic rejects images over 2000 px per side once a request holds more
/// than 20 images, and Bedrock/Vertex cap each image at 5 MB of base64.
pub(crate) const MAX_MODEL_IMAGE_EDGE: u32 = 2000;
pub(crate) const MAX_MODEL_IMAGE_BYTES: usize = 3_750_000;
const MODEL_IMAGE_JPEG_QUALITY: u8 = 85;
pub(crate) const MAX_PARSE_FILE_PREVIEW_CHARS: usize = 20_000;

pub(super) const IMAGE_SNIFF_BYTES: usize = 16;

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

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub(super) struct LocalConversionFailed(pub(super) String);

pub(super) fn ensure_not_cancelled(cancellation: &WorkspaceCancellation) -> anyhow::Result<()> {
    if cancellation.is_cancelled() {
        Err(WorkspaceOperationCancelled.into())
    } else {
        Ok(())
    }
}

pub(super) fn ensure_image_within_model_bounds(
    width: u32,
    height: u32,
    byte_len: u64,
) -> anyhow::Result<()> {
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
        .encode_image(&image::DynamicImage::ImageRgb8(flatten_onto_white(image)))
        .context("failed to encode jpeg")?;
    Ok(ModelImage {
        bytes,
        media_type: ImageMediaType::JPEG,
        width: image.width(),
        height: image.height(),
    })
}

pub(super) fn flatten_onto_white(image: &image::DynamicImage) -> image::RgbImage {
    if !image.color().has_alpha() {
        return image.to_rgb8();
    }
    let rgba = image.to_rgba8();
    image::RgbImage::from_fn(rgba.width(), rgba.height(), |x, y| {
        let [r, g, b, a] = rgba.get_pixel(x, y).0;
        let over_white = |channel: u8| {
            ((u16::from(channel) * u16::from(a) + 255 * (255 - u16::from(a)) + 127) / 255) as u8
        };
        image::Rgb([over_white(r), over_white(g), over_white(b)])
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

pub(super) fn detect_anydoc_format(bytes: &[u8], path: &Path) -> Option<anydoc::Format> {
    anydoc::Format::from_bytes(bytes).or_else(|| anydoc::Format::from_path(path))
}

pub(super) fn preview_text(text: &str) -> (String, bool) {
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
        "unsupported file; supported types are jpeg, png, gif, webp, office documents (Word, PowerPoint, Excel, OpenDocument, RTF, EPUB, CSV, PDF), and UTF-8 text"
    )
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

pub(super) async fn read_file_bounded(
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

pub(super) async fn read_image_bytes_bounded(
    path: &Path,
    cancellation: &WorkspaceCancellation,
) -> anyhow::Result<Vec<u8>> {
    let bytes =
        read_file_bounded(path, MAX_PARSE_FILE_IMAGE_BYTES as u64 + 1, cancellation).await?;
    anyhow::ensure!(
        bytes.len() <= MAX_PARSE_FILE_IMAGE_BYTES,
        "image is {} bytes; model input accepts at most {MAX_PARSE_FILE_IMAGE_BYTES} bytes for images",
        bytes.len()
    );
    Ok(bytes)
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
            result.context("conversion worker failed")?
        }
    }
}

pub(super) struct ReplayedImage {
    pub(super) path: String,
    pub(super) image: ModelImage,
    /// Hex sha256 of the bytes the model receives.
    pub(super) sha256: String,
    /// Only downloaded images show their path; parse_file's cache holds a
    /// downscaled copy of a file the model already has a path to.
    show_path: bool,
}

pub(super) enum ReplayedOutput {
    Text(String),
    Image(ReplayedImage),
}

impl ReplayedOutput {
    pub(super) fn image(&self) -> Option<&ReplayedImage> {
        match self {
            Self::Image(image) => Some(image),
            Self::Text(_) => None,
        }
    }

    fn into_content(self, urls: &ImageUrlMap) -> Vec<ToolResultContent> {
        match self {
            Self::Text(text) => vec![ToolResultContent::text(text)],
            Self::Image(ReplayedImage {
                path,
                image,
                sha256,
                show_path,
            }) => {
                let media_type = Some(image.media_type);
                let image = match urls.get(&sha256) {
                    Some(url) => ToolResultContent::image_url(url.clone(), media_type, None),
                    None => ToolResultContent::image_base64(
                        base64::engine::general_purpose::STANDARD.encode(image.bytes),
                        media_type,
                        None,
                    ),
                };
                if show_path {
                    vec![
                        ToolResultContent::text(format!("Image saved to: {path}")),
                        image,
                    ]
                } else {
                    vec![image]
                }
            }
        }
    }

    pub(super) fn into_history_items(
        self,
        urls: &ImageUrlMap,
    ) -> anyhow::Result<Vec<AgentHistoryToolResultItem>> {
        self.into_content(urls)
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
}

async fn replay_image_output(
    media_type: &str,
    path: &str,
    byte_size: u64,
    width: u32,
    height: u32,
    show_path: bool,
) -> anyhow::Result<ReplayedImage> {
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
    let (image, sha256) = tokio::task::spawn_blocking(move || {
        let image = fit_image_for_model(bytes)?;
        let sha256 = hex::encode(Sha256::digest(&image.bytes));
        anyhow::Ok((image, sha256))
    })
    .await
    .context("image downscaling worker failed")??;
    Ok(ReplayedImage {
        path: path.to_string(),
        image,
        sha256,
        show_path,
    })
}

async fn replay_text_output(
    path: &str,
    preview: &str,
    truncated: bool,
    char_count: u64,
) -> anyhow::Result<String> {
    anyhow::ensure!(
        !path.is_empty(),
        "parse_file tool output is missing a cached path"
    );
    let exists = tokio::fs::try_exists(path)
        .await
        .with_context(|| format!("failed to read cached text {path}"))?;
    anyhow::ensure!(exists, "failed to read cached text {path}");
    Ok(model_text(preview, truncated, char_count, path))
}

async fn replay_parse_file_output(output: &serde_json::Value) -> anyhow::Result<ReplayedOutput> {
    let persisted: ParseFilePersistedOutput = serde_json::from_value(output.clone())
        .context("parse_file tool output is not replay metadata")?;
    Ok(match persisted {
        ParseFilePersistedOutput::Image {
            media_type,
            path,
            byte_size,
            width,
            height,
            ..
        } => ReplayedOutput::Image(
            replay_image_output(&media_type, &path, byte_size, width, height, false).await?,
        ),
        ParseFilePersistedOutput::Text {
            path,
            preview,
            truncated,
            char_count,
            ..
        } => {
            ReplayedOutput::Text(replay_text_output(&path, &preview, truncated, char_count).await?)
        }
    })
}

async fn replay_image_reference(output: &serde_json::Value) -> anyhow::Result<ReplayedImage> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ImageReference {
        url: Option<String>,
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
        image.url.is_some(),
    )
    .await
}

/// Rebuilds the model input of a `parse_file` result or an `outputType:
/// "image"` result from the local cache. Missing cache is an error so history
/// hydration can fall back to text.
pub(super) async fn replay_local_tool_output(
    output: &serde_json::Value,
) -> anyhow::Result<ReplayedOutput> {
    if output.get("outputType").and_then(serde_json::Value::as_str) == Some("image") {
        Ok(ReplayedOutput::Image(replay_image_reference(output).await?))
    } else {
        replay_parse_file_output(output).await
    }
}

pub(super) async fn replay_tool_output(
    output: &serde_json::Value,
    image_urls: Option<&ConvexImageUrls<'_>>,
) -> anyhow::Result<ToolOutput> {
    let replayed = replay_local_tool_output(output).await?;
    let urls = match (image_urls, replayed.image()) {
        (Some(source), Some(image)) => source.urls(&[image]).await,
        _ => ImageUrlMap::new(),
    };
    Ok(ToolOutput::content(replayed.into_content(&urls))?)
}
