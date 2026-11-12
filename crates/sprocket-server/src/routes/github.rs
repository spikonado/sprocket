use axum::Json;
use axum::extract::State;
use axum::routing::{get, post};
use serde::Deserialize;
use sprocket_host::project_attachments::{WorkspacePathResolution, resolve_workspace_path};
use sprocket_workspace::github::is_valid_host;
use sprocket_workspace::github::repositories::{Visibility, clone_repository, create_repository};
use sprocket_workspace::github::status::{GitHubStatus, status};
use sprocket_workspace::resolve_or_create_workspace_root;

use crate::AppState;
use crate::routes::api_error::ApiError;
use crate::routes::session::{AuthorizedJson, AuthorizedQuery, UserScoped};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StatusQuery {
    user_id: String,
}

impl UserScoped for StatusQuery {
    fn user_id(&self) -> &str {
        &self.user_id
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
        .route("/github/status", get(status_handler))
        .route("/github/settings", post(update_handler))
        .route("/github/clone", post(clone_handler))
        .route("/github/repositories", post(create_repository_handler))
}

async fn status_handler(
    AuthorizedQuery(query): AuthorizedQuery<StatusQuery>,
) -> Json<GitHubStatus> {
    Json(status(&query.user_id).await)
}

async fn update_handler(
    State(state): State<AppState>,
    AuthorizedJson(update): AuthorizedJson<SettingsUpdate>,
) -> Result<Json<GitHubStatus>, ApiError> {
    let host = update.host.map(|host| HostUpdate {
        host: host.host.trim().to_ascii_lowercase(),
        ..host
    });
    if let Some(host) = &host
        && !is_valid_host(&host.host)
    {
        return Err(ApiError::bad_request(anyhow::anyhow!(
            "{:?} is not a GitHub host name.",
            host.host
        )));
    }
    state
        .host
        .github_settings
        .update(|settings| {
            if let Some(enabled) = update.enabled {
                settings.disabled = !enabled;
            }
            if let Some(host) = host {
                if host.enabled {
                    settings.disabled_hosts.remove(&host.host);
                } else {
                    settings.disabled_hosts.insert(host.host);
                }
            }
        })
        .await
        .map_err(|error| ApiError::internal_with("failed to save GitHub settings", error))?;
    Ok(Json(status(&update.user_id).await))
}

async fn clone_handler(
    AuthorizedJson(request): AuthorizedJson<CloneRequest>,
) -> Result<Json<WorkspacePathResolution>, ApiError> {
    clone_into(&request.user_id, &request.source, request.parent_path)
        .await
        .map(Json)
        .map_err(ApiError::bad_request)
}

async fn create_repository_handler(
    AuthorizedJson(request): AuthorizedJson<CreateRepositoryRequest>,
) -> Result<Json<WorkspacePathResolution>, ApiError> {
    let url = create_repository(&request.user_id, &request.name, request.visibility)
        .await
        .map_err(|error| ApiError::bad_request(error.into()))?;
    clone_into(&request.user_id, &url, request.parent_path)
        .await
        .map(Json)
        .map_err(|error| ApiError::bad_request(anyhow::anyhow!("Created {url}, but {error:#}")))
}

async fn clone_into(
    user_id: &str,
    source: &str,
    parent_path: String,
) -> anyhow::Result<WorkspacePathResolution> {
    let parent =
        tokio::task::spawn_blocking(move || resolve_or_create_workspace_root(&parent_path))
            .await??;
    let destination = clone_repository(user_id, source, &parent).await?;
    tokio::task::spawn_blocking(move || {
        resolve_workspace_path(&destination.to_string_lossy(), false)
    })
    .await?
}
