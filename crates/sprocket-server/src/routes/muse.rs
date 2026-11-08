use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use serde::Deserialize;
use sprocket_host::muse_cli::{LoginStart, MuseStatus};

use crate::AppState;
use crate::routes::api_error::ApiError;
use crate::routes::session::{AuthorizedJson, AuthorizedQuery, UserScoped};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UserRequest {
    user_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CancelLoginRequest {
    user_id: String,
    login_id: String,
}

impl UserScoped for UserRequest {
    fn user_id(&self) -> &str {
        &self.user_id
    }
}

impl UserScoped for CancelLoginRequest {
    fn user_id(&self) -> &str {
        &self.user_id
    }
}

pub fn routes() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/muse", get(status))
        .route("/muse/install", post(start_install_or_update))
        .route("/muse/login/start", post(start_login))
        .route("/muse/login/cancel", post(cancel_login))
}

async fn status(
    State(state): State<AppState>,
    AuthorizedQuery(_): AuthorizedQuery<UserRequest>,
) -> Json<MuseStatus> {
    Json(state.host.muse_cli.status().await)
}

async fn start_install_or_update(
    State(state): State<AppState>,
    AuthorizedJson(_): AuthorizedJson<UserRequest>,
) -> Json<MuseStatus> {
    state.host.muse_cli.start_install_or_update();
    Json(state.host.muse_cli.status().await)
}

/// Starts a device-code sign-in, which the user finishes on Meta's site.
async fn start_login(
    State(state): State<AppState>,
    AuthorizedJson(_): AuthorizedJson<UserRequest>,
) -> Result<Json<LoginStart>, ApiError> {
    let login = state
        .host
        .muse_cli
        .start_login()
        .await
        .map_err(|error| ApiError::bad_request(anyhow::anyhow!("{error:#}")))?;
    Ok(Json(login))
}

async fn cancel_login(
    State(state): State<AppState>,
    AuthorizedJson(request): AuthorizedJson<CancelLoginRequest>,
) -> StatusCode {
    state.host.muse_cli.cancel_login(&request.login_id);
    StatusCode::NO_CONTENT
}
