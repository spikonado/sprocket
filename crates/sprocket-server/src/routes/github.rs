use std::path::{Path, PathBuf};

use axum::Json;
use axum::extract::State;
use axum::routing::{get, post};
use serde::Deserialize;
use sprocket_host::ToolInstall;
use sprocket_host::device_sign_in::SignInStatus;
use sprocket_host::github_connector::GitHubConnectorStatus;
use sprocket_host::project_attachments::{WorkspacePathResolution, resolve_workspace_path};
use sprocket_workspace::github::is_valid_host;
use sprocket_workspace::github::repositories::{
    CloneTarget, Visibility, clone_repository, create_repository,
};
use sprocket_workspace::resolve_or_create_workspace_root;

use crate::AppState;
use crate::routes::api_error::ApiError;
use crate::routes::session::{AuthorizedJson, AuthorizedQuery, UserScoped};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UserRequest {
    user_id: String,
}

impl UserScoped for UserRequest {
    fn user_id(&self) -> &str {
        &self.user_id
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostRequest {
    user_id: String,
    host: String,
}

impl UserScoped for HostRequest {
    fn user_id(&self) -> &str {
        &self.user_id
    }
}

impl HostRequest {
    fn host(&self) -> Result<String, ApiError> {
        valid_host(&self.host)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SettingsUpdate {
    user_id: String,
    enabled: Option<bool>,
    host: Option<HostUpdate>,
}

impl UserScoped for SettingsUpdate {
    fn user_id(&self) -> &str {
        &self.user_id
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostUpdate {
    host: String,
    enabled: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CloneRequest {
    user_id: String,
    source: String,
    parent_path: String,
}

impl UserScoped for CloneRequest {
    fn user_id(&self) -> &str {
        &self.user_id
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateRepositoryRequest {
    user_id: String,
    name: String,
    visibility: Visibility,
    parent_path: String,
}

impl UserScoped for CreateRepositoryRequest {
    fn user_id(&self) -> &str {
        &self.user_id
    }
}

pub fn routes() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/connectors/github", get(status_handler))
        .route("/connectors/github/settings", post(update_handler))
        .route("/connectors/github/install", post(install_handler))
        .route(
            "/connectors/github/sign-in",
            get(sign_in_status_handler).post(sign_in_handler),
        )
        .route(
            "/connectors/github/sign-in/cancel",
            post(cancel_sign_in_handler),
        )
        .route("/connectors/github/sign-out", post(sign_out_handler))
        .route("/github/clone", post(clone_handler))
        .route("/github/repositories", post(create_repository_handler))
}

fn valid_host(host: &str) -> Result<String, ApiError> {
    let host = host.trim().to_ascii_lowercase();
    if is_valid_host(&host) {
        Ok(host)
    } else {
        Err(ApiError::bad_request(anyhow::anyhow!(
            "{host:?} is not a GitHub host name."
        )))
    }
}

async fn status_handler(
    State(state): State<AppState>,
    AuthorizedQuery(_): AuthorizedQuery<UserRequest>,
) -> Json<GitHubConnectorStatus> {
    Json(state.host.github.status().await)
}

async fn update_handler(
    State(state): State<AppState>,
    AuthorizedJson(update): AuthorizedJson<SettingsUpdate>,
) -> Result<Json<GitHubConnectorStatus>, ApiError> {
    let host = update
        .host
        .map(|host| valid_host(&host.host).map(|name| (name, host.enabled)))
        .transpose()?;
    state
        .host
        .github
        .update(|settings| {
            if let Some(enabled) = update.enabled {
                settings.disabled = !enabled;
            }
            if let Some((host, enabled)) = host {
                if enabled {
                    settings.disabled_hosts.remove(&host);
                } else {
                    settings.disabled_hosts.insert(host);
                }
            }
        })
        .await
        .map_err(|error| ApiError::internal_with("failed to save GitHub settings", error))?;
    Ok(Json(state.host.github.status().await))
}

async fn install_handler(
    State(state): State<AppState>,
    AuthorizedJson(_): AuthorizedJson<UserRequest>,
) -> Json<ToolInstall> {
    Json(state.host.github.retry_install().await)
}

async fn sign_in_status_handler(
    State(state): State<AppState>,
    AuthorizedQuery(query): AuthorizedQuery<HostRequest>,
) -> Result<Json<SignInStatus>, ApiError> {
    Ok(Json(state.host.github.sign_in_status(&query.host()?)))
}

async fn sign_in_handler(
    State(state): State<AppState>,
    AuthorizedJson(request): AuthorizedJson<HostRequest>,
) -> Result<Json<SignInStatus>, ApiError> {
    Ok(Json(
        state.host.github.start_sign_in(&request.host()?).await,
    ))
}

async fn cancel_sign_in_handler(
    State(state): State<AppState>,
    AuthorizedJson(request): AuthorizedJson<HostRequest>,
) -> Result<Json<SignInStatus>, ApiError> {
    Ok(Json(state.host.github.cancel_sign_in(&request.host()?)))
}

async fn sign_out_handler(
    State(state): State<AppState>,
    AuthorizedJson(request): AuthorizedJson<HostRequest>,
) -> Result<Json<GitHubConnectorStatus>, ApiError> {
    state
        .host
        .github
        .sign_out(&request.host()?)
        .await
        .map_err(|error| ApiError::internal_with("failed to sign out of GitHub", error))?;
    Ok(Json(state.host.github.status().await))
}

async fn clone_handler(
    State(state): State<AppState>,
    AuthorizedJson(request): AuthorizedJson<CloneRequest>,
) -> Result<Json<WorkspacePathResolution>, ApiError> {
    let parent = parent_directory(request.parent_path).await?;
    let target = clone_target(&state, &parent);
    let destination = clone_repository(target, &request.source)
        .await
        .map_err(ApiError::bad_request)?;
    attachable(destination).await
}

async fn create_repository_handler(
    State(state): State<AppState>,
    AuthorizedJson(request): AuthorizedJson<CreateRepositoryRequest>,
) -> Result<Json<WorkspacePathResolution>, ApiError> {
    let parent = parent_directory(request.parent_path).await?;
    let target = clone_target(&state, &parent);
    let destination = create_repository(target, &request.name, request.visibility)
        .await
        .map_err(ApiError::bad_request)?;
    attachable(destination).await
}

fn clone_target<'a>(state: &AppState, parent: &'a Path) -> CloneTarget<'a> {
    CloneTarget {
        parent_directory: parent,
        tool_environment: state.host.tool_environment(),
    }
}

async fn parent_directory(parent_path: String) -> Result<PathBuf, ApiError> {
    tokio::task::spawn_blocking(move || resolve_or_create_workspace_root(&parent_path))
        .await
        .map_err(|error| ApiError::internal(error.into()))?
        .map_err(ApiError::bad_request)
}

async fn attachable(destination: PathBuf) -> Result<Json<WorkspacePathResolution>, ApiError> {
    tokio::task::spawn_blocking(move || {
        resolve_workspace_path(&destination.to_string_lossy(), false)
    })
    .await
    .map_err(|error| ApiError::internal(error.into()))?
    .map(Json)
    .map_err(ApiError::bad_request)
}
