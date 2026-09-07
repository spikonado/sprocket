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
use sprocket_agent::{TRANSCRIPT_CHUNK_SIZE, TRANSCRIPT_PAGE_SIZE, parts_window};
use tokio::sync::broadcast;

use crate::AppState;
use crate::routes::api_error::ApiError;
use crate::transcript_client::{UserConvexClient, download_attachment_bytes};
use crate::transcript_watch::TranscriptWatchEvent;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TranscriptScope {
    user_id: String,
    #[serde(deserialize_with = "deserialize_thread_id")]
    thread_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TranscriptPageRequest {
    user_id: String,
    #[serde(deserialize_with = "deserialize_thread_id")]
    thread_id: String,
    before: Option<u32>,
    limit: Option<u32>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LegacyTranscriptPage {
    thread_id: String,
    total_parts: u32,
    history_from_number: u32,
    stale: bool,
    parts: Vec<sprocket_agent::TranscriptPart>,
    #[serde(skip_serializing_if = "Option::is_none")]
    next_before: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TranscriptAttachmentRequest {
    user_id: String,
    #[serde(deserialize_with = "deserialize_thread_id")]
    thread_id: String,
    image_upload_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TranscriptDetailsRequest {
    user_id: String,
    #[serde(deserialize_with = "deserialize_thread_id")]
    thread_id: String,
    numbers: Vec<u32>,
}

fn deserialize_thread_id<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<String, D::Error> {
    let id = String::deserialize(deserializer)?;
    if id.is_empty()
        || id.eq_ignore_ascii_case("blobs")
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(serde::de::Error::custom("invalid transcript thread ID"));
    }
    Ok(id)
}

pub fn routes() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/transcript/page", post(legacy_page_handler))
        .route("/transcript/messages", post(page_handler))
        .route("/transcript/parts", post(parts_handler))
        .route("/transcript/watch", post(watch_handler))
        .route("/transcript/details", post(details_handler))
        .route("/transcript/part-details", post(part_details_handler))
        .route("/transcript/clear", post(clear_handler))
        .route("/transcript/attachment", post(attachment_handler))
}

async fn legacy_page_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(payload): Json<TranscriptPageRequest>,
) -> Result<Json<LegacyTranscriptPage>, ApiError> {
    let user_id = payload.user_id.clone();
    let thread_id = payload.thread_id.clone();
    let Json(page) = page_handler(State(state.clone()), headers, jar, Json(payload)).await?;
    let numbers = page
        .messages
        .iter()
        .flat_map(|message| message.source_numbers.iter().copied())
        .collect::<Vec<_>>();
    let parts = state
        .transcript
        .read_parts(&user_id, &thread_id, &numbers)
        .await
        .map_err(|error| ApiError::internal_with("failed to read legacy transcript", error))?;
    Ok(Json(LegacyTranscriptPage {
        thread_id: page.thread_id,
        total_parts: page.total_parts,
        history_from_number: page.history_from_number,
        stale: page.stale,
        parts,
        next_before: page.next_before,
    }))
}

async fn details_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(payload): Json<TranscriptDetailsRequest>,
) -> Result<Json<sprocket_agent::TranscriptMessage>, ApiError> {
    require_session_user(&state, &headers, &jar, &payload.user_id).await?;
    require_transcript_numbers(&payload.numbers, None)?;
    let message = state
        .transcript
        .message_details(&payload.user_id, &payload.thread_id, &payload.numbers)
        .await
        .map_err(|error| ApiError::internal_with("failed to read transcript details", error))?
        .ok_or_else(|| ApiError::bad_request(anyhow!("transcript message not found")))?;
    Ok(Json(message))
}

async fn part_details_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(payload): Json<TranscriptDetailsRequest>,
) -> Result<Json<Vec<sprocket_agent::TranscriptPartRecord>>, ApiError> {
    require_session_user(&state, &headers, &jar, &payload.user_id).await?;
    require_transcript_numbers(&payload.numbers, Some(TRANSCRIPT_CHUNK_SIZE as usize))?;
    let records = state
        .transcript
        .part_details(&payload.user_id, &payload.thread_id, &payload.numbers)
        .await
        .map_err(|error| ApiError::internal_with("failed to read transcript part details", error))?
        .ok_or_else(|| ApiError::bad_request(anyhow!("transcript parts not found")))?;
    Ok(Json(records))
}

fn require_transcript_numbers(numbers: &[u32], max_len: Option<usize>) -> Result<(), ApiError> {
    if numbers.is_empty() {
        return Err(ApiError::bad_request(anyhow!(
            "invalid transcript detail range"
        )));
    }
    if max_len.is_some_and(|max| numbers.len() > max) {
        return Err(ApiError::bad_request(anyhow!(
            "request at most {TRANSCRIPT_CHUNK_SIZE} transcript parts"
        )));
    }
    if numbers.windows(2).any(|pair| pair[0] >= pair[1]) {
        return Err(ApiError::bad_request(anyhow!(
            "transcript detail numbers must be strictly increasing"
        )));
    }
    Ok(())
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
    let transcript_state =
        load_transcript_state(&state, &payload.user_id, &payload.thread_id).await?;
    let limit = payload
        .limit
        .unwrap_or(TRANSCRIPT_PAGE_SIZE)
        .clamp(1, TRANSCRIPT_CHUNK_SIZE);
    let end = payload
        .before
        .unwrap_or_else(|| transcript_state.visible_end_exclusive())
        .min(transcript_state.visible_end_exclusive());
    if !state
        .transcript
        .has_complete_message_page(&payload.user_id, &payload.thread_id, Some(end), limit)
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
            if batch.len() != numbers.len() {
                return Err(ApiError::internal_with(
                    "incomplete transcript history",
                    anyhow!("transcript parts are not yet available; retry the page"),
                ));
            }
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
            Some(end),
            payload.limit,
        )
        .await
        .map_err(|error| ApiError::internal_with("failed to read transcript replica", error))?;
    Ok(Json(page))
}

