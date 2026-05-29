use axum::Json;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum_extra::extract::CookieJar;
use serde::Deserialize;

use crate::AppState;
use crate::auth::require_session;
use crate::workspace_sessions::{
    AttachWorkspaceSessionRequest, WorkspaceSessionRecord, workspace_overview_for_path,
};
use sprocket_workspace::{FilesystemBrowseResult, browse_filesystem};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceOverviewRequest {
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

pub fn routes() -> axum::Router<AppState> {
    axum::Router::new()
        .route(
            "/workspace/sessions",
            get(list_sessions).post(attach_session),
        )
        .route(
            "/workspace/sessions/{workspace_session_id}",
            get(session_overview),
        )
        .route("/workspace/overview", post(overview_for_path))
        .route("/workspace/browse", post(browse_path))
}

async fn list_sessions(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
) -> Result<Json<Vec<WorkspaceSessionRecord>>, ApiError> {
    require_session(&state.auth, &headers, &jar)
        .await
        .map_err(ApiError::unauthorized)?;
    let sessions = state
        .workspace_sessions
        .list()
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(sessions))
}

async fn attach_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(payload): Json<AttachWorkspaceSessionRequest>,
) -> Result<Json<WorkspaceSessionRecord>, ApiError> {
    require_session(&state.auth, &headers, &jar)
        .await
        .map_err(ApiError::unauthorized)?;
    let session = state
        .workspace_sessions
        .attach(payload)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(session))
}

async fn session_overview(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Path(workspace_session_id): Path<String>,
) -> Result<Json<sprocket_workspace::WorkspaceOverview>, ApiError> {
    require_session(&state.auth, &headers, &jar)
        .await
        .map_err(ApiError::unauthorized)?;
    let overview = state
        .workspace_sessions
        .overview(&workspace_session_id)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(overview))
}

async fn overview_for_path(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(payload): Json<WorkspaceOverviewRequest>,
) -> Result<Json<sprocket_workspace::WorkspaceOverview>, ApiError> {
    require_session(&state.auth, &headers, &jar)
        .await
        .map_err(ApiError::unauthorized)?;
    let overview = workspace_overview_for_path(&payload.workspace_path, payload.create_if_missing)
        .map_err(ApiError::bad_request)?;
    Ok(Json(overview))
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
