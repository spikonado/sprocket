use std::sync::LazyLock;
use std::time::Duration;

use anyhow::{Context, anyhow};
use axum::Json;
use axum::body::Body;
use axum::extract::ws::{Message, WebSocket};
use axum::extract::{OriginalUri, State, WebSocketUpgrade};
use axum::http::{HeaderMap, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, post};
use axum_extra::extract::CookieJar;
use futures::{SinkExt, StreamExt};
use serde_json::Value;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

use crate::AppState;
use crate::auth::{cookie_request_is_csrf_safe, require_session};
use crate::routes::api_error::{ApiError, no_store};

const DASHBOARD_PATH: &str = "/api/browser/dashboard/";
const MAX_ASSET_BYTES: usize = 16 * 1024 * 1024;
const MAX_REQUEST_BYTES: usize = 2 * 1024 * 1024;
/// Hides the dashboard's non-Chrome browsers and AI chat. `tools/agent-browser/update-release.mjs`
/// refuses a pin whose bundle no longer contains every pattern.
static DASHBOARD_PATCHES: LazyLock<Vec<(String, String)>> = LazyLock::new(|| {
    serde_json::from_str(include_str!(
        "../../../../tools/agent-browser/dashboard-patches.json"
    ))
    .expect("valid dashboard patches")
});

pub fn routes() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/browser/start", post(start))
        .route("/browser/dashboard/", any(proxy))
        .route("/browser/dashboard/{*path}", any(proxy))
}

pub(crate) async fn user(
    state: &AppState,
    headers: &HeaderMap,
    jar: &CookieJar,
) -> Result<(String, String), ApiError> {
    let token = require_session(&state.auth, headers, jar)
        .await
        .map_err(ApiError::unauthorized)?;
    let session = state
        .host
        .native_auth
        .browser_session(false)
        .await
        .map_err(ApiError::unauthorized)?
        .ok_or_else(ApiError::authentication_required)?;
    state
        .auth
        .require_session_user(&token, &session.user.id)
        .await
        .map_err(ApiError::unauthorized)?;
    Ok((session.user.id, token))
}

fn require_same_origin(headers: &HeaderMap) -> Result<(), ApiError> {
    if !cookie_request_is_csrf_safe(headers) {
        return Err(ApiError::with_status(
            StatusCode::FORBIDDEN,
            anyhow!("Browser control requires a same-origin request"),
        ));
    }
    Ok(())
}

async fn start(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
) -> Result<Response, ApiError> {
    user(&state, &headers, &jar).await?;
    require_same_origin(&headers)?;
    Ok(no_store(Json(state.host.browsers.start())))
}

async fn proxy(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    method: Method,
    headers: HeaderMap,
    jar: CookieJar,
    websocket: Result<WebSocketUpgrade, axum::extract::ws::rejection::WebSocketUpgradeRejection>,
    body: Body,
) -> Result<Response, ApiError> {
    let (user_id, token) = user(&state, &headers, &jar).await?;
    let websocket = websocket.ok();
    if websocket.is_some() || !matches!(method, Method::GET | Method::HEAD) {
        require_same_origin(&headers)?;
    }
    let port = state
        .host
        .browsers
        .port()
        .map_err(|error| ApiError::with_status(StatusCode::SERVICE_UNAVAILABLE, error))?;
    let mut path = upstream_path(
        uri.path_and_query()
            .map(|value| value.as_str())
            .unwrap_or(""),
    )
    .map_err(ApiError::bad_request)?;
    let pathname = path.split('?').next().unwrap_or("").to_owned();
    if let Some(websocket) = websocket {
        if !pathname.starts_with("/api/session/") || !pathname.ends_with("/stream") {
            return Err(ApiError::bad_request(anyhow!(
                "Invalid dashboard stream path"
            )));
        }
        let mut request = format!("ws://127.0.0.1:{port}{path}")
            .into_client_request()
            .map_err(|error| ApiError::internal(error.into()))?;
        request.headers_mut().insert(
            "Origin",
            format!("http://127.0.0.1:{port}").parse().unwrap(),
        );
        let (upstream, _) = tokio::time::timeout(
            Duration::from_secs(10),
            tokio_tungstenite::connect_async(request),
        )
        .await
        .map_err(|_| ApiError::internal(anyhow!("Dashboard stream connection timed out")))?
        .map_err(|error| ApiError::internal(error.into()))?;
        return Ok(websocket
            .max_message_size(MAX_ASSET_BYTES)
            .on_upgrade(move |socket| relay(socket, upstream, state, user_id, token))
            .into_response());
    }

    let mut bytes = axum::body::to_bytes(body, MAX_REQUEST_BYTES)
        .await
        .map_err(|error| ApiError::bad_request(error.into()))?;
    // The pinned dashboard's session endpoint launches its child with dashboard mode still set.
    if method == Method::POST && pathname == "/api/sessions" {
        let payload: Value =
            serde_json::from_slice(&bytes).map_err(|error| ApiError::bad_request(error.into()))?;
        let session = payload
            .get("session")
            .and_then(Value::as_str)
            .ok_or_else(|| ApiError::bad_request(anyhow!("Missing browser session name")))?;
        bytes = serde_json::to_vec(
            &serde_json::json!({"args": ["open", "about:blank", "--session", session]}),
        )
        .map_err(|error| ApiError::internal(error.into()))?
        .into();
        path = "/api/exec".into();
    }
    let mut request = state
        .host
        .browsers
        .dashboard_client()
        .request(method, format!("http://127.0.0.1:{port}{path}"))
        .timeout(Duration::from_secs(30))
        .header(header::ORIGIN, format!("http://127.0.0.1:{port}"))
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
    let text_asset = content_type
        .as_ref()
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value.starts_with("text/html")
                || value.contains("javascript")
                || value.starts_with("text/css")
        });
    let body = if text_asset {
        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| ApiError::internal(error.into()))?;
            if bytes.len() + chunk.len() > MAX_ASSET_BYTES {
                return Err(ApiError::internal(anyhow!("Dashboard asset is too large")));
            }
            bytes.extend_from_slice(&chunk);
        }
        let source = String::from_utf8(bytes)
            .context("dashboard text asset encoding")
            .map_err(ApiError::internal)?;
        Body::from(rewrite_asset(&source))
    } else {
        Body::from_stream(response.bytes_stream())
    };
    let mut response = no_store((status, body));
    if let Some(content_type) = content_type {
        response
            .headers_mut()
            .insert(header::CONTENT_TYPE, content_type);
    }
    response
        .headers_mut()
        .insert("x-content-type-options", "nosniff".parse().unwrap());
    Ok(response)
}