async fn parts_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(payload): Json<TranscriptPageRequest>,
) -> Result<Json<sprocket_agent::TranscriptPartsPage>, ApiError> {
    require_session_user(&state, &headers, &jar, &payload.user_id).await?;
    let transcript_state =
        load_transcript_state(&state, &payload.user_id, &payload.thread_id).await?;
    let (start, end) = parts_window(
        transcript_state.visible_end_exclusive(),
        payload.before,
        payload.limit,
    );
    if start < end
        && !state
            .transcript
            .has_complete_range(&payload.user_id, &payload.thread_id, start, end)
            .await
            .map_err(|error| ApiError::internal_with("failed to inspect transcript parts", error))?
    {
        let client = UserConvexClient::connect_with_fetcher(
            &state.convex_deployment_url,
            state
                .native_auth
                .auth_token_fetcher_for_user(payload.user_id.clone()),
        )
        .await
        .map_err(|error| {
            ApiError::internal_with("failed to connect while loading transcript parts", error)
        })?;
        crate::transcript_client::sync_range(
            &state.transcript,
            &client,
            &payload.user_id,
            &payload.thread_id,
            start,
            end,
        )
        .await
        .map_err(|error| ApiError::internal_with("failed to load transcript parts", error))?;
        if !state
            .transcript
            .has_complete_range(&payload.user_id, &payload.thread_id, start, end)
            .await
            .map_err(|error| ApiError::internal_with("failed to inspect transcript parts", error))?
        {
            return Err(ApiError::internal_with(
                "incomplete transcript history",
                anyhow!("transcript parts are not yet available; retry the page"),
            ));
        }
    }

    // A watch update during the fetch must not shift this page to uncached parts.
    let page = state
        .transcript
        .parts_page(
            &payload.user_id,
            &payload.thread_id,
            Some(end),
            payload.limit,
        )
        .await
        .map_err(|error| ApiError::internal_with("failed to read transcript replica", error))?;
    Ok(Json(page))
}

async fn load_transcript_state(
    state: &AppState,
    user_id: &str,
    thread_id: &str,
) -> Result<sprocket_agent::TranscriptState, ApiError> {
    let transcript_state = state
        .transcript
        .load_state(user_id, thread_id)
        .await
        .map_err(|error| ApiError::internal_with("failed to read transcript state", error))?;
    if transcript_state.visible_end_exclusive() > 0 {
        return Ok(transcript_state);
    }
    let client = UserConvexClient::connect_with_fetcher(
        &state.convex_deployment_url,
        state
            .native_auth
            .auth_token_fetcher_for_user(user_id.to_string()),
    )
    .await
    .map_err(|error| {
        ApiError::internal_with("failed to connect while loading transcript", error)
    })?;
    let remote = client
        .ensure_migrated(thread_id)
        .await
        .map_err(|error| ApiError::internal_with("failed to load transcript state", error))?;
    sprocket_agent::apply_remote_state(&state.transcript, user_id, thread_id, &remote, false)
        .await
        .map_err(|error| ApiError::internal_with("failed to save transcript state", error))
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde::de::DeserializeOwned;

    fn parse<T: DeserializeOwned>(thread_id: &str, mut extra: serde_json::Value) -> bool {
        extra["userId"] = "user-1".into();
        extra["threadId"] = thread_id.into();
        serde_json::from_value::<T>(extra).is_ok()
    }

    #[test]
    fn request_thread_ids_reject_unsafe_paths() {
        use serde_json::json;

        for thread_id in [
            "", "blobs", "BLOBS", "../other", "a\\b", "C:", "blobs ", "thread-1",
        ] {
            let valid = thread_id == "thread-1";
            assert_eq!(parse::<TranscriptScope>(thread_id, json!({})), valid);
            assert_eq!(parse::<TranscriptPageRequest>(thread_id, json!({})), valid);
            assert_eq!(
                parse::<TranscriptAttachmentRequest>(
                    thread_id,
                    json!({"imageUploadId": "upload-1"})
                ),
                valid
            );
            assert_eq!(
                parse::<TranscriptDetailsRequest>(thread_id, json!({"numbers": [1]})),
                valid
            );
        }
    }

    #[test]
    fn part_detail_numbers_are_capped_and_strictly_increasing() {
        assert!(require_transcript_numbers(&[0, 1, 2], Some(100)).is_ok());
        assert!(require_transcript_numbers(&[], Some(100)).is_err());
        assert!(require_transcript_numbers(&[2, 1], Some(100)).is_err());
        assert!(require_transcript_numbers(&[1, 1], Some(100)).is_err());
        assert!(require_transcript_numbers(&(0..101).collect::<Vec<_>>(), Some(100)).is_err());
        assert!(require_transcript_numbers(&(0..101).collect::<Vec<_>>(), None).is_ok());
    }
}
