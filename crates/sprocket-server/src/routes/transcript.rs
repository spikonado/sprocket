use std::convert::Infallible;

use anyhow::anyhow;
use axum::Json;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum_extra::extract::CookieJar;
use futures::stream::unfold;
use serde::Deserialize;
use sprocket_agent::{TRANSCRIPT_CHUNK_SIZE, TRANSCRIPT_PAGE_SIZE};
use tokio::sync::broadcast;

use crate::AppState;
use crate::routes::api_error::ApiError;
use crate::transcript_client::{UserConvexClient, download_attachment_bytes};
use crate::transcript_watch::TranscriptWatchEvent;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TranscriptScope {
    user_id: String,
    thread_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TranscriptPageRequest {
    user_id: String,
    thread_id: String,
    before: Option<u32>,
    limit: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TranscriptAttachmentRequest {
    user_id: String,
    thread_id: String,
    image_upload_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TranscriptDetailsRequest {
    user_id: String,
    thread_id: String,
    numbers: Vec<u32>,
}

pub fn routes() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/transcript/page", post(page_handler))
        .route("/transcript/watch", post(watch_handler))
        .route("/transcript/details", post(details_handler))
        .route("/transcript/clear", post(clear_handler))
        .route("/transcript/attachment", post(attachment_handler))
}

async fn details_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(payload): Json<TranscriptDetailsRequest>,
) -> Result<Json<sprocket_agent::TranscriptMessage>, ApiError> {
    require_session_user(&state, &headers, &jar, &payload.user_id).await?;
    if payload.numbers.is_empty() || payload.numbers.len() > 1_000 {
        return Err(ApiError::bad_request(anyhow!(
            "invalid transcript detail range"
        )));
    }
    if payload.numbers.windows(2).any(|pair| pair[0] >= pair[1]) {
        return Err(ApiError::bad_request(anyhow!(
            "transcript detail numbers must be strictly increasing"
        )));
    }
    let message = state
        .transcript
        .message_details(&payload.user_id, &payload.thread_id, &payload.numbers)
        .await
        .map_err(|error| ApiError::internal_with("failed to read transcript details", error))?
        .ok_or_else(|| ApiError::bad_request(anyhow!("transcript message not found")))?;
    Ok(Json(message))
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

async fn page_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(payload): Json<TranscriptPageRequest>,
) -> Result<Json<sprocket_agent::TranscriptPage>, ApiError> {
    require_session_user(&state, &headers, &jar, &payload.user_id).await?;
    let mut transcript_state = state
        .transcript
        .load_state(&payload.user_id, &payload.thread_id)
        .await
        .map_err(|error| ApiError::internal_with("failed to read transcript state", error))?;
    if transcript_state.visible_end_exclusive() == 0 {
        let client = UserConvexClient::connect_with_fetcher(
            &state.convex_deployment_url,
            state
                .native_auth
                .auth_token_fetcher_for_user(payload.user_id.clone()),
        )
        .await
        .map_err(|error| {
            ApiError::internal_with("failed to connect while loading transcript", error)
        })?;
        let remote = client
            .ensure_migrated(&payload.thread_id)
            .await
            .map_err(|error| ApiError::internal_with("failed to load transcript state", error))?;
        transcript_state = sprocket_agent::apply_remote_state(
            &state.transcript,
            &payload.user_id,
            &payload.thread_id,
            &remote,
            false,
        )
        .await
        .map_err(|error| ApiError::internal_with("failed to save transcript state", error))?;
    }
    let limit = payload
        .limit
        .unwrap_or(TRANSCRIPT_PAGE_SIZE)
        .clamp(1, TRANSCRIPT_CHUNK_SIZE);
    if !state
        .transcript
        .has_complete_message_page(&payload.user_id, &payload.thread_id, payload.before, limit)
        .await
        .map_err(|error| ApiError::internal_with("failed to inspect transcript history", error))?
    {
        let client = UserConvexClient::connect_with_fetcher(
            &state.convex_deployment_url,
            state
                .native_auth
                .auth_token_fetcher_for_user(payload.user_id.clone()),
        )
        .await
        .map_err(|error| {
            ApiError::internal_with("failed to connect while loading transcript history", error)
        })?;
        let end = payload
            .before
            .unwrap_or_else(|| transcript_state.visible_end_exclusive())
            .min(transcript_state.visible_end_exclusive());
        let mut scan_end = end;
        let mut parts = Vec::new();
        loop {
            let start = scan_end.saturating_sub(TRANSCRIPT_CHUNK_SIZE);
            crate::transcript_client::sync_range(
                &state.transcript,
                &client,
                &payload.user_id,
                &payload.thread_id,
                start,
                scan_end,
            )
            .await
            .map_err(|error| ApiError::internal_with("failed to load transcript history", error))?;
            let numbers = (start..scan_end).collect::<Vec<_>>();
            let mut batch = state
                .transcript
                .read_parts(&payload.user_id, &payload.thread_id, &numbers)
                .await
                .map_err(|error| {
                    ApiError::internal_with("failed to read transcript history", error)
                })?;
            batch.append(&mut parts);
            parts = batch;
            if sprocket_agent::message_page_start(&parts, limit, start == 0).is_some() || start == 0
            {
                break;
            }
            scan_end = start;
        }
    }

    let page = state
        .transcript
        .page(
            &payload.user_id,
            &payload.thread_id,
            payload.before,
            payload.limit,
        )
        .await
        .map_err(|error| ApiError::internal_with("failed to read transcript replica", error))?;
    Ok(Json(page))
}

async fn watch_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(payload): Json<TranscriptScope>,
) -> Result<Sse<impl futures::Stream<Item = Result<Event, Infallible>>>, ApiError> {
    require_session_user(&state, &headers, &jar, &payload.user_id).await?;
    let session = state
        .transcript_watchers
        .open(&payload.user_id, &payload.thread_id)
        .await;
    let stream = unfold(session, |mut session| async move {
        loop {
            match session.receiver().recv().await {
                Ok(event) => {
                    return encode_watch_event(event).map(|event| (event, session));
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    let event = TranscriptWatchEvent {
                        event_type: "updated",
                        total_parts: None,
                        stale: false,
                    };
                    return encode_watch_event(event).map(|event| (event, session));
                }
                Err(broadcast::error::RecvError::Closed) => return None,
            }
        }
    });
    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}

