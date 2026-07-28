use axum::Json;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum_extra::extract::CookieJar;
use serde::{Deserialize, Serialize};

use crate::AppState;
use crate::auth::require_session;
use crate::project_attachments::{
    AttachProjectRequest, ProjectAttachmentRecord, WorkspacePathResolution, resolve_workspace_path,
};
use sprocket_workspace::{
    BUILTIN_SKILLS, FilesystemBrowseResult, browse_filesystem, default_user_skills_dirs,
    load_workspace_skills,
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
}

async fn list_projects(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
) -> Result<Json<Vec<ProjectAttachmentRecord>>, ApiError> {
    require_session(&state.auth, &headers, &jar)
        .await
        .map_err(ApiError::unauthorized)?;
    let projects = state
        .project_attachments
        .list()
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(projects))
}

async fn attach_project(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(payload): Json<AttachProjectRequest>,
) -> Result<Json<ProjectAttachmentRecord>, ApiError> {
    require_session(&state.auth, &headers, &jar)
        .await
        .map_err(ApiError::unauthorized)?;
    let project = state
        .project_attachments
        .attach(payload)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(project))
}

async fn resolve_path(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(payload): Json<WorkspacePathResolutionRequest>,
) -> Result<Json<WorkspacePathResolution>, ApiError> {
    require_session(&state.auth, &headers, &jar)
        .await
        .map_err(ApiError::unauthorized)?;
    let resolution = resolve_workspace_path(&payload.workspace_path, payload.create_if_missing)
        .map_err(ApiError::bad_request)?;
    Ok(Json(resolution))
}

async fn browse_path(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(payload): Json<FilesystemBrowseRequest>,
) -> Result<Json<FilesystemBrowseResult>, ApiError> {
    require_session(&state.auth, &headers, &jar)
        .await
        .map_err(ApiError::unauthorized)?;
    let result = browse_filesystem(&payload.partial_path, payload.cwd.as_deref())
        .map_err(ApiError::bad_request)?;
    Ok(Json(result))
}

async fn list_skills(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(payload): Json<WorkspaceSkillsRequest>,
) -> Result<Json<WorkspaceSkillsResponse>, ApiError> {
    require_session(&state.auth, &headers, &jar)
        .await
        .map_err(ApiError::unauthorized)?;
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

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn unauthorized(error: anyhow::Error) -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            message: error.to_string(),
        }
    }

    fn bad_request(error: anyhow::Error) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: error.to_string(),
        }
    }

    fn internal(error: anyhow::Error) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: error.to_string(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(serde_json::json!({ "error": self.message })),
        )
            .into_response()
    }
}
