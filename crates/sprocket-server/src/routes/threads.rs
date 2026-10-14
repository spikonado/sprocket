use std::collections::BTreeMap;

use axum::Json;
use axum::extract::State;
use axum::routing::post;
use convex::Value;
use serde::Deserialize;

use crate::AppState;
use crate::routes::api_error::ApiError;
use crate::routes::session::{AuthorizedJson, UserScoped};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UserRequest {
    user_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CancelRequest {
    user_id: String,
    run_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LifecycleRequest {
    user_id: String,
    thread_id: String,
}

impl UserScoped for UserRequest {
    fn user_id(&self) -> &str {
        &self.user_id
    }
}

impl UserScoped for CancelRequest {
    fn user_id(&self) -> &str {
        &self.user_id
    }
}

impl UserScoped for LifecycleRequest {
    fn user_id(&self) -> &str {
        &self.user_id
    }
}

pub fn routes() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/threads/lifecycle", post(lifecycle_handler))
        .route("/threads/cancel", post(cancel_handler))
        .route(
            "/threads/account-session/start",
            post(start_account_session_handler),
        )
        .route(
            "/threads/account-session/end",
            post(end_account_session_handler),
        )
}

fn thread_args(thread_id: String) -> BTreeMap<String, Value> {
    BTreeMap::from([("threadId".into(), Value::String(thread_id))])
}

async fn lifecycle_handler(
    State(state): State<AppState>,
    AuthorizedJson(payload): AuthorizedJson<LifecycleRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let result = state
        .convex_client_for(&payload.user_id)
        .await
        .map_err(ApiError::bad_request)?
        .query(
            "chat:selectedThreadLifecycle",
            thread_args(payload.thread_id),
        )
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(result))
}
async fn cancel_handler(
    State(state): State<AppState>,
    AuthorizedJson(payload): AuthorizedJson<CancelRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let args = BTreeMap::from([("runId".into(), Value::String(payload.run_id))]);
    let result = state
        .convex_client_for(&payload.user_id)
        .await
        .map_err(ApiError::bad_request)?
        .mutate("agentRuntime:requestCancellation", args)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(result))
}

async fn start_account_session_handler(
    State(state): State<AppState>,
    AuthorizedJson(payload): AuthorizedJson<UserRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    state
        .machines
        .register(&payload.user_id)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::Value::Null))
}

async fn end_account_session_handler(
    State(state): State<AppState>,
    AuthorizedJson(payload): AuthorizedJson<UserRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    state
        .machines
        .end(&payload.user_id)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::Value::Null))
}
