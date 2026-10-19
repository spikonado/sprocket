mod image;
#[cfg(test)]
mod tests;

use axum::Json;
use axum::extract::State;
use axum::routing::{get, post};
use serde::{Deserialize, Serialize};

use crate::AppState;
use crate::routes::api_error::ApiError;
use crate::routes::session::MachineSession;
use sprocket_host::project_attachments::{
    AttachProjectRequest, ProjectAttachmentRecord, WorkspacePathResolution, resolve_workspace_path,
};
use sprocket_host::workspace_search::{
    GitStatusEntry, MAX_QUERY_CHARS, PathListing, SearchOutcome,
};
use sprocket_workspace::{
    BUILTIN_SKILLS, FilesystemBrowseResult, WorkspaceFileContent, WorkspaceFileWrite,
    browse_filesystem, create_workspace_entry, default_user_skills_dirs, delete_workspace_entry,
    load_workspace_skills, read_workspace_file, rename_workspace_entry, write_workspace_file,
};

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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceFilesRequest {
    workspace_path: String,
    known_hash: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceFilesResponse {
    paths: Vec<String>,
    git_status: Vec<GitStatusEntry>,
    scanning: bool,
    truncated: bool,
    hash: String,
    unchanged: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceEntryRequest {
    workspace_path: String,
    path: String,
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
struct EmptyResponse {}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SkillSummary {
    name: String,
    description: String,
    disable_model_invocation: bool,
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
        .route("/workspace/files", post(list_workspace_files))
        .route("/workspace/file/read", post(read_file))
        .route("/workspace/file/write", post(write_file))
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

async fn read_file(
    MachineSession: MachineSession,
    Json(payload): Json<WorkspaceEntryRequest>,
) -> Result<Json<WorkspaceFileContent>, ApiError> {
    in_workspace(payload.workspace_path, move |root| {
        read_workspace_file(root, &payload.path)
    })
    .await
    .map(Json)
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
) -> Result<Json<EmptyResponse>, ApiError> {
    in_workspace(payload.workspace_path, move |root| {
        create_workspace_entry(root, &payload.path, payload.directory)
    })
    .await?;
    Ok(Json(EmptyResponse {}))
}

async fn rename_entry(
    MachineSession: MachineSession,
    Json(payload): Json<WorkspaceEntryRenameRequest>,
) -> Result<Json<EmptyResponse>, ApiError> {
    in_workspace(payload.workspace_path, move |root| {
        rename_workspace_entry(root, &payload.from, &payload.to)
    })
    .await?;
    Ok(Json(EmptyResponse {}))
}

async fn delete_entry(
    MachineSession: MachineSession,
    Json(payload): Json<WorkspaceEntryRequest>,
) -> Result<Json<EmptyResponse>, ApiError> {
    in_workspace(payload.workspace_path, move |root| {
        delete_workspace_entry(root, &payload.path)
    })
    .await?;
    Ok(Json(EmptyResponse {}))
}

async fn list_workspace_files(
    State(state): State<AppState>,
    MachineSession: MachineSession,
    Json(payload): Json<WorkspaceFilesRequest>,
) -> Result<Json<WorkspaceFilesResponse>, ApiError> {
    let permit = std::sync::Arc::clone(&state.host.workspace_search.search_slots)
        .acquire_owned()
        .await
        .map_err(|error| ApiError::internal(error.into()))?;
    let listing = in_workspace(payload.workspace_path, move |root| {
        let _permit = permit;
        state.host.workspace_search.list_paths(root)
    })
    .await?;
    let hash = listing.content_hash();
    let unchanged = payload.known_hash.as_deref() == Some(hash.as_str());
    let PathListing {
        paths,
        git_status,
        scanning,
        truncated,
    } = if unchanged {
        PathListing {
            scanning: listing.scanning,
            truncated: listing.truncated,
            ..Default::default()
        }
    } else {
        listing
    };
    Ok(Json(WorkspaceFilesResponse {
        paths,
        git_status,
        scanning,
        truncated,
        hash,
        unchanged,
    }))
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
