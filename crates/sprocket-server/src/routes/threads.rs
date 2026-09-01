use std::convert::Infallible;

use anyhow::anyhow;
use axum::Json;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::routing::post;
use axum_extra::extract::CookieJar;
use futures::stream::unfold;
use serde::Deserialize;
use tokio::sync::broadcast;

use crate::AppState;
use crate::auth::require_session;
use crate::routes::api_error::ApiError;
use crate::thread_cache::CachedThreadSummary;
use crate::thread_sync::{ThreadCacheEvent, ThreadCacheStatus};

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
    let mut session = state.thread_cache.subscribe().await;
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
