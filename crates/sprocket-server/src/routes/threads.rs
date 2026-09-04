use std::collections::BTreeMap;
use std::convert::Infallible;

use anyhow::anyhow;
use axum::Json;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::routing::post;
use axum_extra::extract::CookieJar;
use convex::Value;
use futures::stream::unfold;
use serde::Deserialize;
use tokio::sync::broadcast;

use crate::AppState;
use crate::routes::api_error::ApiError;
use crate::thread_cache::CachedThreadRecord;
use crate::thread_sync::{ThreadCacheEvent, ThreadCacheStatus};
use crate::transcript_client::UserConvexClient;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ThreadCacheUserRequest {
    user_id: String,
    selected_thread_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ThreadCommandRequest {
    user_id: String,
    thread_id: String,
    title: Option<String>,
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
struct ThreadCommandResult {
    user_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RekeyResult {
    user_id: String,
    count: u64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ThreadCacheSnapshotResponse {
    threads: Vec<CachedThreadRecord>,
    status: ThreadCacheStatus,
    last_synced_at: Option<u64>,
}

pub fn routes() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/threads/register", post(register_handler))
        .route("/threads/snapshot", post(snapshot_handler))
        .route("/threads/watch", post(watch_handler))
        .route("/threads/rename", post(rename_handler))
        .route("/threads/archive", post(archive_handler))
        .route("/threads/restore", post(restore_handler))
        .route("/threads/rekey", post(rekey_handler))
        .route("/threads/lifecycle", post(lifecycle_handler))
        .route("/threads/cancel", post(cancel_handler))
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

async fn run_thread_command(
    state: &AppState,
    payload: ThreadCommandRequest,
    function: &str,
) -> Result<Json<serde_json::Value>, ApiError> {
    let mut args = thread_args(payload.thread_id);
    if let Some(title) = payload.title {
        args.insert("title".into(), Value::String(title));
    }
    let result: ThreadCommandResult = client(state, &payload.user_id)
        .await?
        .mutate(function, args)
        .await
        .map_err(ApiError::bad_request)?;
    if result.user_id != payload.user_id {
        return Err(ApiError::bad_request(anyhow!(
            "thread command account does not match the requested account"
        )));
    }
    Ok(Json(serde_json::json!(true)))
}

async fn rename_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(payload): Json<ThreadCommandRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_session_user(&state, &headers, &jar, &payload.user_id).await?;
    run_thread_command(&state, payload, "threads:renameForLocalCache").await
}
async fn archive_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(payload): Json<ThreadCommandRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_session_user(&state, &headers, &jar, &payload.user_id).await?;
    run_thread_command(&state, payload, "threads:archiveForLocalCache").await
}
async fn restore_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(payload): Json<ThreadCommandRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_session_user(&state, &headers, &jar, &payload.user_id).await?;
    run_thread_command(&state, payload, "threads:restoreForLocalCache").await
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
        .mutate("threads:rekeyRepositoryForLocalCache", args)
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

async fn end_account_session_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(payload): Json<ThreadCacheUserRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_session_user(&state, &headers, &jar, &payload.user_id).await?;
    state
        .machines
        .end(&payload.user_id)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::Value::Null))
}

async fn register_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(payload): Json<ThreadCacheUserRequest>,
) -> Result<Json<ThreadCacheEvent>, ApiError> {
    require_session_user(&state, &headers, &jar, &payload.user_id).await?;
    state
        .machines
        .register(&payload.user_id)
        .await
        .map_err(ApiError::bad_request)?;
    state
        .thread_cache
        .register(&payload.user_id, payload.selected_thread_id.as_deref())
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(state.thread_cache.current_event().await))
}

async fn snapshot_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(payload): Json<ThreadCacheUserRequest>,
) -> Result<Json<ThreadCacheSnapshotResponse>, ApiError> {
    require_session_user(&state, &headers, &jar, &payload.user_id).await?;
    let user_id = payload.user_id.trim();
    if user_id.is_empty() {
        return Err(ApiError::bad_request(anyhow!("user id is required")));
    }
    let (threads, event) = state
        .thread_cache
        .snapshot(user_id)
        .await
        .map_err(|error| ApiError::internal_with("failed to read thread snapshot", error))?;
    Ok(Json(ThreadCacheSnapshotResponse {
        threads,
        status: event.status,
        last_synced_at: event.last_synced_at,
    }))
}

async fn watch_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(payload): Json<ThreadCacheUserRequest>,
) -> Result<Sse<impl futures::Stream<Item = Result<Event, Infallible>>>, ApiError> {
    require_session_user(&state, &headers, &jar, &payload.user_id).await?;
    let user_id = payload.user_id.trim();
    if user_id.is_empty() {
        return Err(ApiError::bad_request(anyhow!("user id is required")));
    }
    let initial = state
        .thread_cache
        .event_for_user(user_id)
        .await
        .map_err(ApiError::internal)?;
    let session = state.thread_cache.subscribe().await;
    let stream = unfold(
        (Some(initial), session),
        |(initial, mut session)| async move {
            if let Some(event) = initial {
                return encode_event(event).map(|event| (event, (None, session)));
            }
            loop {
                match session.receiver().recv().await {
                    Ok(event) => {
                        return encode_event(event).map(|event| (event, (None, session)));
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        let event = session_fallback();
                        return encode_event(event).map(|event| (event, (None, session)));
                    }
                    Err(broadcast::error::RecvError::Closed) => return None,
                }
            }
        },
    );
    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}

fn session_fallback() -> ThreadCacheEvent {
    ThreadCacheEvent {
        status: ThreadCacheStatus::Reconnecting,
        last_synced_at: None,
    }
}

fn encode_event(event: ThreadCacheEvent) -> Option<Result<Event, Infallible>> {
    Event::default().json_data(event).ok().map(Ok)
}