fn encode_watch_event(event: TranscriptWatchEvent) -> Option<Result<Event, Infallible>> {
    Event::default().json_data(event).ok().map(Ok)
}

async fn clear_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(payload): Json<TranscriptScope>,
) -> Result<StatusCode, ApiError> {
    require_session_user(&state, &headers, &jar, &payload.user_id).await?;
    state
        .transcript_watchers
        .abort_thread(&payload.user_id, &payload.thread_id)
        .await;
    state
        .transcript
        .clear_thread(&payload.user_id, &payload.thread_id)
        .await
        .map_err(|error| ApiError::internal_with("failed to clear transcript replica", error))?;
    Ok(StatusCode::NO_CONTENT)
}

async fn attachment_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(payload): Json<TranscriptAttachmentRequest>,
) -> Result<Response, ApiError> {
    require_session_user(&state, &headers, &jar, &payload.user_id).await?;
    if let Some(blob) = state
        .transcript
        .blob_for_upload(&payload.user_id, &payload.image_upload_id)
        .await
        .map_err(|error| {
            ApiError::internal_with(
                &format!(
                    "failed to read cached attachment for thread {}",
                    payload.thread_id
                ),
                error,
            )
        })?
    {
        return Ok(blob_response(blob.media_type, blob.bytes));
    }

    let client = UserConvexClient::connect_with_fetcher(
        &state.convex_deployment_url,
        state
            .native_auth
            .auth_token_fetcher_for_user(payload.user_id.clone()),
    )
    .await
    .map_err(|error| ApiError::internal_with("failed to connect to Convex", error))?;
    let Some(remote) = client
        .attachment_download(&payload.image_upload_id)
        .await
        .map_err(|error| ApiError::internal_with("failed to resolve attachment", error))?
    else {
        return Err(ApiError::with_status(
            StatusCode::NOT_FOUND,
            anyhow!("attachment not found"),
        ));
    };
    let bytes = download_attachment_bytes(&remote.url)
        .await
        .map_err(|error| ApiError::internal_with("failed to download attachment", error))?;
    state
        .transcript
        .write_blob(
            &payload.user_id,
            &remote.storage_id,
            &payload.image_upload_id,
            &remote.media_type,
            &remote.name,
            &bytes,
        )
        .await
        .map_err(|error| ApiError::internal_with("failed to cache attachment", error))?;
    Ok(blob_response(remote.media_type, bytes))
}

fn blob_response(media_type: String, bytes: Vec<u8>) -> Response {
    (
        [
            (
                header::CONTENT_TYPE,
                header::HeaderValue::from_str(&media_type).unwrap_or_else(|_| {
                    header::HeaderValue::from_static("application/octet-stream")
                }),
            ),
            (
                header::CACHE_CONTROL,
                header::HeaderValue::from_static("private, max-age=31536000, immutable"),
            ),
        ],
        Bytes::from(bytes),
    )
        .into_response()
}
