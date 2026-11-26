use std::collections::BTreeMap;
use std::path::Path;
use std::time::{Duration, SystemTime};

use anyhow::{Context, anyhow};
use axum::Json;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, StatusCode, header};
use convex::Value;
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sprocket_convex::{ConvexErrorCode, convex_function_error};
use sprocket_host::transcript_client::UserConvexClient;
use tokio::io::AsyncWriteExt;
use tokio_util::io::ReaderStream;

use crate::AppState;
use crate::routes::api_error::ApiError;
use crate::routes::session::{AuthorizedJson, AuthorizedQuery, UserScoped};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct UploadQuery {
    user_id: String,
    name: String,
    #[serde(rename = "threadId")]
    _thread_id: Option<String>,
}

impl UserScoped for UploadQuery {
    fn user_id(&self) -> &str {
        &self.user_id
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct UploadedAttachment {
    file_id: String,
    name: String,
    media_type: String,
    #[serde(deserialize_with = "sprocket_convex::deserialize_convex_u64")]
    size: u64,
}

#[derive(Deserialize)]
struct CreatedUpload {
    file: UploadedAttachment,
    upload: Option<PresignedUpload>,
}

#[derive(Deserialize)]
struct PresignedUpload {
    url: String,
    headers: BTreeMap<String, String>,
}

pub(super) async fn upload_handler(
    State(state): State<AppState>,
    AuthorizedQuery(query): AuthorizedQuery<UploadQuery>,
    headers: HeaderMap,
    request: Request,
) -> Result<Json<UploadedAttachment>, ApiError> {
    let media_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    upload(&state, query, media_type, request)
        .await
        .map(Json)
        .map_err(upload_error)
}

fn upload_error(error: anyhow::Error) -> ApiError {
    let Some(failure) = convex_function_error(&error) else {
        return ApiError::internal_with("attachment upload failed", error);
    };
    let status = match failure.code {
        Some(ConvexErrorCode::FileTooLarge) => StatusCode::PAYLOAD_TOO_LARGE,
        Some(ConvexErrorCode::StorageLimitReached) => StatusCode::INSUFFICIENT_STORAGE,
        _ => return ApiError::internal_with("attachment upload failed", error),
    };
    ApiError::with_status(status, anyhow!("{}", failure.message()))
}

async fn upload(
    state: &AppState,
    query: UploadQuery,
    media_type: String,
    request: Request,
) -> anyhow::Result<UploadedAttachment> {
    let client = state.host.convex_client_for(&query.user_id).await?;
    let store = &state.host.transcript;
    let pending = store.pending_attachment_path(&query.user_id, "upload");
    let dir = pending.parent().context("invalid staging directory")?;
    tokio::fs::create_dir_all(dir).await?;
    let temp = tempfile::NamedTempFile::new_in(dir)?;
    let _upload_guard = store.protect_pending_upload(temp.path()).await;
    let (size, sha256) = stage_body(request.into_body(), temp.path()).await?;
    let CreatedUpload { file, upload } = client
        .mutate(
            "files:createUpload",
            BTreeMap::from([
                ("name".into(), query.name.into()),
                ("mediaType".into(), media_type.into()),
                ("size".into(), Value::Float64(size as f64)),
                ("sha256".into(), sha256.into()),
            ]),
        )
        .await?;
    if let Some(upload) = upload
        && let Err(error) = put_file(upload, temp.path()).await
    {
        if let Err(discard_error) = discard_remote(&client, &file.file_id).await {
            tracing::warn!("failed to discard a file whose upload failed: {discard_error:#}");
        }
        return Err(error);
    }
    temp.as_file().set_modified(SystemTime::now())?;
    temp.persist(store.pending_attachment_path(&query.user_id, &file.file_id))?;
    Ok(file)
}

async fn stage_body(body: axum::body::Body, path: &Path) -> anyhow::Result<(u64, String)> {
    let mut file = tokio::fs::File::create(path).await?;
    let mut stream = body.into_data_stream();
    let mut hasher = Sha256::new();
    let mut size = 0u64;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        hasher.update(&chunk);
        file.write_all(&chunk).await?;
        size += chunk.len() as u64;
    }
    file.sync_all().await?;
    Ok((size, hex::encode(hasher.finalize())))
}

async fn put_file(upload: PresignedUpload, path: &Path) -> anyhow::Result<()> {
    let mut headers = reqwest::header::HeaderMap::new();
    for (name, value) in upload.headers {
        headers.insert(
            reqwest::header::HeaderName::try_from(name)?,
            reqwest::header::HeaderValue::try_from(value)?,
        );
    }
    let file = tokio::fs::File::open(path).await?;
    reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(Duration::from_secs(30))
        .read_timeout(Duration::from_secs(60))
        .build()?
        .put(upload.url)
        .headers(headers)
        .body(reqwest::Body::wrap_stream(ReaderStream::new(file)))
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(reqwest::Error::without_url)?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct DiscardRequest {
    user_id: String,
    thread_id: Option<String>,
    file_id: String,
}

impl UserScoped for DiscardRequest {
    fn user_id(&self) -> &str {
        &self.user_id
    }
}

pub(super) async fn discard_handler(
    State(state): State<AppState>,
    AuthorizedJson(payload): AuthorizedJson<DiscardRequest>,
) -> Result<Json<bool>, ApiError> {
    discard(&state, &payload)
        .await
        .map(Json)
        .map_err(|error| ApiError::internal_with("attachment discard failed", error))
}

async fn discard(state: &AppState, payload: &DiscardRequest) -> anyhow::Result<bool> {
    let client = state.host.convex_client_for(&payload.user_id).await?;
    let deleted = discard_remote(&client, &payload.file_id).await?;
    if deleted {
        state
            .host
            .transcript
            .discard_attachment(
                &payload.user_id,
                payload.thread_id.as_deref(),
                &payload.file_id,
            )
            .await?;
    }
    Ok(deleted)
}

async fn discard_remote(client: &UserConvexClient, file_id: &str) -> anyhow::Result<bool> {
    client
        .mutate(
            "files:discard",
            BTreeMap::from([("fileId".into(), file_id.to_string().into())]),
        )
        .await
}

#[cfg(test)]
mod tests;
