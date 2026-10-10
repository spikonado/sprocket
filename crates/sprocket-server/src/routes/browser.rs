use std::time::Duration;

use anyhow::{Context, anyhow};
use axum::Json;
use axum::body::Body;
use axum::extract::ws::{Message, WebSocket};
use axum::extract::{OriginalUri, State, WebSocketUpgrade};
use axum::http::{HeaderMap, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get, post};
use axum_extra::extract::CookieJar;
use futures::{SinkExt, StreamExt};
use serde_json::Value;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

use crate::AppState;
use crate::auth::{cookie_request_is_csrf_safe, require_session};
use crate::browser::DASHBOARD_PATH;
use crate::routes::api_error::{ApiError, no_store};

const MAX_ASSET_BYTES: usize = 16 * 1024 * 1024;
const MAX_REQUEST_BYTES: usize = 2 * 1024 * 1024;

pub fn routes() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/browser/status", get(status))
        .route("/browser/start", post(start))
        .route("/browser/dashboard/", any(proxy))
        .route("/browser/dashboard/{*path}", any(proxy))
}

async fn user(
    state: &AppState,
    headers: &HeaderMap,
    jar: &CookieJar,
) -> Result<(String, String), ApiError> {
    let token = require_session(&state.auth, headers, jar)
        .await
        .map_err(ApiError::unauthorized)?;
    let session = state
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

async fn status(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
) -> Result<Response, ApiError> {
    let (user_id, _) = user(&state, &headers, &jar).await?;
    Ok(no_store(Json(state.browsers.status(&user_id).await)))
}

async fn start(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
) -> Result<Response, ApiError> {
    let (user_id, _) = user(&state, &headers, &jar).await?;
    require_same_origin(&headers)?;
    Ok(no_store(Json(state.browsers.start(&user_id).await)))
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
        .browsers
        .port(&user_id)
        .await
        .map_err(|error| ApiError::with_status(StatusCode::SERVICE_UNAVAILABLE, error))?;
    let mut path = upstream_path(
        uri.path_and_query()
            .map(|value| value.as_str())
            .unwrap_or(""),
    )
    .map_err(ApiError::bad_request)?;
    if let Some(websocket) = websocket {
        if !path.starts_with("/api/session/")
            || !path
                .split('?')
                .next()
                .is_some_and(|path| path.ends_with("/stream"))
        {
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

    let client = reqwest::Client::builder()
        .no_proxy()
        .retry(reqwest::retry::never())
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| ApiError::internal(error.into()))?;
    let mut bytes = axum::body::to_bytes(body, MAX_REQUEST_BYTES)
        .await
        .map_err(|error| ApiError::bad_request(error.into()))?;
    if method == Method::POST
        && matches!(path.split('?').next(), Some("/api/sessions" | "/api/exec"))
    {
        let mut payload: Value =
            serde_json::from_slice(&bytes).map_err(|error| ApiError::bad_request(error.into()))?;
        if path.split('?').next() == Some("/api/sessions") {
            let session = payload
                .get("session")
                .and_then(Value::as_str)
                .ok_or_else(|| ApiError::bad_request(anyhow!("Missing browser session name")))?;
            payload = serde_json::json!({"args": ["open", "about:blank", "--session", session]});
            path = "/api/exec".into();
        }
        if let Some(args) = payload.get_mut("args").and_then(Value::as_array_mut)
            && args
                .windows(2)
                .any(|pair| pair[0] == "--engine" && pair[1] == "lightpanda")
        {
            let executable = state
                .browsers
                .install_lightpanda()
                .await
                .map_err(ApiError::internal)?;
            args.extend([
                Value::String("--executable-path".into()),
                Value::String(executable.to_string_lossy().into_owned()),
            ]);
        }
        bytes = serde_json::to_vec(&payload)
            .map_err(|error| ApiError::internal(error.into()))?
            .into();
    }
    let mut request = client
        .request(method, format!("http://127.0.0.1:{port}{path}"))
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
            if !stream_access(&state, &user_id, &token).await {
                break;
            }
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
            if !stream_access(&state, &user_id, &token).await {
                break;
            }
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
        && state.native_auth.signed_in_as(user_id).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adapts_dashboard_assets_and_dynamic_stream_paths() {
        let source = r#"<script src="/_next/static/app.js"></script>fetch("/api/sessions");let path=`/api/session/${port}/stream`;"#;
        assert_eq!(
            rewrite_asset(source),
            r#"<script src="/api/browser/dashboard/_next/static/app.js"></script>fetch("/api/browser/dashboard/api/sessions");let path=`/api/browser/dashboard/api/session/${port}/stream`;"#
        );
        assert_eq!(
            upstream_path("/api/browser/dashboard/api/session/123/stream?maxFps=10").unwrap(),
            "/api/session/123/stream?maxFps=10"
        );
        assert_eq!(
            upstream_path("/api/browser/dashboard/api/sessions?name=a%20b").unwrap(),
            "/api/sessions?name=a%20b"
        );
    }

    #[test]
    fn dashboard_cannot_select_another_upstream() {
        for path in [
            "/api/browser/dashboard//example.com",
            "/api/browser/dashboard/../auth",
            "/api/browser/dashboard/%2f%2fexample.com",
            "/api/auth",
        ] {
            assert!(upstream_path(path).is_err());
        }
    }
}

#[cfg(all(test, unix))]
mod proxy_tests {
    use super::*;
    use axum::http::Request;
    use std::sync::Arc;
    use tower::ServiceExt;

    async fn state() -> (AppState, String, tempfile::TempDir) {
        let directory = tempfile::tempdir().unwrap();
        let auth = crate::auth::AuthState::load(directory.path()).unwrap();
        let (_, token) = auth.bootstrap_browser_session(true).await.unwrap();
        auth.bind_session_user(&token, "browser-user")
            .await
            .unwrap();
        let native = crate::native_auth::NativeAuthManager::configured_for_test(
            crate::native_auth::NativeAuthConfig {
                workos_client_id: "client_test".into(),
            },
            crate::auth::desktop_login_callback_url(7731),
        );
        native.authenticate_for_test("browser-user").await;
        (
            AppState::for_test(
                auth,
                native,
                directory.path().into(),
                true,
                crate::package_update::PackageUpdateManager::disabled(),
            ),
            token,
            directory,
        )
    }

    fn request(
        path: &str,
        token: Option<&str>,
        origin: Option<&str>,
        method: Method,
    ) -> Request<Body> {
        let mut request = Request::builder()
            .uri(path)
            .method(method)
            .header(header::HOST, "127.0.0.1:7731");
        if let Some(token) = token {
            request = request.header(
                header::COOKIE,
                format!("{}={token}", crate::SESSION_COOKIE_NAME),
            );
        }
        if let Some(origin) = origin {
            request = request.header(header::ORIGIN, origin);
        }
        request.body(Body::empty()).unwrap()
    }

    #[tokio::test]
    async fn browser_endpoints_require_authentication_and_mutations_require_same_origin() {
        let (state, token, _directory) = state().await;
        let app = crate::build_router(state, None);
        for path in [
            "/api/browser/status",
            "/api/browser/dashboard/",
            "/api/browser/dashboard/api/sessions",
        ] {
            let response = app
                .clone()
                .oneshot(request(path, None, None, Method::GET))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }
        let response = app
            .clone()
            .oneshot(request(
                "/api/browser/start",
                Some(&token),
                None,
                Method::POST,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let response = app
            .clone()
            .oneshot(request(
                "/api/browser/dashboard/api/exec",
                Some(&token),
                Some("https://attacker.example"),
                Method::POST,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let response = app
            .oneshot(request(
                "/api/browser/status",
                Some(&token),
                None,
                Method::GET,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    }

    #[tokio::test]
    async fn forwards_only_dashboard_traffic_and_rewrites_assets_without_forwarding_credentials() {
        let (state, token, _directory) = state().await;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let upstream = axum::Router::new().route(
            "/",
            get(|headers: HeaderMap| async move {
                assert!(!headers.contains_key(header::COOKIE));
                assert!(!headers.contains_key(header::AUTHORIZATION));
                assert!(
                    headers[header::ORIGIN]
                        .to_str()
                        .unwrap()
                        .starts_with("http://127.0.0.1:")
                );
                (
                    [(header::CONTENT_TYPE, "text/html")],
                    r#"<script src="/_next/static/app.js"></script>fetch("/api/sessions")"#,
                )
            }),
        );
        let task = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
        state
            .browsers
            .use_test_dashboard("browser-user", port)
            .await;
        let browsers = Arc::clone(&state.browsers);
        let response = crate::build_router(state, None)
            .oneshot(request(
                "/api/browser/dashboard/",
                Some(&token),
                None,
                Method::GET,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), 1024)
            .await
            .unwrap();
        assert_eq!(&bytes[..], br#"<script src="/api/browser/dashboard/_next/static/app.js"></script>fetch("/api/browser/dashboard/api/sessions")"#);
        browsers.shutdown().await;
        task.abort();
    }

    #[tokio::test]
    async fn streams_live_frames_and_browser_input_through_authenticated_websocket() {
        use tokio_tungstenite::tungstenite::Message as UpstreamMessage;

        let (state, token, _directory) = state().await;
        let upstream_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_port = upstream_listener.local_addr().unwrap().port();
        let upstream = axum::Router::new().route(
            "/api/session/123/stream",
            get(|headers: HeaderMap, socket: WebSocketUpgrade| async move {
                assert!(!headers.contains_key(header::COOKIE));
                socket.on_upgrade(|mut socket| async move {
                    socket
                        .send(Message::Binary(vec![1, 2, 3].into()))
                        .await
                        .unwrap();
                    while let Some(Ok(input)) = socket.recv().await {
                        if socket.send(input).await.is_err() {
                            break;
                        }
                    }
                })
            }),
        );
        let upstream_task =
            tokio::spawn(async move { axum::serve(upstream_listener, upstream).await.unwrap() });
        state
            .browsers
            .use_test_dashboard("browser-user", upstream_port)
            .await;
        let browsers = Arc::clone(&state.browsers);
        let auth = Arc::clone(&state.auth);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = crate::build_router(state, None);
        let task = tokio::spawn(async move {
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .await
            .unwrap()
        });
        let url = format!("ws://{address}/api/browser/dashboard/api/session/123/stream");
        let mut request = url.into_client_request().unwrap();
        request.headers_mut().insert(
            header::COOKIE,
            format!("{}={token}", crate::SESSION_COOKIE_NAME)
                .parse()
                .unwrap(),
        );
        request
            .headers_mut()
            .insert(header::ORIGIN, format!("http://{address}").parse().unwrap());
        let (mut socket, _) = tokio_tungstenite::connect_async(request.clone())
            .await
            .unwrap();
        assert_eq!(
            socket.next().await.unwrap().unwrap(),
            UpstreamMessage::Binary(vec![1, 2, 3].into())
        );
        socket
            .send(UpstreamMessage::Text("pointer-input".into()))
            .await
            .unwrap();
        assert_eq!(
            socket.next().await.unwrap().unwrap(),
            UpstreamMessage::Text("pointer-input".into())
        );
        auth.end_session(&token).await.unwrap();
        let ended = tokio::time::timeout(Duration::from_secs(3), socket.next())
            .await
            .unwrap();
        assert!(matches!(
            ended,
            None | Some(Err(_)) | Some(Ok(UpstreamMessage::Close(_)))
        ));
        request.headers_mut().remove(header::COOKIE);
        assert!(
            matches!(tokio_tungstenite::connect_async(request).await, Err(tokio_tungstenite::tungstenite::Error::Http(response)) if response.status() == StatusCode::UNAUTHORIZED)
        );
        browsers.shutdown().await;
        task.abort();
        upstream_task.abort();
    }

    #[tokio::test]
    async fn translates_session_creation_and_preserves_upstream_result() {
        let (state, token, _directory) = state().await;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let upstream = axum::Router::new().route(
            "/api/exec",
            post(|Json(payload): Json<Value>| async move {
                assert_eq!(
                    payload,
                    serde_json::json!({"args":["open","about:blank","--session","created-session"]})
                );
                Json(serde_json::json!({"success":true,"stdout":"created","exit_code":0}))
            }),
        );
        let task = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
        state
            .browsers
            .use_test_dashboard("browser-user", port)
            .await;
        let browsers = Arc::clone(&state.browsers);
        let mut request = request(
            "/api/browser/dashboard/api/sessions",
            Some(&token),
            Some("http://127.0.0.1:7731"),
            Method::POST,
        );
        request
            .headers_mut()
            .insert(header::CONTENT_TYPE, "application/json".parse().unwrap());
        *request.body_mut() = Body::from(r#"{"session":"created-session"}"#);
        let response = crate::build_router(state, None)
            .oneshot(request)
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), 1024)
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&bytes).unwrap(),
            serde_json::json!({"success":true,"stdout":"created","exit_code":0})
        );
        browsers.shutdown().await;
        task.abort();
    }

    #[tokio::test]
    async fn stream_access_tracks_native_sign_out_and_user_changes() {
        let (state, token, _directory) = state().await;
        assert!(stream_access(&state, "browser-user", &token).await);
        state
            .native_auth
            .authenticate_for_test("another-user")
            .await;
        assert!(!stream_access(&state, "browser-user", &token).await);
        state
            .native_auth
            .authenticate_for_test("browser-user")
            .await;
        state.native_auth.sign_out().await.unwrap();
        assert!(!stream_access(&state, "browser-user", &token).await);
    }
}
