use std::collections::BTreeMap;

use axum::Json;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::routing::post;
use axum_extra::extract::CookieJar;
use convex::Value;
use serde::Deserialize;

use crate::AppState;
use crate::routes::api_error::ApiError;

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
    headers: HeaderMap,
    jar: CookieJar,
    Json(payload): Json<LifecycleRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    state
        .require_session_user(&headers, &jar, &payload.user_id)
        .await?;
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
    headers: HeaderMap,
    jar: CookieJar,
    Json(payload): Json<CancelRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    state
        .require_session_user(&headers, &jar, &payload.user_id)
        .await?;
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
    headers: HeaderMap,
    jar: CookieJar,
    Json(payload): Json<UserRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    state
        .require_session_user(&headers, &jar, &payload.user_id)
        .await?;
    state
        .machines
        .register(&payload.user_id)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::Value::Null))
}

async fn end_account_session_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(payload): Json<UserRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    state
        .require_session_user(&headers, &jar, &payload.user_id)
        .await?;
    state
        .machines
        .end(&payload.user_id)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::Value::Null))
}
