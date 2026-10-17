use axum::Json;
use axum::extract::State;
use axum::routing::{get, post};
use serde::Deserialize;
use sprocket_workspace::github::status::{GitHubStatus, status};
use sprocket_workspace::github::{GitHubSettings, is_valid_host};

use crate::AppState;
use crate::routes::api_error::ApiError;
use crate::routes::session::MachineSession;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SettingsUpdate {
    enabled: Option<bool>,
    host: Option<HostUpdate>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostUpdate {
    host: String,
    enabled: Option<bool>,
    /// An empty token removes the saved one.
    token: Option<String>,
}

pub fn routes() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/github/status", get(status_handler))
        .route("/github/settings", post(update_handler))
}

async fn status_handler(MachineSession: MachineSession) -> Json<GitHubStatus> {
    Json(status().await)
}

/// Applies one change from Settings → Version Control and answers with the
/// resulting status, so a saved token is checked right away.
async fn update_handler(
    MachineSession: MachineSession,
    State(state): State<AppState>,
    Json(update): Json<SettingsUpdate>,
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
        .update(|settings| apply(settings, update.enabled, host))
        .await
        .map_err(|error| ApiError::internal_with("failed to save GitHub settings", error))?;
    Ok(Json(status().await))
}

fn apply(settings: &mut GitHubSettings, enabled: Option<bool>, host: Option<HostUpdate>) {
    if let Some(enabled) = enabled {
        settings.disabled = !enabled;
    }
    let Some(update) = host else {
        return;
    };
    let saved = settings.hosts.entry(update.host).or_default();
    if let Some(enabled) = update.enabled {
        saved.disabled = !enabled;
    }
    if let Some(token) = update.token {
        let token = token.trim();
        saved.token = (!token.is_empty()).then(|| token.to_string());
    }
}

#[cfg(test)]
mod tests;
