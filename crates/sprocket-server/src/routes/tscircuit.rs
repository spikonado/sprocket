use anyhow::{Context, anyhow};
use axum::Json;
use axum::body::Body;
use axum::extract::{OriginalUri, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::response::Response;
use axum::routing::{any, post};
use axum_extra::extract::CookieJar;
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use sprocket_host::project_attachments::resolve_workspace_path;

use crate::AppState;
use crate::routes::api_error::{ApiError, no_store};
use crate::routes::browser::{require_same_origin, user};

const PROXY_PATH: &str = "/api/tscircuit/dev/";
const MAX_REQUEST_BYTES: usize = 32 * 1024 * 1024;
const MAX_REWRITTEN_BYTES: usize = 1024 * 1024;
const EXTRA_TABS_SCRIPT: &str = "/extra-runframe-tabs.js";
/// The editor runs same-origin with Sprocket because its module eval worker fails in an opaque
/// origin, so this policy keeps its scripts and requests on Sprocket and drops its analytics.
const CONTENT_SECURITY_POLICY: &str = "default-src 'self'; \
    script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https://cdn.tailwindcss.com; \
    worker-src 'self' blob:; connect-src 'self' blob: data:; img-src 'self' data: blob:; \
    style-src 'self' 'unsafe-inline'; font-src 'self' data:";

pub fn routes() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/tscircuit/dev", post(start))
        .route("/tscircuit/dev/{id}/", any(proxy))
        .route("/tscircuit/dev/{id}/{*path}", any(proxy))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartRequest {
    workspace_path: String,
    path: String,
}

#[derive(Serialize)]
struct StartResponse {
    url: String,
    file: String,
}

async fn start(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(payload): Json<StartRequest>,
) -> Result<Response, ApiError> {
    user(&state, &headers, &jar).await?;
    require_same_origin(&headers)?;
    let root =
        tokio::task::spawn_blocking(move || resolve_workspace_path(&payload.workspace_path, false))
            .await
            .map_err(|error| ApiError::internal(error.into()))?
            .map_err(ApiError::bad_request)?
            .workspace_path;
    let session = state
        .host
        .tscircuit_dev
        .start(std::path::Path::new(&root), &payload.path)
        .await
        .map_err(|error| ApiError::bad_request(anyhow!("{error:#}")))?;
    Ok(no_store(Json(StartResponse {
        url: format!("{PROXY_PATH}{}/", session.id),
        file: session.file,
    })))
}

async fn proxy(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    method: Method,
    headers: HeaderMap,
    jar: CookieJar,
    body: Body,
) -> Result<Response, ApiError> {
    user(&state, &headers, &jar).await?;
    if !matches!(method, Method::GET | Method::HEAD) {
        require_same_origin(&headers)?;
    }
    let (id, path) = upstream_path(
        uri.path_and_query()
            .map(|value| value.as_str())
            .unwrap_or(""),
    )
    .map_err(ApiError::bad_request)?;
    let servers = &state.host.tscircuit_dev;
    let port = servers
        .port(&id)
        .await
        .map_err(|error| ApiError::with_status(StatusCode::SERVICE_UNAVAILABLE, error))?;
    let bytes = axum::body::to_bytes(body, MAX_REQUEST_BYTES)
        .await
        .map_err(|error| ApiError::with_status(StatusCode::PAYLOAD_TOO_LARGE, error.into()))?;
    let mut request = servers
        .client()
        .request(method, format!("http://127.0.0.1:{port}{path}"))
        .body(bytes);
    if let Some(content_type) = headers.get(header::CONTENT_TYPE) {
        request = request.header(header::CONTENT_TYPE, content_type);
    }
    let response = request
        .send()
        .await
        .map_err(|error| ApiError::internal(error.into()))?;
    let status = response.status();
    let content_type = response.headers().get(header::CONTENT_TYPE).cloned();
    let pathname = path.split('?').next().unwrap_or("");
    let html = content_type
        .as_ref()
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("text/html"));
    let prefix = format!("{PROXY_PATH}{id}/");
    let body = if html || pathname == EXTRA_TABS_SCRIPT {
        let source = read_text(response).await?;
        Body::from(if html {
            rewrite_html(&source, &prefix, port)
        } else {
            rewrite_script(&source, &prefix)
        })
    } else {
        Body::from_stream(response.bytes_stream())
    };
    let mut response = no_store((status, body));
    let headers = response.headers_mut();
    if let Some(content_type) = content_type {
        headers.insert(header::CONTENT_TYPE, content_type);
    }
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(CONTENT_SECURITY_POLICY),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    Ok(response)
}

async fn read_text(response: reqwest::Response) -> Result<String, ApiError> {
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| ApiError::internal(error.into()))?;
        if bytes.len() + chunk.len() > MAX_REWRITTEN_BYTES {
            return Err(ApiError::internal(anyhow!("tscircuit page is too large")));
        }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes)
        .context("tscircuit page encoding")
        .map_err(ApiError::internal)
}

fn upstream_path(path: &str) -> anyhow::Result<(String, String)> {
    let (id, suffix) = path
        .strip_prefix(PROXY_PATH)
        .and_then(|rest| rest.split_once('/'))
        .context("Invalid tscircuit path")?;
    let pathname = suffix.split('?').next().unwrap_or("");
    if id.is_empty()
        || !id.bytes().all(|byte| byte.is_ascii_hexdigit())
        || pathname.starts_with('/')
        || pathname.contains('\\')
        || pathname.contains("..")
        || pathname.contains('%')
    {
        anyhow::bail!("Invalid tscircuit path");
    }
    Ok((id.to_owned(), format!("/{suffix}")))
}

/// Points the page's API base URL and scripts at the proxy.
fn rewrite_html(source: &str, prefix: &str, port: u16) -> String {
    source
        .replace(
            &format!("\"http://127.0.0.1:{port}/"),
            &format!("\"{prefix}"),
        )
        .replace("src=\"/", &format!("src=\"{prefix}"))
}

fn rewrite_script(source: &str, prefix: &str) -> String {
    source.replace("\"/api/", &format!("\"{prefix}api/"))
}

#[cfg(test)]
mod tests;

#[cfg(all(test, unix))]
mod proxy_tests;