fn upstream_path(path: &str) -> anyhow::Result<String> {
    let suffix = path
        .strip_prefix(DASHBOARD_PATH)
        .context("Invalid dashboard path")?;
    let pathname = suffix.split('?').next().unwrap_or("");
    if pathname.starts_with('/')
        || pathname.contains('\\')
        || pathname.contains("..")
        || pathname.contains('%')
    {
        anyhow::bail!("Invalid dashboard path");
    }
    Ok(format!("/{suffix}"))
}

fn rewrite_asset(source: &str) -> String {
    let source = DASHBOARD_PATCHES
        .iter()
        .fold(source.to_owned(), |source, (from, to)| {
            source.replace(from, to)
        });
    source
        .replace("/api/", &format!("{DASHBOARD_PATH}api/"))
        .replace("/_next/", &format!("{DASHBOARD_PATH}_next/"))
        .replace("/favicon.ico", &format!("{DASHBOARD_PATH}favicon.ico"))
}

async fn relay(
    browser: WebSocket,
    upstream: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    state: AppState,
    user_id: String,
    token: String,
) {
    use tokio_tungstenite::tungstenite::Message as UpstreamMessage;
    let (mut browser_tx, mut browser_rx) = browser.split();
    let (mut upstream_tx, mut upstream_rx) = upstream.split();
    let to_upstream = async {
        while let Some(Ok(message)) = browser_rx.next().await {
            let message = match message {
                Message::Text(value) => UpstreamMessage::Text(value.to_string().into()),
                Message::Binary(value) => UpstreamMessage::Binary(value),
                Message::Ping(value) => UpstreamMessage::Ping(value),
                Message::Pong(value) => UpstreamMessage::Pong(value),
                Message::Close(_) => break,
            };
            if upstream_tx.send(message).await.is_err() {
                break;
            }
        }
    };
    let to_browser = async {
        while let Some(Ok(message)) = upstream_rx.next().await {
            let message = match message {
                UpstreamMessage::Text(value) => Message::Text(value.to_string().into()),
                UpstreamMessage::Binary(value) => Message::Binary(value),
                UpstreamMessage::Ping(value) => Message::Ping(value),
                UpstreamMessage::Pong(value) => Message::Pong(value),
                UpstreamMessage::Close(_) => break,
                UpstreamMessage::Frame(_) => continue,
            };
            if browser_tx.send(message).await.is_err() {
                break;
            }
        }
    };
    let revoked = async {
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            if !stream_access(&state, &user_id, &token).await {
                break;
            }
        }
    };
    tokio::select! { _ = to_upstream => {}, _ = to_browser => {}, _ = revoked => {} }
}

async fn stream_access(state: &AppState, user_id: &str, token: &str) -> bool {
    state
        .auth
        .require_session_user(token, user_id)
        .await
        .is_ok()
        && state.host.native_auth.signed_in_as(user_id).await
}

#[cfg(test)]
mod tests;

#[cfg(all(test, unix))]
mod proxy_tests;
