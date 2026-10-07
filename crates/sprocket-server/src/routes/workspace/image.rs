use std::io::Read;
use std::path::{Component, Path, PathBuf};

use anyhow::Context;
use axum::Json;
use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, header};
use axum::response::{IntoResponse, Response};
use axum_extra::extract::CookieJar;
use serde::Deserialize;

use crate::AppState;
use crate::auth::require_session_user;
use crate::routes::api_error::ApiError;
use crate::routes::session::MachineSession;

pub(super) const MAX_LOCAL_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
static LOCAL_IMAGE_READS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LocalImageRequest {
    workspace_path: Option<PathBuf>,
    path: String,
    user_id: Option<String>,
    thread_id: Option<String>,
    #[serde(default)]
    revision_only: bool,
}

pub(super) async fn local_image(
    State(state): State<AppState>,
    MachineSession: MachineSession,
    headers: HeaderMap,
    jar: CookieJar,
    Query(payload): Query<LocalImageRequest>,
) -> Result<Response, ApiError> {
    let root = match (&payload.user_id, &payload.thread_id) {
        (None, None) => LocalImageRoot::Workspace(payload.workspace_path),
        (Some(user_id), Some(thread_id)) => {
            require_session_user(&state.auth, &headers, &jar, user_id)
                .await
                .map_err(ApiError::unauthorized)?;
            validate_thread_image_path(thread_id, &payload.path).map_err(ApiError::bad_request)?;
            LocalImageRoot::Thread(
                state.transcript.thread_dir(user_id, thread_id),
                payload.workspace_path,
            )
        }
        _ => {
            return Err(ApiError::bad_request(anyhow::anyhow!(
                "local image scope requires both userId and threadId"
            )));
        }
    };
    let permit = LOCAL_IMAGE_READS
        .acquire()
        .await
        .map_err(|error| ApiError::internal(error.into()))?;
    if payload.revision_only {
        let revision = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let (_, metadata) = open_local_image(root, payload.path).ok()?;
            let modified = metadata.modified().ok()?;
            let nanos = modified
                .duration_since(std::time::UNIX_EPOCH)
                .ok()?
                .as_nanos();
            Some(format!("{}-{nanos}", metadata.len()))
        })
        .await
        .map_err(|error| ApiError::internal(error.into()))?;
        return Ok(([(header::CACHE_CONTROL, "no-store")], Json(revision)).into_response());
    }
    let result = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        read_local_image(root, payload.path)
    })
    .await
    .map_err(|error| ApiError::internal(error.into()))?
    .map_err(ApiError::bad_request)?;

    let is_svg = result.media_type == "image/svg+xml";
    let mut response = Response::new(Body::from(result.contents));
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static(result.media_type),
    );
    headers.insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        header::HeaderValue::from_static("nosniff"),
    );
    if is_svg {
        headers.insert(
            axum::http::HeaderName::from_static("content-security-policy"),
            header::HeaderValue::from_static("sandbox; default-src 'none'"),
        );
    }
    Ok(response)
}

struct LocalImage {
    contents: Vec<u8>,
    media_type: &'static str,
}

enum LocalImageRoot {
    Workspace(Option<PathBuf>),
    Thread(PathBuf, Option<PathBuf>),
}

fn validate_thread_image_path(thread_id: &str, image_path: &str) -> anyhow::Result<()> {
    if thread_id.is_empty()
        || thread_id.eq_ignore_ascii_case("blobs")
        || thread_id.eq_ignore_ascii_case("pending-attachments")
        || !thread_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        anyhow::bail!("invalid transcript thread ID");
    }

    let mut components = Path::new(image_path).components();
    let is_tool_cache = matches!(
        components.next(),
        Some(Component::Normal(name))
            if matches!(name.to_str(), Some("parse_file" | "screenshot_url" | "scrape_url"))
    );
    if !is_tool_cache
        || !matches!(components.next(), Some(Component::Normal(_)))
        || !components.all(|component| matches!(component, Component::Normal(_)))
        || image_path
            .split(['/', '\\'])
            .any(|part| matches!(part, "." | ".."))
    {
        anyhow::bail!("thread image paths must be relative tool-cache paths without traversal");
    }
    Ok(())
}

fn read_local_image(root: LocalImageRoot, image_path: String) -> anyhow::Result<LocalImage> {
    let (file, metadata) = open_local_image(root, image_path)?;
    let mut contents = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_LOCAL_IMAGE_BYTES + 1)
        .read_to_end(&mut contents)
        .with_context(|| "failed to read local image")?;
    if contents.len() as u64 > MAX_LOCAL_IMAGE_BYTES {
        anyhow::bail!("local image exceeds the 20 MiB limit");
    }

    let media_type = detect_image_media_type(&contents)
        .ok_or_else(|| anyhow::anyhow!("local file is not a supported image"))?;
    Ok(LocalImage {
        contents,
        media_type,
    })
}

