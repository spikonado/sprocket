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
    let mut args = std::collections::BTreeMap::new();
    args.insert("threadId".to_string(), payload.thread_id.clone().into());
    args.insert("limit".to_string(), convex::Value::Float64(limit as f64));
    args.insert(
        "streams".to_string(),
        convex::Value::Array(
            payload
                .streams
                .into_iter()
                .map(|stream| {
                    convex::Value::Object(std::collections::BTreeMap::from([
                        ("runId".to_string(), stream.run_id.into()),
                        ("streamId".to_string(), stream.stream_id.into()),
                    ]))
                })
                .collect(),
        ),
    );
    if let Some(cursor) = payload.changes_after {
        if cursor.revision > 9_007_199_254_740_991
            || !(-1..=9_007_199_254_740_991).contains(&cursor.sequence)
        {
            return Err(ApiError::bad_request(anyhow!(
                "invalid display change cursor"
            )));
        }
        args.insert(
            "changesAfter".to_string(),
            convex::Value::Object(std::collections::BTreeMap::from([
                (
                    "revision".to_string(),
                    convex::Value::Float64(cursor.revision as f64),
                ),
                (
                    "sequence".to_string(),
                    convex::Value::Float64(cursor.sequence as f64),
                ),
            ])),
        );
    }
    if let Some(before) = payload.before {
        args.insert("before".to_string(), convex::Value::Float64(before as f64));
    }
    let key = format!("page-{:?}-{limit}", payload.before);
    display_query(
        &state,
        &payload.user_id,
        &payload.thread_id,
        "transcriptDisplay:page",
        args,
        &key,
    )
    .await
    .map(Json)
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
    let mut args = std::collections::BTreeMap::new();
    args.insert("threadId".to_string(), payload.thread_id.clone().into());
    args.insert("rowId".to_string(), payload.row_id.clone().into());
    args.insert("limit".to_string(), convex::Value::Float64(limit as f64));
    if let Some(after) = payload.after {
        args.insert("after".to_string(), convex::Value::Float64(after as f64));
    }
    if let Some(before) = payload.before {
        args.insert("before".to_string(), convex::Value::Float64(before as f64));
    }
    if let Some(latest) = payload.latest {
        args.insert("latest".to_string(), convex::Value::Boolean(latest));
    }
    let key = format!(
        "details-{}-{:?}-{:?}-{}-{limit}",
        payload.row_id,
        payload.after,
        payload.before,
        payload.latest.unwrap_or(false)
    );
    display_query(
        &state,
        &payload.user_id,
        &payload.thread_id,
        "transcriptDisplay:details",
        args,
        &key,
    )
    .await
    .map(Json)
}

async fn display_query(
    state: &AppState,
    user_id: &str,
    thread_id: &str,
    function: &str,
    args: std::collections::BTreeMap<String, convex::Value>,
    key: &str,
) -> Result<serde_json::Value, ApiError> {
    let changes_after = match args.get("changesAfter") {
        Some(convex::Value::Object(cursor)) => {
            match (cursor.get("revision"), cursor.get("sequence")) {
                (
                    Some(convex::Value::Float64(revision)),
                    Some(convex::Value::Float64(sequence)),
                ) => Some((*revision, *sequence)),
                _ => None,
            }
        }
        _ => None,
    };
    let cached = state
        .transcript
        .display_cache(user_id, thread_id, key)
        .await
        .ok()
        .flatten()
        .filter(serde_json::Value::is_object);
    if let Some(value) = cached.as_ref() {
        if let Ok(local) = state.transcript.load_state(user_id, thread_id).await {
            let no_streams = args
                .get("streams")
                .and_then(|value| match value {
                    convex::Value::Array(streams) => Some(streams.is_empty()),
                    _ => None,
                })
                .unwrap_or(true);
            let age = value
                .get("cachedAt")
                .and_then(serde_json::Value::as_u64)
                .map(|saved| unix_seconds().saturating_sub(saved));
            let current_page = !local.stale
                && age.is_some_and(|age| age < 2)
                && function == "transcriptDisplay:page"
                && no_streams
                && value
                    .get("revision")
                    .and_then(serde_json::Value::as_f64)
                    .is_some_and(|revision| {
                        revision >= f64::from(local.remote_total_parts)
                            && changes_after.is_none_or(|(after, sequence)| {
                                after == revision && sequence == -1.0
                            })
                    });
            if current_page {
                let mut value = value.clone();
                value["stale"] = local.stale.into();
                if function == "transcriptDisplay:page" {
                    keep_cached_change_cursor(&mut value, changes_after);
                }
                return Ok(value);
            }
        }
    }
    let remote = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        let client = UserConvexClient::connect_with_fetcher(
            &state.convex_deployment_url,
            state
                .native_auth
                .auth_token_fetcher_for_user(user_id.to_string()),
        )
        .await?;
        let value = client.query::<serde_json::Value>(function, args).await?;
        if function == "transcriptDisplay:page"
            && value.get("indexing").and_then(serde_json::Value::as_bool) == Some(true)
        {
            client
                .mutate::<serde_json::Value>(
                    "transcriptDisplay:prepare",
                    std::collections::BTreeMap::from([(
                        "threadId".to_string(),
                        thread_id.to_string().into(),
                    )]),
                )
                .await?;
        }
        Ok::<_, anyhow::Error>(value)
    })
    .await;
    match remote {
        Ok(Ok(mut value)) => {
            if !value.is_object() {
                return Err(ApiError::internal(anyhow!(
                    "invalid display history response"
                )));
            }
            value["stale"] = false.into();
            value["cachedAt"] = unix_seconds().into();
            if value.get("indexing").and_then(serde_json::Value::as_bool) != Some(true) {
                if let Err(error) = state
                    .transcript
                    .save_display_cache(user_id, thread_id, key, &value)
                    .await
                {
                    tracing::warn!("failed to cache display history: {error:#}");
                }
            }
            Ok(value)
        }
        error => {
            if let Some(mut cached) = cached {
                cached["stale"] = true.into();
                if function == "transcriptDisplay:page" {
                    keep_cached_change_cursor(&mut cached, changes_after);
                }
                return Ok(cached);
            }
            Err(ApiError::internal_with(
                "failed to load display history",
                anyhow!("{error:?}"),
            ))
        }
    }
}

fn keep_cached_change_cursor(value: &mut serde_json::Value, after: Option<(f64, f64)>) {
    let (revision, sequence) = after.unwrap_or_else(|| {
        (
            value
                .get("revision")
                .and_then(serde_json::Value::as_f64)
                .unwrap_or(0.0),
            -1.0,
        )
    });
    value["changes"] = serde_json::json!([]);
    value["changesCursor"] = serde_json::json!({ "revision": revision, "sequence": sequence });
    value["moreChanges"] = false.into();
}

fn unix_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
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
    #[test]
    fn cached_pages_do_not_acknowledge_unseen_changes() {
        let mut page = serde_json::json!({ "revision": 40, "changes": [{ "id": "new" }], "changesCursor": { "revision": 40, "sequence": -1 }, "moreChanges": true });
        super::keep_cached_change_cursor(&mut page, Some((20.0, 64.0)));
        assert_eq!(page["changes"], serde_json::json!([]));
        assert_eq!(
            page["changesCursor"],
            serde_json::json!({ "revision": 20.0, "sequence": 64.0 })
        );
        assert_eq!(page["moreChanges"], false);
    }
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
