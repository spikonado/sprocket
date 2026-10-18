use axum::Json;
use axum::extract::State;
use axum::routing::{get, post};
use serde::Deserialize;
use sprocket_workspace::github::is_valid_host;
use sprocket_workspace::github::status::{GitHubStatus, status};

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

/// One switch from Settings → Version Control. Tokens are saved through
/// Convex instead, so every machine of the user can use them.
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

pub fn routes() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/github/status", get(status_handler))
        .route("/github/settings", post(update_handler))
}

/// Reloads the user's saved tokens, so a token just saved on any machine is
/// checked right away.
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
