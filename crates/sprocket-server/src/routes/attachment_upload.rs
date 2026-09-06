use std::collections::BTreeMap;
use std::time::Duration;

use anyhow::Context;
use axum::Json;
use axum::extract::{Query, Request, State};
use axum::http::{HeaderMap, header};
use axum_extra::extract::CookieJar;
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use sprocket_convex::deserialize_convex_u64;
use tokio::io::AsyncWriteExt;
use tokio_util::io::ReaderStream;

use crate::AppState;
use crate::auth::require_session_user;
use crate::routes::api_error::ApiError;
use crate::transcript_client::UserConvexClient;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct UploadQuery {
    user_id: String,
    name: String,
    thread_id: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct UploadedAttachment {
    image_upload_id: String,
    name: String,
    media_type: String,
    #[serde(deserialize_with = "deserialize_convex_u64")]
    size: u64,
    url: String,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum RegistrationResult {
    Success(UploadedAttachment),
    Error { error: String },
}

pub(super) async fn upload_handler(
    State(state): State<AppState>,
    Query(query): Query<UploadQuery>,
    headers: HeaderMap,
    jar: CookieJar,
    request: Request,
) -> Result<Json<UploadedAttachment>, ApiError> {
    require_session_user(&state.auth, &headers, &jar, &query.user_id)
        .await
        .map_err(ApiError::unauthorized)?;
    state
        .native_auth
        .require_user(&query.user_id)
        .await
        .map_err(ApiError::unauthorized)?;
    let media_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    upload(&state, query, media_type, request)
        .await
        .map(Json)
        .map_err(|error| ApiError::internal_with("attachment upload failed", error))
}

async fn upload(
    state: &AppState,
    query: UploadQuery,
    media_type: String,
    request: Request,
) -> anyhow::Result<UploadedAttachment> {
    let client = UserConvexClient::connect_with_fetcher(
        &state.convex_deployment_url,
        state
            .native_auth
            .auth_token_fetcher_for_user(query.user_id.clone()),
    )
    .await?;
    if let Some(thread_id) = &query.thread_id {
        client.ensure_migrated(thread_id).await?;
    }
    let pending = state
        .transcript
        .pending_attachment_path(&query.user_id, "upload");
    let dir = pending.parent().context("invalid staging directory")?;
    tokio::fs::create_dir_all(dir).await?;
    let temp = tempfile::NamedTempFile::new_in(dir)?;
    let _upload_guard = state.transcript.protect_pending_upload(temp.path()).await;
    let size = stage_body(request.into_body(), temp.path()).await?;
    let upload_url: String = client
        .mutate("imageUploads:generateUploadUrl", BTreeMap::new())
        .await?;
    let file = tokio::fs::File::open(temp.path()).await?;
    let response = reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(Duration::from_secs(30))
        .read_timeout(Duration::from_secs(60))
        .build()?
        .post(upload_url)
        .header(header::CONTENT_TYPE, media_type)
        .header(header::CONTENT_LENGTH, size)
        .body(reqwest::Body::wrap_stream(ReaderStream::new(file)))
        .send()
        .await?
        .error_for_status()?;
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct StorageUpload {
        storage_id: String,
    }
    let uploaded: StorageUpload = serde_json::from_slice(&response.bytes().await?)?;
    let result: RegistrationResult = client
        .mutate(
            "imageUploads:register",
            BTreeMap::from([
                ("storageId".into(), uploaded.storage_id.clone().into()),
                ("name".into(), query.name.into()),
            ]),
        )
        .await?;
    let result = match result {
        RegistrationResult::Success(result) => result,
        RegistrationResult::Error { error } => anyhow::bail!(error),
    };
    anyhow::ensure!(result.size == size, "uploaded attachment size mismatch");
    temp.as_file().set_modified(std::time::SystemTime::now())?;
    temp.persist(
        state
            .transcript
            .pending_attachment_path(&query.user_id, &uploaded.storage_id),
    )?;
    Ok(result)
}

async fn stage_body(body: axum::body::Body, path: &std::path::Path) -> anyhow::Result<u64> {
    let mut file = tokio::fs::File::create(path).await?;
    let mut stream = body.into_data_stream();
    let mut size = 0u64;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        file.write_all(&chunk).await?;
        size += chunk.len() as u64;
    }
    file.sync_all().await?;
    Ok(size)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct DiscardRequest {
    user_id: String,
    thread_id: Option<String>,
    image_upload_id: String,
}

pub(super) async fn discard_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(payload): Json<DiscardRequest>,
) -> Result<Json<bool>, ApiError> {
    require_session_user(&state.auth, &headers, &jar, &payload.user_id)
        .await
        .map_err(ApiError::unauthorized)?;
    state
        .native_auth
        .require_user(&payload.user_id)
        .await
        .map_err(ApiError::unauthorized)?;
    discard(&state, payload)
        .await
        .map(Json)
        .map_err(|error| ApiError::internal_with("attachment discard failed", error))
}

async fn discard(state: &AppState, payload: DiscardRequest) -> anyhow::Result<bool> {
    let client = UserConvexClient::connect_with_fetcher(
        &state.convex_deployment_url,
        state
            .native_auth
            .auth_token_fetcher_for_user(payload.user_id.clone()),
    )
    .await?;
    let Some(attachment) = client.attachment_download(&payload.image_upload_id).await? else {
        return Ok(false);
    };
    let deleted: bool = client
        .mutate(
            "imageUploads:discard",
            BTreeMap::from([(
                "imageUploadId".into(),
                payload.image_upload_id.clone().into(),
            )]),
        )
        .await?;
    if deleted {
        state
            .transcript
            .discard_attachment(
                &payload.user_id,
                payload.thread_id.as_deref(),
                &payload.image_upload_id,
                &attachment.storage_id,
            )
            .await?;
    }
    Ok(deleted)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{Body, Bytes};

    #[tokio::test]
    async fn stages_large_binary_uploads_without_a_body_size_limit() {
        let temp = tempfile::NamedTempFile::new().unwrap();
        let chunks = futures::stream::iter(
            (0..12).map(|_| Ok::<_, std::io::Error>(Bytes::from(vec![0xff; 1024 * 1024]))),
        );
        let size = stage_body(Body::from_stream(chunks), temp.path())
            .await
            .unwrap();
        assert_eq!(size, 12 * 1024 * 1024);
        assert_eq!(tokio::fs::metadata(temp.path()).await.unwrap().len(), size);
    }

    #[tokio::test]
    async fn failed_upload_stream_is_not_reported_as_complete() {
        let temp = tempfile::NamedTempFile::new().unwrap();
        let chunks = futures::stream::iter([
            Ok(Bytes::from_static(b"partial")),
            Err(std::io::Error::other("connection closed")),
        ]);
        assert!(
            stage_body(Body::from_stream(chunks), temp.path())
                .await
                .is_err()
        );
    }
}
