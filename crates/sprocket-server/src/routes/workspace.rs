mod image;
#[cfg(test)]
mod tests;

use std::sync::Arc;
use std::time::Duration;

use axum::Json;
use axum::extract::{DefaultBodyLimit, State};
use axum::routing::{get, post};
use futures::StreamExt;
use futures::stream::BoxStream;
use serde::{Deserialize, Serialize};

use crate::AppState;
use crate::routes::api_error::ApiError;
use crate::routes::session::MachineSession;
use sprocket_host::project_attachments::{
    AttachProjectRequest, ProjectAttachmentRecord, WorkspacePathResolution, resolve_workspace_path,
};
use sprocket_host::workspace_search::{MAX_QUERY_CHARS, PathListing, SearchOutcome};
use sprocket_workspace::{
    BUILTIN_SKILLS, FilesystemBrowseResult, MAX_EDITABLE_FILE_BYTES, WorkspaceEntryKind,
    WorkspaceFileContent, WorkspaceFileWrite, browse_filesystem, create_workspace_entry,
    default_user_skills_dirs, delete_workspace_entry, load_workspace_skills, read_workspace_file,
    read_workspace_text, rename_workspace_entry, workspace_entry_kind, write_workspace_file,
};

/// JSON escaping can grow content up to 6x (`\u0000`), plus room for the other fields.
const WRITE_BODY_LIMIT: usize = MAX_EDITABLE_FILE_BYTES as usize * 6 + 64 * 1024;
const DISK_CHECK_INTERVAL: Duration = Duration::from_secs(1);
const SCANNING_CHECK_INTERVAL: Duration = Duration::from_millis(250);

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
struct RemoveProjectRequest {
    workspace_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceSearchRequest {
    workspace_path: String,
    query: String,
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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceFilesWatchRequest {
    workspace_path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceEntryRequest {
    workspace_path: String,
    path: String,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum DiskEvent<T> {
    Snapshot(T),
    Error { message: String },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceFileWriteRequest {
    workspace_path: String,
    path: String,
    content: String,
    expected_version: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceEntryCreateRequest {
    workspace_path: String,
    path: String,
    directory: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceEntryRenameRequest {
    workspace_path: String,
    from: String,
    to: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SkillSummary {
    name: String,
    description: String,
    disable_model_invocation: bool,
}

#[derive(Debug, Serialize)]
struct WorkspaceEntryResponse {
    kind: WorkspaceEntryKind,
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
            get(list_projects)
                .post(attach_project)
                .delete(remove_project),
        )
        .route("/workspace/resolve", post(resolve_path))
        .route("/workspace/browse", post(browse_path))
        .route("/workspace/skills", post(list_skills))
        .route("/workspace/search", post(search_workspace))
        .route("/workspace/entry", post(entry_kind))
        .route("/workspace/file/text", post(read_text))
        .route(
            "/workspace/file/write",
            post(write_file).layer(DefaultBodyLimit::max(WRITE_BODY_LIMIT)),
        )
        .route("/workspace/file/create", post(create_entry))
        .route("/workspace/file/rename", post(rename_entry))
        .route("/workspace/file/delete", post(delete_entry))
        .route("/workspace/image", get(image::local_image))
}

async fn in_workspace<T: Send + 'static>(
    workspace_path: String,
    operation: impl FnOnce(&std::path::Path) -> anyhow::Result<T> + Send + 'static,
) -> Result<T, ApiError> {
    tokio::task::spawn_blocking(move || {
        let resolution = resolve_workspace_path(&workspace_path, false)?;
        operation(std::path::Path::new(&resolution.workspace_path))
    })
    .await
    .map_err(|error| ApiError::internal(error.into()))?
    .map_err(ApiError::bad_request)
}

async fn entry_kind(
    MachineSession: MachineSession,
    Json(payload): Json<WorkspaceEntryRequest>,
) -> Result<Json<WorkspaceEntryResponse>, ApiError> {
    in_workspace(payload.workspace_path, move |root| {
        workspace_entry_kind(root, &payload.path)
    })
    .await
    .map(|kind| Json(WorkspaceEntryResponse { kind }))
}

pub(crate) fn file_events(
    request: WorkspaceEntryRequest,
) -> BoxStream<'static, DiskEvent<WorkspaceFileContent>> {
    disk_changes(
        move || {
            let WorkspaceEntryRequest {
                workspace_path,
                path,
            } = request.clone();
            in_workspace(workspace_path, move |root| read_workspace_file(root, &path))
        },
        |content| (content.version.clone(), DISK_CHECK_INTERVAL),
    )
}

pub(crate) fn file_list_events(
    state: &AppState,
    request: WorkspaceFilesWatchRequest,
) -> BoxStream<'static, DiskEvent<PathListing>> {
    let search = Arc::clone(&state.host.workspace_search);
    disk_changes(
        move || {
            let search = Arc::clone(&search);
            let workspace_path = request.workspace_path.clone();
            async move {
                let permit = Arc::clone(&search.search_slots)
                    .acquire_owned()
                    .await
                    .map_err(|error| ApiError::internal(error.into()))?;
                in_workspace(workspace_path, move |root| {
                    let _permit = permit;
                    search.list_paths(root)
                })
                .await
            }
        },
        |listing| {
            let fingerprint = format!("{}:{}", listing.content_hash(), listing.scanning);
            let wait = if listing.scanning {
                SCANNING_CHECK_INTERVAL
            } else {
                DISK_CHECK_INTERVAL
            };
            (fingerprint, wait)
        },
    )
}

/// Re-reads on a timer and sends only changes. The file list comes from fff's
/// in-memory index, which its watcher keeps current. Its watch callbacks skip
/// git-status-only changes and stop silently when the picker is evicted, so a
/// cheap re-read is more reliable than subscribing to them.
fn disk_changes<T, Read, Reading>(
    read: Read,
    fingerprint: fn(&T) -> (String, Duration),
) -> BoxStream<'static, DiskEvent<T>>
where
    T: Send + 'static,
    Read: Fn() -> Reading + Send + 'static,
    Reading: std::future::Future<Output = Result<T, ApiError>> + Send,
{
    futures::stream::unfold(
        (read, None::<Result<String, String>>, Duration::ZERO),
        move |(read, last, mut wait)| async move {
            loop {
                tokio::time::sleep(wait).await;
                let (event, key) = match read().await {
                    Ok(value) => {
                        let (key, next_wait) = fingerprint(&value);
                        wait = next_wait;
                        (DiskEvent::Snapshot(value), Ok(key))
                    }
                    Err(error) => {
                        wait = DISK_CHECK_INTERVAL;
                        let message = error.to_string();
                        (
                            DiskEvent::Error {
                                message: message.clone(),
                            },
                            Err(message),
                        )
                    }
                };
                if last.as_ref() != Some(&key) {
                    return Some((event, (read, Some(key), wait)));
                }
            }
        },
    )
    .boxed()
}

/// Plain text, so viewers skip JSON escaping of boards that reach ~100 MiB.
async fn read_text(
    MachineSession: MachineSession,
    Json(payload): Json<WorkspaceEntryRequest>,
) -> Result<String, ApiError> {
    in_workspace(payload.workspace_path, move |root| {
        read_workspace_text(root, &payload.path)
    })
    .await
}

async fn write_file(
    MachineSession: MachineSession,
    Json(payload): Json<WorkspaceFileWriteRequest>,
) -> Result<Json<WorkspaceFileWrite>, ApiError> {
    in_workspace(payload.workspace_path, move |root| {
        write_workspace_file(
            root,
            &payload.path,
            &payload.content,
            payload.expected_version.as_deref(),
        )
    })
    .await
    .map(Json)
}

async fn create_entry(
    MachineSession: MachineSession,
    Json(payload): Json<WorkspaceEntryCreateRequest>,
) -> Result<Json<()>, ApiError> {
    in_workspace(payload.workspace_path, move |root| {
        create_workspace_entry(root, &payload.path, payload.directory)
    })
    .await
    .map(Json)
}

async fn rename_entry(
    MachineSession: MachineSession,
    Json(payload): Json<WorkspaceEntryRenameRequest>,
) -> Result<Json<()>, ApiError> {
    in_workspace(payload.workspace_path, move |root| {
        rename_workspace_entry(root, &payload.from, &payload.to)
    })
    .await
    .map(Json)
}

async fn delete_entry(
    MachineSession: MachineSession,
    Json(payload): Json<WorkspaceEntryRequest>,
) -> Result<Json<()>, ApiError> {
    in_workspace(payload.workspace_path, move |root| {
        delete_workspace_entry(root, &payload.path)
    })
    .await
    .map(Json)
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
    let permit = std::sync::Arc::clone(&state.host.workspace_search.search_slots)
        .acquire_owned()
        .await
        .map_err(|error| ApiError::internal(error.into()))?;
    let SearchOutcome { entries, scanning } = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let resolution = resolve_workspace_path(&payload.workspace_path, false)?;
        state.host.workspace_search.search(
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
        .host
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
        .host
        .project_attachments
        .attach(payload)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(project))
}

async fn remove_project(
    State(state): State<AppState>,
    MachineSession: MachineSession,
    Json(payload): Json<RemoveProjectRequest>,
) -> Result<Json<()>, ApiError> {
    state
        .host
        .project_attachments
        .remove(&payload.workspace_path)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(()))
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
            disable_model_invocation: skill.disable_model_invocation,
        })
        .collect();
    Ok(Json(WorkspaceSkillsResponse {
        skills,
        warnings: loaded.warnings,
    }))
}
