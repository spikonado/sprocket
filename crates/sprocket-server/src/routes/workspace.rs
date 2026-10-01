use axum::Json;
use axum::extract::State;
use axum::routing::{get, post};
use serde::{Deserialize, Serialize};

use crate::AppState;
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

    #[tokio::test]
    async fn workspace_search_requires_session_and_returns_completion_entries() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        std::fs::create_dir(workspace.path().join("src")).unwrap();
        std::fs::write(workspace.path().join("src/main.rs"), "fn main() {}").unwrap();
        let auth = crate::auth::AuthState::load(data.path()).unwrap();
        let (_, token) = auth.bootstrap_browser_session(true).await.unwrap();
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
}
