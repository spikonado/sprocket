use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::Response;
use axum::routing::{get, post};
use serde::Deserialize;
use sprocket_host::claude_code_cli::{ClaudeCodeStatus, LoginStart};

use crate::AppState;
use crate::routes::api_error::{ApiError, no_store};
use crate::routes::session::{AuthorizedJson, AuthorizedQuery, UserScoped};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UserRequest {
    user_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FinishLoginRequest {
    user_id: String,
    login_id: String,
    code: String,
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

impl UserScoped for FinishLoginRequest {
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
        .route("/claude-code", get(status))
        .route("/claude-code/install", post(start_install_or_update))
        .route("/claude-code/login/start", post(start_login))
        .route("/claude-code/login/finish", post(finish_login))
        .route("/claude-code/login/cancel", post(cancel_login))
}

async fn status(
    State(state): State<AppState>,
    AuthorizedQuery(_): AuthorizedQuery<UserRequest>,
) -> Json<ClaudeCodeStatus> {
    Json(state.host.claude_code_cli.status().await)
}

async fn start_install_or_update(
    State(state): State<AppState>,
    AuthorizedJson(_): AuthorizedJson<UserRequest>,
) -> Json<ClaudeCodeStatus> {
    state.host.claude_code_cli.start_install_or_update();
    Json(state.host.claude_code_cli.status().await)
}

async fn start_login(
    State(state): State<AppState>,
    AuthorizedJson(_): AuthorizedJson<UserRequest>,
) -> Result<Json<LoginStart>, ApiError> {
    let login = state
        .host
        .claude_code_cli
        .start_login()
        .await
        .map_err(rejected)?;
    Ok(Json(login))
}

/// Returns the long-lived token, which the UI saves to the user's vault.
async fn finish_login(
    State(state): State<AppState>,
    AuthorizedJson(request): AuthorizedJson<FinishLoginRequest>,
) -> Result<Response, ApiError> {
    let token = state
        .host
        .claude_code_cli
        .finish_login(&request.login_id, &request.code)
        .await
        .map_err(rejected)?;
    Ok(no_store(Json(serde_json::json!({ "token": token }))))
}

async fn cancel_login(
    State(state): State<AppState>,
    AuthorizedJson(request): AuthorizedJson<CancelLoginRequest>,
) -> StatusCode {
    state.host.claude_code_cli.cancel_login(&request.login_id);
    StatusCode::NO_CONTENT
}

fn rejected(error: anyhow::Error) -> ApiError {
    ApiError::bad_request(anyhow::anyhow!("{error:#}"))
}
