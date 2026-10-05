use std::io::Read;
use std::path::{Component, Path, PathBuf};

use anyhow::Context;
use axum::Json;
use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum_extra::extract::CookieJar;
use serde::{Deserialize, Serialize};

use crate::AppState;
use crate::auth::require_session_user;
use crate::project_attachments::{
    AttachProjectRequest, ProjectAttachmentRecord, WorkspacePathResolution, resolve_workspace_path,
};
use crate::routes::api_error::ApiError;
use crate::routes::session::MachineSession;
use crate::workspace_search::{MAX_QUERY_CHARS, SearchOutcome};
use sprocket_workspace::{
    BUILTIN_SKILLS, FilesystemBrowseResult, browse_filesystem, default_user_skills_dirs,
    load_workspace_skills,
};

const MAX_LOCAL_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
static LOCAL_IMAGE_READS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspacePathResolutionRequest {
    workspace_path: String,
    #[serde(default)]
    create_if_missing: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FilesystemBrowseRequest {
    partial_path: String,
    cwd: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceSkillsRequest {
    workspace_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceSearchRequest {
    workspace_path: String,
    query: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalImageRequest {
    workspace_path: Option<PathBuf>,
    path: String,
    user_id: Option<String>,
    thread_id: Option<String>,
    #[serde(default)]
    revision_only: bool,
}

#[derive(Debug, Serialize)]
struct WorkspaceSearchResponse {
    entries: Vec<WorkspaceSearchEntry>,
    scanning: bool,
}

#[derive(Debug, Serialize)]
struct WorkspaceSearchEntry {
    path: String,
    kind: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SkillSummary {
    name: String,
    description: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceSkillsResponse {
    skills: Vec<SkillSummary>,
    warnings: Vec<String>,
}

pub fn routes() -> axum::Router<AppState> {
    axum::Router::new()
        .route(
            "/workspace/projects",
            get(list_projects).post(attach_project),
        )
        .route("/workspace/resolve", post(resolve_path))
        .route("/workspace/browse", post(browse_path))
        .route("/workspace/skills", post(list_skills))
        .route("/workspace/search", post(search_workspace))
        .route("/workspace/image", get(local_image))
}

async fn local_image(
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
            let resolved_image = match thread_dir.join(image_path).canonicalize() {
                Ok(path) => path,
                Err(error)
                    if error.kind() == std::io::ErrorKind::NotFound && workspace_path.is_some() =>
                {
                    return open_local_image(
                        LocalImageRoot::Workspace(workspace_path),
                        image_path.to_string_lossy().into_owned(),
                    );
                }
                Err(error) => return Err(error).context("failed to resolve thread image"),
            };
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

fn detect_image_media_type(contents: &[u8]) -> Option<&'static str> {
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

async fn search_workspace(
    State(state): State<AppState>,
    MachineSession: MachineSession,
    Json(payload): Json<WorkspaceSearchRequest>,
) -> Result<Json<WorkspaceSearchResponse>, ApiError> {
    if payload.query.chars().count() > MAX_QUERY_CHARS {
        return Err(ApiError::bad_request(anyhow::anyhow!(
            "workspace search query is too long"
        )));
    }
    let permit = std::sync::Arc::clone(&state.workspace_search.search_slots)
        .acquire_owned()
        .await
        .map_err(|error| ApiError::internal(error.into()))?;
    let SearchOutcome { entries, scanning } = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let resolution = resolve_workspace_path(&payload.workspace_path, false)?;
        state.workspace_search.search(
            std::path::Path::new(&resolution.workspace_path),
            &payload.query,
        )
    })
    .await
    .map_err(|error| ApiError::internal(error.into()))?
    .map_err(ApiError::bad_request)?;
    Ok(Json(WorkspaceSearchResponse {
        entries: entries
            .into_iter()
            .map(|entry| WorkspaceSearchEntry {
                path: entry.path,
                kind: if entry.is_dir { "directory" } else { "file" },
            })
            .collect(),
        scanning,
    }))
}

async fn list_projects(
    State(state): State<AppState>,
    MachineSession: MachineSession,
) -> Result<Json<Vec<ProjectAttachmentRecord>>, ApiError> {
    let projects = state
        .project_attachments
        .list()
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(projects))
}

async fn attach_project(
    State(state): State<AppState>,
    MachineSession: MachineSession,
    Json(payload): Json<AttachProjectRequest>,
) -> Result<Json<ProjectAttachmentRecord>, ApiError> {
    let project = state
        .project_attachments
        .attach(payload)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(project))
}

async fn resolve_path(
    MachineSession: MachineSession,
    Json(payload): Json<WorkspacePathResolutionRequest>,
) -> Result<Json<WorkspacePathResolution>, ApiError> {
    let resolution = resolve_workspace_path(&payload.workspace_path, payload.create_if_missing)
        .map_err(ApiError::bad_request)?;
    Ok(Json(resolution))
}

async fn browse_path(
    MachineSession: MachineSession,
    Json(payload): Json<FilesystemBrowseRequest>,
) -> Result<Json<FilesystemBrowseResult>, ApiError> {
    let result = browse_filesystem(&payload.partial_path, payload.cwd.as_deref())
        .map_err(ApiError::bad_request)?;
    Ok(Json(result))
}

async fn list_skills(
    MachineSession: MachineSession,
    Json(payload): Json<WorkspaceSkillsRequest>,
) -> Result<Json<WorkspaceSkillsResponse>, ApiError> {
    let resolution =
        resolve_workspace_path(&payload.workspace_path, false).map_err(ApiError::bad_request)?;
    let loaded = load_workspace_skills(
        std::path::Path::new(&resolution.workspace_path),
        &default_user_skills_dirs(),
        BUILTIN_SKILLS,
    );
    let skills = loaded
        .skills
        .into_iter()
        .map(|skill| SkillSummary {
            name: skill.name,
            description: skill.description,
        })
        .collect();
    Ok(Json(WorkspaceSkillsResponse {
        skills,
        warnings: loaded.warnings,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{Body, to_bytes};
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    async fn image_test_app(data_dir: &Path) -> (axum::Router, String) {
        let auth = crate::auth::AuthState::load(data_dir).unwrap();
        let (_, token) = auth.bootstrap_browser_session(true).await.unwrap();
        auth.bind_session_user(&token, "test-user").await.unwrap();
        let native_auth = crate::native_auth::NativeAuthManager::configured_for_test(
            crate::native_auth::NativeAuthConfig {
                workos_client_id: "client_test".to_string(),
            },
            crate::auth::desktop_login_callback_url(7731),
        );
        let state = AppState::for_test(
            auth,
            native_auth,
            data_dir.to_path_buf(),
            true,
            crate::package_update::PackageUpdateManager::disabled(),
        );
        (routes().with_state(state), token)
    }

    fn image_request(workspace: Option<&Path>, path: &str, token: Option<&str>) -> Request<Body> {
        image_request_with_options(workspace, path, token, &[])
    }

    fn image_request_with_options(
        workspace: Option<&Path>,
        path: &str,
        token: Option<&str>,
        options: &[(&str, &str)],
    ) -> Request<Body> {
        let mut query = url::form_urlencoded::Serializer::new(String::new());
        if let Some(workspace) = workspace {
            query.append_pair("workspacePath", &workspace.to_string_lossy());
        }
        for (key, value) in options {
            query.append_pair(key, value);
        }
        let query = query.append_pair("path", path).finish();
        let uri = format!("/workspace/image?{query}");
        let mut builder = Request::builder().method("GET").uri(uri);
        if let Some(token) = token {
            builder = builder.header(
                "cookie",
                format!("{}={token}", crate::config::SESSION_COOKIE_NAME),
            );
        }
        builder.body(Body::empty()).unwrap()
    }

    #[tokio::test]
    async fn workspace_search_requires_session_and_returns_completion_entries() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        std::fs::create_dir(workspace.path().join("src")).unwrap();
        std::fs::write(workspace.path().join("src/main.rs"), "fn main() {}").unwrap();
        let auth = crate::auth::AuthState::load(data.path()).unwrap();
        let (_, token) = auth.bootstrap_browser_session(true).await.unwrap();
        auth.bind_session_user(&token, "test-user").await.unwrap();
        let native_auth = crate::native_auth::NativeAuthManager::configured_for_test(
            crate::native_auth::NativeAuthConfig {
                workos_client_id: "client_test".to_string(),
            },
            crate::auth::desktop_login_callback_url(7731),
        );
        let state = AppState::for_test(
            auth,
            native_auth,
            data.path().to_path_buf(),
            true,
            crate::package_update::PackageUpdateManager::disabled(),
        );
        let app = routes().with_state(state);
        let payload =
            serde_json::json!({"workspacePath": workspace.path(), "query": "src"}).to_string();
        let request = |body: String, token: Option<&str>| {
            let mut builder = Request::builder()
                .method("POST")
                .uri("/workspace/search")
                .header("content-type", "application/json");
            if let Some(token) = token {
                builder = builder.header("authorization", format!("Bearer {token}"));
            }
            builder.body(Body::from(body)).unwrap()
        };
        let denied = app
            .clone()
            .oneshot(request(payload.clone(), None))
            .await
            .unwrap();
        assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);
        let oversized = serde_json::json!({"workspacePath": workspace.path(), "query": "x".repeat(MAX_QUERY_CHARS + 1)}).to_string();
        let invalid = app
            .clone()
            .oneshot(request(oversized, Some(&token)))
            .await
            .unwrap();
        assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            let response = app
                .clone()
                .oneshot(request(payload.clone(), Some(&token)))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let body = to_bytes(response.into_body(), 65536).await.unwrap();
            let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
            if value["scanning"] == false {
                let entries = value["entries"].as_array().unwrap();
                assert!(
                    entries
                        .iter()
                        .any(|entry| entry["path"] == "src" && entry["kind"] == "directory")
                );
                assert!(
                    entries
                        .iter()
                        .any(|entry| entry["path"] == "src/main.rs" && entry["kind"] == "file")
                );
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "workspace scan timed out"
            );
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    }

    #[tokio::test]
    async fn local_image_serves_relative_and_absolute_images_without_an_attachment() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let image = b"\x89PNG\r\n\x1a\npng-data";
        std::fs::create_dir(workspace.path().join("images")).unwrap();
        std::fs::write(workspace.path().join("images/photo.bin"), image).unwrap();
        std::fs::write(
            workspace.path().join("images/vector.svg"),
            b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>",
        )
        .unwrap();
        let (app, token) = image_test_app(data.path()).await;

        let denied = app
            .clone()
            .oneshot(image_request(
                Some(workspace.path()),
                "images/photo.bin",
                None,
            ))
            .await
            .unwrap();
        assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);

        let mut paths = vec![
            "images/photo.bin".to_string(),
            workspace
                .path()
                .join("images/photo.bin")
                .to_string_lossy()
                .into_owned(),
        ];
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(
                workspace.path().join("images/photo.bin"),
                workspace.path().join("images/internal-link.png"),
            )
            .unwrap();
            paths.push("images/internal-link.png".to_string());
        }
        for path in paths {
            let response = app
                .clone()
                .oneshot(image_request(Some(workspace.path()), &path, Some(&token)))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.headers()[header::CONTENT_TYPE], "image/png");
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
            assert_eq!(
                response.headers()[header::X_CONTENT_TYPE_OPTIONS],
                "nosniff"
            );
            let contents = to_bytes(response.into_body(), 1024).await.unwrap();
            assert_eq!(contents.as_ref(), &image[..]);
        }

        let svg = app
            .oneshot(image_request(
                Some(workspace.path()),
                "images/vector.svg",
                Some(&token),
            ))
            .await
            .unwrap();
        assert_eq!(svg.status(), StatusCode::OK);
        assert_eq!(svg.headers()[header::CONTENT_TYPE], "image/svg+xml");
        assert_eq!(
            svg.headers().get("content-security-policy").unwrap(),
            "sandbox; default-src 'none'"
        );
    }

    #[tokio::test]
    async fn local_image_scopes_image_data_and_revisions_to_transcript_threads() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let transcript = sprocket_agent::TranscriptStore::new(data.path().join("transcripts"));
        let path = "parse_file/550e8400-e29b-41d4-a716-446655440000.png";
        let first = b"\x89PNG\r\n\x1a\nfirst";
        let second = b"\x89PNG\r\n\x1a\nsecond";
        let workspace_image = b"\x89PNG\r\n\x1a\nworkspace";
        std::fs::create_dir(workspace.path().join("parse_file")).unwrap();
        std::fs::write(workspace.path().join(path), workspace_image).unwrap();
        let (app, token) = image_test_app(data.path()).await;

        for (thread_id, contents, seconds) in
            [("thread_1", &first[..], 1), ("thread-2", &second[..], 2)]
        {
            let thread_dir = transcript.thread_dir("test-user", thread_id);
            std::fs::create_dir_all(thread_dir.join("parse_file")).unwrap();
            let image_path = thread_dir.join(path);
            std::fs::write(&image_path, contents).unwrap();
            std::fs::File::options()
                .write(true)
                .open(&image_path)
                .unwrap()
                .set_times(
                    std::fs::FileTimes::new().set_modified(
                        std::time::UNIX_EPOCH + std::time::Duration::from_secs(seconds),
                    ),
                )
                .unwrap();

            for workspace_root in [Some(workspace.path()), None] {
                for revision_only in [false, true] {
                    let response = app
                        .clone()
                        .oneshot(image_request_with_options(
                            workspace_root,
                            path,
                            Some(&token),
                            &[
                                ("userId", "test-user"),
                                ("threadId", thread_id),
                                ("revisionOnly", if revision_only { "true" } else { "false" }),
                            ],
                        ))
                        .await
                        .unwrap();
                    assert_eq!(response.status(), StatusCode::OK);
                    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
                    if !revision_only {
                        assert_eq!(response.headers()[header::CONTENT_TYPE], "image/png");
                        assert_eq!(
                            response.headers()[header::X_CONTENT_TYPE_OPTIONS],
                            "nosniff"
                        );
                    }
                    let body = to_bytes(response.into_body(), 1024).await.unwrap();
                    if revision_only {
                        let revision = serde_json::from_slice::<String>(&body).unwrap();
                        assert_eq!(
                            revision,
                            format!("{}-{}", contents.len(), seconds * 1_000_000_000)
                        );
                    } else {
                        assert_eq!(body.as_ref(), contents);
                    }
                }
            }
        }

        let unscoped = app
            .clone()
            .oneshot(image_request(Some(workspace.path()), path, Some(&token)))
            .await
            .unwrap();
        assert_eq!(unscoped.status(), StatusCode::OK);
        let body = to_bytes(unscoped.into_body(), 1024).await.unwrap();
        assert_eq!(body.as_ref(), &workspace_image[..]);

        for revision_only in [false, true] {
            let missing = app
                .clone()
                .oneshot(image_request_with_options(
                    None,
                    path,
                    Some(&token),
                    &[
                        ("userId", "test-user"),
                        ("threadId", "missing-thread"),
                        ("revisionOnly", if revision_only { "true" } else { "false" }),
                    ],
                ))
                .await
                .unwrap();
            if revision_only {
                assert_eq!(missing.status(), StatusCode::OK);
                let body = to_bytes(missing.into_body(), 1024).await.unwrap();
                assert_eq!(body.as_ref(), b"null");
            } else {
                assert_eq!(missing.status(), StatusCode::BAD_REQUEST);
            }
        }
    }

    #[tokio::test]
    async fn local_image_falls_back_to_workspace_when_the_thread_cache_file_is_missing() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let transcript = sprocket_agent::TranscriptStore::new(data.path().join("transcripts"));
        let thread_dir = transcript.thread_dir("test-user", "thread-1");
        let path = "parse_file/board.png";
        let contents = b"\x89PNG\r\n\x1a\nworkspace";
        std::fs::create_dir(workspace.path().join("parse_file")).unwrap();
        std::fs::write(workspace.path().join(path), contents).unwrap();
        let (app, token) = image_test_app(data.path()).await;

        for cache_directory_exists in [false, true] {
            if cache_directory_exists {
                std::fs::create_dir_all(thread_dir.join("parse_file")).unwrap();
            }
            for revision_only in ["false", "true"] {
                let response = app
                    .clone()
                    .oneshot(image_request_with_options(
                        Some(workspace.path()),
                        path,
                        Some(&token),
                        &[
                            ("userId", "test-user"),
                            ("threadId", "thread-1"),
                            ("revisionOnly", revision_only),
                        ],
                    ))
                    .await
                    .unwrap();
                assert_eq!(response.status(), StatusCode::OK);
                let body = to_bytes(response.into_body(), 1024).await.unwrap();
                if revision_only == "true" {
                    let revision = serde_json::from_slice::<String>(&body).unwrap();
                    let metadata = std::fs::metadata(workspace.path().join(path)).unwrap();
                    let nanos = metadata
                        .modified()
                        .unwrap()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap()
                        .as_nanos();
                    assert_eq!(revision, format!("{}-{nanos}", contents.len()));
                } else {
                    assert_eq!(body.as_ref(), contents);
                }
            }
        }
    }

    #[tokio::test]
    async fn local_image_serves_each_thread_image_tool_cache() {
        let data = tempfile::tempdir().unwrap();
        let transcript = sprocket_agent::TranscriptStore::new(data.path().join("transcripts"));
        let thread_dir = transcript.thread_dir("test-user", "thread-1");
        let (app, token) = image_test_app(data.path()).await;
        let contents = b"\x89PNG\r\n\x1a\n";
        for tool in ["parse_file", "screenshot_url", "scrape_url"] {
            std::fs::create_dir_all(thread_dir.join(tool)).unwrap();
            let path = format!("{tool}/photo.png");
            std::fs::write(thread_dir.join(&path), contents).unwrap();
            let response = app
                .clone()
                .oneshot(image_request_with_options(
                    None,
                    &path,
                    Some(&token),
                    &[("userId", "test-user"), ("threadId", "thread-1")],
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(
                to_bytes(response.into_body(), 1024).await.unwrap().as_ref(),
                contents
            );
        }
    }

    #[tokio::test]
    async fn local_image_rejects_incomplete_scopes_and_mismatched_session_users() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        std::fs::create_dir(workspace.path().join("parse_file")).unwrap();
        std::fs::write(
            workspace.path().join("parse_file/photo.png"),
            b"\x89PNG\r\n\x1a\n",
        )
        .unwrap();
        let (app, token) = image_test_app(data.path()).await;

        for revision_only in ["false", "true"] {
            for (user_id, thread_id, session_token, expected_status) in [
                (
                    Some("test-user"),
                    None,
                    Some(token.as_str()),
                    StatusCode::BAD_REQUEST,
                ),
                (
                    None,
                    Some("thread-1"),
                    Some(token.as_str()),
                    StatusCode::BAD_REQUEST,
                ),
                (
                    Some("other-user"),
                    Some("thread-1"),
                    Some(token.as_str()),
                    StatusCode::UNAUTHORIZED,
                ),
                (
                    Some(""),
                    Some("thread-1"),
                    Some(token.as_str()),
                    StatusCode::UNAUTHORIZED,
                ),
                (
                    Some("test-user"),
                    Some("thread-1"),
                    None,
                    StatusCode::UNAUTHORIZED,
                ),
            ] {
                let mut options = vec![("revisionOnly", revision_only)];
                if let Some(user_id) = user_id {
                    options.push(("userId", user_id));
                }
                if let Some(thread_id) = thread_id {
                    options.push(("threadId", thread_id));
                }
                let response = app
                    .clone()
                    .oneshot(image_request_with_options(
                        Some(workspace.path()),
                        "parse_file/photo.png",
                        session_token,
                        &options,
                    ))
                    .await
                    .unwrap();
                assert_eq!(response.status(), expected_status, "{options:?}");
            }
        }
    }

    #[tokio::test]
    async fn local_image_rejects_unsafe_thread_ids_and_scoped_paths() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let (app, token) = image_test_app(data.path()).await;
        let absolute_path = workspace.path().join("parse_file/photo.png");
        let absolute_path = absolute_path.to_str().unwrap();
        let mut cases = vec![
            ("thread-1", ""),
            ("thread-1", "parse_file"),
            ("thread-1", "parse_file/"),
            ("thread-1", "images/photo.png"),
            ("thread-1", "parse_file_other/photo.png"),
            ("thread-1", "../parse_file/photo.png"),
            ("thread-1", "./parse_file/photo.png"),
            ("thread-1", "parse_file/../photo.png"),
            ("thread-1", "parse_file/./photo.png"),
            ("thread-1", "parse_file/nested/../../photo.png"),
            ("thread-1", "parse_file/..\\photo.png"),
            ("thread-1", "/parse_file/photo.png"),
            ("thread-1", absolute_path),
        ];
        for thread_id in [
            "",
            "blobs",
            "BLOBS",
            "pending-attachments",
            "Pending-Attachments",
            "..",
            "thread/1",
            "thread\\1",
            "thread.1",
            "thread:1",
            "thread 1",
            "thréad",
        ] {
            cases.push((thread_id, "parse_file/photo.png"));
        }
        for revision_only in ["false", "true"] {
            for (thread_id, path) in &cases {
                let response = app
                    .clone()
                    .oneshot(image_request_with_options(
                        Some(workspace.path()),
                        path,
                        Some(&token),
                        &[
                            ("userId", "test-user"),
                            ("threadId", thread_id),
                            ("revisionOnly", revision_only),
                        ],
                    ))
                    .await
                    .unwrap();
                assert_eq!(
                    response.status(),
                    StatusCode::BAD_REQUEST,
                    "{thread_id:?}: {path}"
                );
            }
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn local_image_rejects_thread_images_linked_outside_the_transcript_directory() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let transcript = sprocket_agent::TranscriptStore::new(data.path().join("transcripts"));
        let thread_dir = transcript.thread_dir("test-user", "thread-1");
        std::fs::create_dir_all(thread_dir.join("parse_file")).unwrap();
        let outside_image = workspace.path().join("outside.png");
        std::fs::write(&outside_image, b"\x89PNG\r\n\x1a\n").unwrap();
        std::os::unix::fs::symlink(&outside_image, thread_dir.join("parse_file/linked.png"))
            .unwrap();
        let (app, token) = image_test_app(data.path()).await;
        let response = app
            .oneshot(image_request_with_options(
                Some(workspace.path()),
                "parse_file/linked.png",
                Some(&token),
                &[("userId", "test-user"), ("threadId", "thread-1")],
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn local_image_revision_tracks_overwrites_and_missing_files_without_reading_contents() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let path = workspace.path().join("board.png");
        let (app, token) = image_test_app(data.path()).await;
        let revision_request = |token: Option<&str>| {
            let mut request = image_request(Some(workspace.path()), "board.png", token);
            *request.uri_mut() = format!("{}&revisionOnly=true", request.uri())
                .parse()
                .unwrap();
            request
        };
        let denied = app.clone().oneshot(revision_request(None)).await.unwrap();
        assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);
        let missing = app
            .clone()
            .oneshot(revision_request(Some(&token)))
            .await
            .unwrap();
        assert_eq!(missing.status(), StatusCode::OK);
        assert_eq!(missing.headers()[header::CACHE_CONTROL], "no-store");
        let contents = to_bytes(missing.into_body(), 1024).await.unwrap();
        assert_eq!(contents.as_ref(), b"null");

        let mut revisions = Vec::new();
        for (contents, seconds) in [(b"first", 1), (b"other", 2)] {
            std::fs::write(&path, contents).unwrap();
            std::fs::File::options()
                .write(true)
                .open(&path)
                .unwrap()
                .set_times(
                    std::fs::FileTimes::new().set_modified(
                        std::time::UNIX_EPOCH + std::time::Duration::from_secs(seconds),
                    ),
                )
                .unwrap();
            let response = app
                .clone()
                .oneshot(revision_request(Some(&token)))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let body = to_bytes(response.into_body(), 1024).await.unwrap();
            revisions.push(serde_json::from_slice::<String>(&body).unwrap());
        }
        assert_ne!(revisions[0], revisions[1]);
        let image = app
            .oneshot(image_request(
                Some(workspace.path()),
                "board.png",
                Some(&token),
            ))
            .await
            .unwrap();
        assert_eq!(image.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn local_image_serves_images_outside_the_workspace() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("outside.png"), b"\x89PNG\r\n\x1a\n").unwrap();
        let (app, token) = image_test_app(data.path()).await;

        let traversal_path = Path::new("..")
            .join(outside.path().file_name().unwrap())
            .join("outside.png");
        for (base, path) in [
            (Some(workspace.path()), traversal_path),
            (None, outside.path().join("outside.png")),
        ] {
            let response = app
                .clone()
                .oneshot(image_request(base, &path.to_string_lossy(), Some(&token)))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.headers()[header::CONTENT_TYPE], "image/png");
            let contents = to_bytes(response.into_body(), 1024).await.unwrap();
            assert_eq!(contents.as_ref(), b"\x89PNG\r\n\x1a\n");
        }

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(
                outside.path().join("outside.png"),
                workspace.path().join("linked.png"),
            )
            .unwrap();
            let linked_image = app
                .oneshot(image_request(
                    Some(workspace.path()),
                    "linked.png",
                    Some(&token),
                ))
                .await
                .unwrap();
            assert_eq!(linked_image.status(), StatusCode::OK);
        }
    }

    #[tokio::test]
    async fn local_image_rejects_unsupported_oversized_or_nonregular_files() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        std::fs::write(workspace.path().join("fake.png"), b"not an image").unwrap();
        std::fs::File::create(workspace.path().join("oversized.png"))
            .unwrap()
            .set_len(MAX_LOCAL_IMAGE_BYTES + 1)
            .unwrap();
        std::fs::create_dir(workspace.path().join("directory.png")).unwrap();
        let (app, token) = image_test_app(data.path()).await;

        for path in ["fake.png", "oversized.png", "directory.png"] {
            let response = app
                .clone()
                .oneshot(image_request(Some(workspace.path()), path, Some(&token)))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{path}");
        }
    }

    #[test]
    fn image_sniffing_recognizes_supported_formats_and_sandboxes_svg() {
        let avif = [
            0, 0, 0, 16, b'f', b't', b'y', b'p', b'a', b'v', b'i', b'f', 0, 0, 0, 0,
        ];
        for (contents, expected_type) in [
            (&b"\x89PNG\r\n\x1a\n"[..], "image/png"),
            (&b"\xff\xd8\xff\x00"[..], "image/jpeg"),
            (&b"GIF89a"[..], "image/gif"),
            (&b"RIFF\x04\x00\x00\x00WEBP"[..], "image/webp"),
            (&b"BM"[..], "image/bmp"),
            (&avif[..], "image/avif"),
            (
                &b"<?xml version=\"1.0\"?><svg xmlns=\"http://www.w3.org/2000/svg\"/>"[..],
                "image/svg+xml",
            ),
            (
                &b"<?xml version=\"1.0\"?><!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd\"><svg/>"[..],
                "image/svg+xml",
            ),
            (
                &b"<!DOCTYPE svg [<!ENTITY label \"Board > layout\">]><svg/>"[..],
                "image/svg+xml",
            ),
        ] {
            assert_eq!(detect_image_media_type(contents), Some(expected_type));
        }
        assert_eq!(detect_image_media_type(b"plain text"), None);
    }
}
