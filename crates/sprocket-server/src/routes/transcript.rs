use anyhow::anyhow;
use axum::Json;
use axum::body::Body;
use axum::extract::State;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use serde::{Deserialize, Serialize};
use sprocket_host::transcript_client::FileDownload;
use sprocket_transcript::rows::TranscriptRow;
use sprocket_transcript::{TranscriptAttachmentMeta, cache_attachment};
use tokio_util::io::ReaderStream;

use crate::AppState;
use crate::routes::api_error::ApiError;
use crate::routes::session::{AuthorizedJson, UserScoped};
use crate::routes::transcript_rows::{
    self, TranscriptRowScope, TranscriptRowsEvent, TranscriptRowsScope,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TranscriptAttachmentRequest {
    user_id: String,
    #[serde(deserialize_with = "deserialize_path_safe_id")]
    thread_id: String,
    file_id: String,
}

impl UserScoped for TranscriptAttachmentRequest {
    fn user_id(&self) -> &str {
        &self.user_id
    }
}

pub(crate) fn deserialize_path_safe_id<'de, D: serde::Deserializer<'de>>(
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

pub(crate) fn deserialize_row_id<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<String, D::Error> {
    let id = String::deserialize(deserializer)?;
    if id.is_empty() || id.len() > 512 || id.chars().any(char::is_control) {
        return Err(serde::de::Error::custom("invalid transcript row ID"));
    }
    Ok(id)
}

pub fn routes() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/transcript/rows", post(rows_handler))
        .route("/transcript/row", post(row_handler))
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

async fn rows_handler(
    State(state): State<AppState>,
    AuthorizedJson(payload): AuthorizedJson<TranscriptRowsScope>,
) -> Result<Json<TranscriptRowsEvent>, ApiError> {
    let snapshot =
        transcript_rows::page(&state, &payload.user_id, &payload.thread_id, payload.before).await?;
    Ok(Json(TranscriptRowsEvent::Snapshot { snapshot }))
}

#[derive(Serialize)]
struct RowResponse {
    row: TranscriptRow,
}

async fn row_handler(
    State(state): State<AppState>,
    AuthorizedJson(payload): AuthorizedJson<TranscriptRowScope>,
) -> Result<Json<RowResponse>, ApiError> {
    let row = transcript_rows::row(&state, &payload.user_id, &payload.thread_id, payload.row_id)
        .await?
        .ok_or_else(|| {
            ApiError::with_status(StatusCode::NOT_FOUND, anyhow!("transcript row not found"))
        })?;
    Ok(Json(RowResponse { row }))
}

async fn attachment_handler(
    State(state): State<AppState>,
    AuthorizedJson(payload): AuthorizedJson<TranscriptAttachmentRequest>,
) -> Result<Response, ApiError> {
    let TranscriptAttachmentRequest {
        user_id,
        thread_id,
        file_id,
    } = &payload;
    let store = &state.host.transcript;
    let _lease = store
        .open_thread(user_id, thread_id)
        .await
        .map_err(|error| ApiError::internal_with("failed to open thread cache", error))?;
    let cached = store
        .attachment_metadata(user_id, thread_id, file_id)
        .await
        .map_err(|error| ApiError::internal_with("failed to read cached attachment", error))?;
    let (attachment, url) = match cached {
        Some(meta) => (meta, None),
        None => {
            let remote = file_download(&state, user_id, file_id).await?;
            let meta = TranscriptAttachmentMeta {
                name: remote.name,
                media_type: remote.media_type,
                size: remote.size,
                file_id: Some(file_id.clone()),
                local_path: None,
            };
            (meta, Some(remote.url))
        }
    };
    let path = cache_attachment(store, user_id, thread_id, &attachment, || async {
        match url {
            Some(url) => Ok(url),
            None => Ok(file_download(&state, user_id, file_id).await?.url),
        }
    })
    .await
    .map_err(|error| match error.downcast::<ApiError>() {
        Ok(error) => error,
        Err(error) => ApiError::internal_with("failed to cache attachment", error),
    })?;
    attachment_response(&path, &attachment.media_type).await
}

async fn file_download(
    state: &AppState,
    user_id: &str,
    file_id: &str,
) -> Result<FileDownload, ApiError> {
    state
        .host
        .convex_client_for(user_id)
        .await
        .map_err(|error| ApiError::internal_with("failed to connect to Convex", error))?
        .file_download(file_id)
        .await
        .map_err(|error| ApiError::internal_with("failed to resolve attachment", error))?
        .ok_or_else(|| {
            ApiError::with_status(StatusCode::NOT_FOUND, anyhow!("attachment not found"))
        })
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
mod tests;