fn open_local_image(
    root: LocalImageRoot,
    image_path: String,
) -> anyhow::Result<(std::fs::File, std::fs::Metadata)> {
    let image_path = Path::new(&image_path);
    let image_path = match root {
        LocalImageRoot::Workspace(workspace_path) => {
            if image_path.is_absolute() {
                image_path.to_path_buf()
            } else {
                workspace_path
                    .context("relative image paths require a workspace directory")?
                    .join(image_path)
            }
        }
        LocalImageRoot::Thread(thread_dir, workspace_path) => {
            if let Some(workspace_path) = workspace_path {
                match workspace_path.join(image_path).canonicalize() {
                    Ok(path) => {
                        return open_local_image(
                            LocalImageRoot::Workspace(None),
                            path.to_string_lossy().into_owned(),
                        );
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error).context("failed to resolve workspace image"),
                }
            }
            let resolved_image = thread_dir
                .join(image_path)
                .canonicalize()
                .context("failed to resolve thread image")?;
            let thread_dir = thread_dir
                .canonicalize()
                .context("failed to resolve transcript directory")?;
            if !resolved_image.starts_with(&thread_dir) {
                anyhow::bail!("thread image must remain inside its transcript directory");
            }
            resolved_image
        }
    };
    if !image_path.is_absolute() {
        anyhow::bail!("image path must resolve to an absolute path");
    }

    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let file = options
        .open(image_path)
        .with_context(|| "failed to open local image")?;
    let metadata = file
        .metadata()
        .with_context(|| "failed to inspect local image")?;
    if !metadata.is_file() {
        anyhow::bail!("local image is not a regular file");
    }
    if metadata.len() > MAX_LOCAL_IMAGE_BYTES {
        anyhow::bail!("local image exceeds the 20 MiB limit");
    }

    Ok((file, metadata))
}

pub(super) fn detect_image_media_type(contents: &[u8]) -> Option<&'static str> {
    if contents.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if contents.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if contents.starts_with(b"GIF87a") || contents.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if contents.len() >= 12 && &contents[..4] == b"RIFF" && &contents[8..12] == b"WEBP" {
        Some("image/webp")
    } else if contents.starts_with(b"BM") {
        Some("image/bmp")
    } else if is_avif(contents) {
        Some("image/avif")
    } else if is_svg(contents) {
        Some("image/svg+xml")
    } else {
        None
    }
}

fn is_avif(contents: &[u8]) -> bool {
    if contents.len() < 16 || &contents[4..8] != b"ftyp" {
        return false;
    }
    let box_size = u32::from_be_bytes(contents[..4].try_into().unwrap()) as usize;
    if box_size < 16 || box_size > contents.len() || box_size % 4 != 0 {
        return false;
    }
    &contents[8..12] == b"avif"
        || &contents[8..12] == b"avis"
        || contents[16..box_size]
            .chunks_exact(4)
            .any(|brand| brand == b"avif" || brand == b"avis")
}

fn is_svg(contents: &[u8]) -> bool {
    let Ok(document) = std::str::from_utf8(contents) else {
        return false;
    };
    let mut rest = document.strip_prefix('\u{feff}').unwrap_or(document);
    rest = trim_xml_whitespace(rest);
    if rest.starts_with("<?xml") {
        let Some(end) = rest.find("?>") else {
            return false;
        };
        rest = trim_xml_whitespace(&rest[end + 2..]);
    }
    loop {
        if rest.starts_with("<!--") {
            let Some(end) = rest.find("-->") else {
                return false;
            };
            rest = trim_xml_whitespace(&rest[end + 3..]);
        } else if rest.starts_with("<!DOCTYPE") {
            let mut quote = None;
            let mut subset_depth = 0usize;
            let end = rest.char_indices().find_map(|(index, character)| {
                if quote == Some(character) {
                    quote = None;
                } else if quote.is_none() {
                    match character {
                        '\'' | '"' => quote = Some(character),
                        '[' => subset_depth += 1,
                        ']' => subset_depth = subset_depth.saturating_sub(1),
                        '>' if subset_depth == 0 => return Some(index),
                        _ => {}
                    }
                }
                None
            });
            let Some(end) = end else {
                return false;
            };
            rest = trim_xml_whitespace(&rest[end + 1..]);
        } else {
            break;
        }
    }
    let Some(tag) = rest.strip_prefix("<svg") else {
        return false;
    };
    tag.chars()
        .next()
        .is_some_and(|character| matches!(character, '>' | '/' | ' ' | '\t' | '\r' | '\n'))
}

fn trim_xml_whitespace(mut value: &str) -> &str {
    while let Some(character) = value.chars().next() {
        if !matches!(character, ' ' | '\t' | '\r' | '\n') {
            break;
        }
        value = &value[character.len_utf8()..];
    }
    value
}
