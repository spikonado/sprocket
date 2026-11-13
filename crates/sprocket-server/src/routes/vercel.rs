use axum::Json;
use axum::extract::State;
use axum::routing::{get, post};
use serde::Deserialize;
use sprocket_host::ToolInstall;
use sprocket_host::device_sign_in::SignInStatus;
use sprocket_host::vercel_connector::VercelStatus;

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

pub fn routes() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/connectors/vercel", get(status_handler))
        .route("/connectors/vercel/install", post(install_handler))
        .route(
            "/connectors/vercel/sign-in",
            get(sign_in_status_handler).post(sign_in_handler),
        )
        .route(
            "/connectors/vercel/sign-in/cancel",
            post(cancel_sign_in_handler),
        )
        .route("/connectors/vercel/sign-out", post(sign_out_handler))
}

async fn status_handler(
    State(state): State<AppState>,
    AuthorizedQuery(_): AuthorizedQuery<UserRequest>,
) -> Json<VercelStatus> {
    Json(state.host.vercel.status().await)
}

async fn install_handler(
    State(state): State<AppState>,
    AuthorizedJson(_): AuthorizedJson<UserRequest>,
) -> Json<ToolInstall> {
    Json(state.host.vercel.retry_install().await)
}

async fn sign_in_status_handler(
    State(state): State<AppState>,
    AuthorizedQuery(_): AuthorizedQuery<UserRequest>,
) -> Json<SignInStatus> {
    Json(state.host.vercel.sign_in_status())
}

async fn sign_in_handler(
    State(state): State<AppState>,
    AuthorizedJson(_): AuthorizedJson<UserRequest>,
) -> Json<SignInStatus> {
    Json(state.host.vercel.start_sign_in().await)
}

async fn cancel_sign_in_handler(
    State(state): State<AppState>,
    AuthorizedJson(_): AuthorizedJson<UserRequest>,
) -> Json<SignInStatus> {
    Json(state.host.vercel.cancel_sign_in())
}

async fn sign_out_handler(
    State(state): State<AppState>,
    AuthorizedJson(_): AuthorizedJson<UserRequest>,
) -> Result<Json<VercelStatus>, ApiError> {
    state
        .host
        .vercel
        .sign_out()
        .await
        .map_err(|error| ApiError::internal_with("failed to sign out of Vercel", error))?;
    Ok(Json(state.host.vercel.status().await))
}
