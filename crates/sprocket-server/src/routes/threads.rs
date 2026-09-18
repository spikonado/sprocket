use std::collections::BTreeMap;

use anyhow::anyhow;
use axum::Json;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::routing::post;
use axum_extra::extract::CookieJar;
use convex::Value;
use serde::Deserialize;

use crate::AppState;
use crate::routes::api_error::ApiError;
use crate::transcript_client::UserConvexClient;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UserRequest {
    user_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RekeyRequest {
    user_id: String,
    from: String,
    to: String,
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RekeyResult {
    user_id: String,
    count: u64,
}

pub fn routes() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/threads/rekey", post(rekey_handler))
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

async fn client(state: &AppState, user_id: &str) -> Result<UserConvexClient, ApiError> {
    UserConvexClient::connect_with_fetcher(
        &state.convex_deployment_url,
        state
            .native_auth
            .auth_token_fetcher_for_user(user_id.to_string()),
    )
    .await
    .map_err(ApiError::bad_request)
}

async fn require_user(state: &AppState, user_id: &str) -> Result<(), ApiError> {
    state
        .native_auth
        .require_user(user_id)
        .await
        .map_err(ApiError::unauthorized)
}

async fn require_session_user(
    state: &AppState,
    headers: &HeaderMap,
    jar: &CookieJar,
    user_id: &str,
) -> Result<(), ApiError> {
    crate::auth::require_session_user(&state.auth, headers, jar, user_id)
        .await
        .map_err(ApiError::unauthorized)?;
    require_user(state, user_id).await
}

fn thread_args(thread_id: String) -> BTreeMap<String, Value> {
    BTreeMap::from([("threadId".into(), Value::String(thread_id))])
}

async fn rekey_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(payload): Json<RekeyRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_session_user(&state, &headers, &jar, &payload.user_id).await?;
    let args = BTreeMap::from([
        ("from".into(), Value::String(payload.from)),
        ("to".into(), Value::String(payload.to)),
    ]);
    let result: RekeyResult = client(&state, &payload.user_id)
        .await?
        .mutate("threads:rekeyRepository", args)
        .await
        .map_err(ApiError::bad_request)?;
    if result.user_id != payload.user_id {
        return Err(ApiError::bad_request(anyhow!(
            "thread command account does not match the requested account"
        )));
    }
    Ok(Json(serde_json::json!(result.count)))
}
async fn lifecycle_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(payload): Json<LifecycleRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_session_user(&state, &headers, &jar, &payload.user_id).await?;
    let result = client(&state, &payload.user_id)
        .await?
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
    require_session_user(&state, &headers, &jar, &payload.user_id).await?;
    let args = BTreeMap::from([("runId".into(), Value::String(payload.run_id))]);
    let result = client(&state, &payload.user_id)
        .await?
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
    require_session_user(&state, &headers, &jar, &payload.user_id).await?;
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
    require_session_user(&state, &headers, &jar, &payload.user_id).await?;
    state
        .machines
        .end(&payload.user_id)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::Value::Null))
}
