use std::convert::Infallible;

use anyhow::anyhow;
use axum::Json;
use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum_extra::extract::CookieJar;
use futures::stream::unfold;
use serde::Deserialize;
use sprocket_agent::{AttachmentUnavailable, TranscriptAttachmentMeta, cache_attachment};
use tokio::sync::broadcast;
use tokio_util::io::ReaderStream;

use crate::AppState;
use crate::routes::api_error::ApiError;
use crate::transcript_client::UserConvexClient;
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
struct TranscriptAttachmentRequest {
    user_id: String,
    #[serde(deserialize_with = "deserialize_thread_id")]
    thread_id: String,
    storage_id: String,
}

fn deserialize_thread_id<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<String, D::Error> {
    let id = String::deserialize(deserializer)?;
    if id.is_empty()
        || id.eq_ignore_ascii_case("blobs")
        || id.eq_ignore_ascii_case("pending-attachments")
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
        .route("/transcript/display", post(display_handler))
        .route("/transcript/display-details", post(display_details_handler))
        .route("/transcript/watch", post(watch_handler))
        .route("/transcript/clear", post(clear_handler))
        .route("/transcript/attachment", post(attachment_handler))
        .route(
            "/transcript/upload",
            post(super::attachment_upload::upload_handler),
        )
        .route(
            "/transcript/discard",
            post(super::attachment_upload::discard_handler),
        )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DisplayDetailsRequest {
    user_id: String,
    #[serde(deserialize_with = "deserialize_thread_id")]
    thread_id: String,
    #[serde(deserialize_with = "deserialize_thread_id")]
    row_id: String,
    after: Option<u64>,
    before: Option<u64>,
    latest: Option<bool>,
    limit: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DisplayStream {
    #[serde(deserialize_with = "deserialize_thread_id")]
    run_id: String,
    stream_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DisplayChangeCursor {
    revision: u64,
    sequence: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DisplayRequest {
    user_id: String,
    #[serde(deserialize_with = "deserialize_thread_id")]
    thread_id: String,
    before: Option<u64>,
    limit: Option<u32>,
    #[serde(default)]
    streams: Vec<DisplayStream>,
    changes_after: Option<DisplayChangeCursor>,
}

async fn display_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(payload): Json<DisplayRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_session_user(&state, &headers, &jar, &payload.user_id).await?;
    let limit = payload.limit.unwrap_or(12);
    if !(1..=40).contains(&limit)
        || payload.streams.len() > 64
        || payload
            .before
            .is_some_and(|before| before > 9_007_199_254_740_991)
    {
        return Err(ApiError::bad_request(anyhow!("invalid display page limit")));
    }
    if let Some(cursor) = &payload.changes_after {
        if cursor.revision > 9_007_199_254_740_991
            || !(-1..=9_007_199_254_740_991).contains(&cursor.sequence)
        {
            return Err(ApiError::bad_request(anyhow!(
                "invalid display change cursor"
            )));
        }
    }
    let changes = payload.changes_after.map(|c| (c.revision, c.sequence));
    let streams = payload
        .streams
        .into_iter()
        .map(|s| (s.run_id, s.stream_id))
        .collect::<Vec<_>>();
    let stale = state
        .transcript
        .load_state(&payload.user_id, &payload.thread_id)
        .await
        .map_err(ApiError::internal)?
        .stale;
    state
        .transcript
        .with_work_replica(&payload.user_id, &payload.thread_id, move |replica| {
            replica.page(payload.before, limit, changes, &streams, stale)
        })
        .await
        .map(Json)
        .map_err(ApiError::internal)
}

async fn display_details_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(payload): Json<DisplayDetailsRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_session_user(&state, &headers, &jar, &payload.user_id).await?;
    let limit = payload.limit.unwrap_or(5);
    if !(1..=5).contains(&limit)
        || [payload.after, payload.before]
            .into_iter()
            .flatten()
            .any(|value| value > 9_007_199_254_740_991)
        || (payload.after.is_some() && payload.before.is_some())
        || (payload.latest == Some(true) && (payload.after.is_some() || payload.before.is_some()))
    {
        return Err(ApiError::bad_request(anyhow!(
            "invalid display detail page"
        )));
    }
    let stale = state
        .transcript
        .load_state(&payload.user_id, &payload.thread_id)
        .await
        .map_err(ApiError::internal)?
        .stale;
    state
        .transcript
        .with_work_replica(&payload.user_id, &payload.thread_id, move |replica| {
            replica.details(
                &payload.row_id,
                payload.after,
                payload.before,
                payload.latest.unwrap_or(false),
                limit,
                stale,
            )
        })
        .await
        .map(Json)
        .map_err(ApiError::internal)
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
    if let Some(response) = serve_cached_attachment(
        &state,
        &payload.user_id,
        &payload.thread_id,
        &payload.storage_id,
    )
    .await?
    {
        return Ok(response);
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
        .attachment_download_by_storage_id(&payload.storage_id)
        .await
        .map_err(|error| ApiError::internal_with("failed to resolve attachment", error))?
    else {
        return Err(ApiError::with_status(
            StatusCode::NOT_FOUND,
            anyhow!("attachment not found"),
        ));
    };
    let attachment = TranscriptAttachmentMeta {
        storage_id: remote.storage_id,
        name: remote.name,
        media_type: remote.media_type,
        size: remote.size,
        url: Some(remote.url),
        local_path: None,
    };
    let path = match cache_attachment(
        &state.transcript,
        &payload.user_id,
        &payload.thread_id,
        &attachment,
    )
    .await
    {
        Ok(path) => path,
        Err(error) if error.is::<AttachmentUnavailable>() => {
            return Err(ApiError::with_status(
                StatusCode::NOT_FOUND,
                anyhow!("attachment not found"),
            ));
        }
        Err(error) => {
            return Err(ApiError::internal_with("failed to cache attachment", error));
        }
    };
    attachment_response(&path, &attachment.media_type).await
}

async fn serve_cached_attachment(
    state: &AppState,
    user_id: &str,
    thread_id: &str,
    storage_id: &str,
) -> Result<Option<Response>, ApiError> {
    let meta = state
        .transcript
        .attachment_metadata(user_id, thread_id, storage_id)
        .await
        .map_err(|error| {
            ApiError::internal_with(
                &format!("failed to read cached attachment for thread {thread_id}"),
                error,
            )
        })?;
    let Some(meta) = meta else {
        return Ok(None);
    };
    match cache_attachment(&state.transcript, user_id, thread_id, &meta).await {
        Ok(path) => attachment_response(&path, &meta.media_type).await.map(Some),
        Err(error) if error.is::<AttachmentUnavailable>() => Ok(None),
        Err(error) => Err(ApiError::internal_with(
            "failed to migrate cached attachment",
            error,
        )),
    }
}

async fn attachment_response(
    path: &std::path::Path,
    media_type: &str,
) -> Result<Response, ApiError> {
    let file = tokio::fs::File::open(path)
        .await
        .map_err(|error| ApiError::internal(error.into()))?;
    Ok((
        [
            (
                header::CONTENT_TYPE,
                header::HeaderValue::from_str(media_type).unwrap_or_else(|_| {
                    header::HeaderValue::from_static("application/octet-stream")
                }),
            ),
            (
                header::CACHE_CONTROL,
                header::HeaderValue::from_static("private, max-age=31536000, immutable"),
            ),
            (
                header::CONTENT_DISPOSITION,
                header::HeaderValue::from_static("attachment"),
            ),
            (
                header::X_CONTENT_TYPE_OPTIONS,
                header::HeaderValue::from_static("nosniff"),
            ),
        ],
        Body::from_stream(ReaderStream::new(file)),
    )
        .into_response())
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
            assert_eq!(parse::<DisplayRequest>(thread_id, json!({})), valid);
            assert_eq!(
                parse::<DisplayDetailsRequest>(thread_id, json!({ "rowId": "row-1" })),
                valid
            );
            assert_eq!(
                parse::<TranscriptAttachmentRequest>(thread_id, json!({"storageId": "storage-1"})),
                valid
            );
        }
    }
}
