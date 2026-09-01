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
use crate::auth::require_session;
use crate::routes::api_error::ApiError;
use crate::thread_cache::{CachedThreadSummary, ThreadSnapshotCategory};
use crate::thread_sync::{ThreadCacheEvent, ThreadCacheStatus};
use crate::transcript_client::UserConvexClient;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadCacheRegisterRequest {
    user_id: String,
    auth_token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadCacheUserRequest {
    user_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadCommandRequest {
    user_id: String,
    auth_token: String,
    thread_id: String,
    title: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RekeyRequest {
    user_id: String,
    auth_token: String,
    from: String,
    to: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CancelRequest {
    auth_token: String,
    run_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LifecycleRequest {
    auth_token: String,
    thread_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadCommandResult {
    user_id: String,
    repository_key: String,
    #[serde(default)]
    category: Option<ThreadSnapshotCategory>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RekeyResult {
    user_id: String,
    from: String,
    to: String,
    count: u64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ThreadCacheSnapshotResponse {
    threads: Vec<CachedThreadSummary>,
    status: ThreadCacheStatus,
    last_synced_at: Option<u64>,
}

pub fn routes() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/threads/register", post(register_handler))
        .route("/threads/snapshot", post(snapshot_handler))
        .route("/threads/archive-sync", post(archive_sync_handler))
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

async fn client(state: &AppState, token: String) -> Result<UserConvexClient, ApiError> {
    UserConvexClient::connect(&state.convex_deployment_url, token)
        .await
        .map_err(ApiError::bad_request)
}

fn thread_args(thread_id: String) -> BTreeMap<String, Value> {
    BTreeMap::from([("threadId".into(), Value::String(thread_id))])
}

async fn run_thread_command(
    state: &AppState,
    payload: ThreadCommandRequest,
    function: &str,
    categories: &[ThreadSnapshotCategory],
) -> Result<Json<serde_json::Value>, ApiError> {
    let mut args = thread_args(payload.thread_id);
    if let Some(title) = payload.title {
        args.insert("title".into(), Value::String(title));
    }
    let result: ThreadCommandResult = client(state, payload.auth_token.clone())
        .await?
        .mutate(function, args)
        .await
        .map_err(ApiError::bad_request)?;
    if result.user_id != payload.user_id {
        return Err(ApiError::bad_request(anyhow!(
            "thread command account does not match the requested account"
        )));
    }
    let refresh_categories = result
        .category
        .as_ref()
        .map_or(categories, std::slice::from_ref);
    if let Err(error) = state
        .thread_cache
        .refresh_repository(
            &payload.user_id,
            payload.auth_token,
            &result.repository_key,
            refresh_categories,
        )
        .await
    {
        tracing::warn!(
            repository_key = %result.repository_key,
            "thread command committed but cache refresh failed: {error:#}"
        );
    }
    Ok(Json(serde_json::Value::Null))
}

async fn rename_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(payload): Json<ThreadCommandRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_session(&state.auth, &headers, &jar)
        .await
        .map_err(ApiError::unauthorized)?;
    run_thread_command(
        &state,
        payload,
        "threads:renameForLocalCache",
        &[
            ThreadSnapshotCategory::Active,
            ThreadSnapshotCategory::Archived,
        ],
    )
    .await
}
async fn archive_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(payload): Json<ThreadCommandRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_session(&state.auth, &headers, &jar)
        .await
        .map_err(ApiError::unauthorized)?;
    run_thread_command(
        &state,
        payload,
        "threads:archiveForLocalCache",
        &[
            ThreadSnapshotCategory::Active,
            ThreadSnapshotCategory::Archived,
        ],
    )
    .await
}
async fn restore_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(payload): Json<ThreadCommandRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_session(&state.auth, &headers, &jar)
        .await
        .map_err(ApiError::unauthorized)?;
    run_thread_command(
        &state,
        payload,
        "threads:restoreForLocalCache",
        &[
            ThreadSnapshotCategory::Active,
            ThreadSnapshotCategory::Archived,
        ],
    )
    .await
}
async fn rekey_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(payload): Json<RekeyRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_session(&state.auth, &headers, &jar)
        .await
        .map_err(ApiError::unauthorized)?;
    let args = BTreeMap::from([
        ("from".into(), Value::String(payload.from)),
        ("to".into(), Value::String(payload.to)),
    ]);
    let result: RekeyResult = client(&state, payload.auth_token.clone())
        .await?
        .mutate("threads:rekeyRepositoryForLocalCache", args)
        .await
        .map_err(ApiError::bad_request)?;
    if result.user_id != payload.user_id {
        return Err(ApiError::bad_request(anyhow!(
            "thread command account does not match the requested account"
        )));
    }
    if result.from != result.to {
        state
            .thread_cache
            .store()
            .reset_repository(&payload.user_id, &result.from)
            .await
            .map_err(|error| {
                ApiError::internal_with("rekey committed but source cache cleanup failed", error)
            })?;
        if let Err(error) = state
            .thread_cache
            .refresh_repository(
                &payload.user_id,
                payload.auth_token,
                &result.to,
                &[
                    ThreadSnapshotCategory::Active,
                    ThreadSnapshotCategory::Archived,
                ],
            )
            .await
        {
            tracing::warn!(
                repository_key = %result.to,
                "repository rekey committed but destination cache refresh failed: {error:#}"
            );
        }
    }
    Ok(Json(serde_json::json!(result.count)))
}
async fn lifecycle_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(payload): Json<LifecycleRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_session(&state.auth, &headers, &jar)
        .await
        .map_err(ApiError::unauthorized)?;
    let result = client(&state, payload.auth_token)
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
    require_session(&state.auth, &headers, &jar)
        .await
        .map_err(ApiError::unauthorized)?;
    let args = BTreeMap::from([("runId".into(), Value::String(payload.run_id))]);
    let result = client(&state, payload.auth_token)
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
    require_session(&state.auth, &headers, &jar)
        .await
        .map_err(ApiError::unauthorized)?;
    state
        .machine_sessions
        .end(&payload.user_id)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::Value::Null))
}

async fn register_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(payload): Json<ThreadCacheRegisterRequest>,
) -> Result<Json<ThreadCacheEvent>, ApiError> {
    require_session(&state.auth, &headers, &jar)
        .await
        .map_err(ApiError::unauthorized)?;
    state
        .machine_sessions
        .register(&payload.user_id, payload.auth_token.clone())
        .await
        .map_err(ApiError::bad_request)?;
    state
        .thread_cache
        .register(&payload.user_id, payload.auth_token)
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
    require_session(&state.auth, &headers, &jar)
        .await
        .map_err(ApiError::unauthorized)?;
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

async fn archive_sync_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(payload): Json<ThreadCacheUserRequest>,
) -> Result<Json<ThreadCacheEvent>, ApiError> {
    require_session(&state.auth, &headers, &jar)
        .await
        .map_err(ApiError::unauthorized)?;
    state
        .thread_cache
        .sync_archived(&payload.user_id)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(state.thread_cache.current_event().await))
}

async fn watch_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(payload): Json<ThreadCacheUserRequest>,
) -> Result<Sse<impl futures::Stream<Item = Result<Event, Infallible>>>, ApiError> {
    require_session(&state.auth, &headers, &jar)
        .await
        .map_err(ApiError::unauthorized)?;
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
