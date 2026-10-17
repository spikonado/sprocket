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
    let native = sprocket_host::native_auth::NativeAuthManager::configured_for_test(
        sprocket_host::native_auth::NativeAuthConfig {
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
            sprocket_host::package_update::PackageUpdateManager::disabled(),
        ),
        token,
        directory,
    )
}

fn request(path: &str, token: Option<&str>, origin: Option<&str>, method: Method) -> Request<Body> {
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
        .host
        .browsers
        .use_test_dashboard("browser-user", port)
        .await;
    let browsers = Arc::clone(&state.host.browsers);
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
        .host
        .browsers
        .use_test_dashboard("browser-user", upstream_port)
        .await;
    let browsers = Arc::clone(&state.host.browsers);
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
        .host
        .browsers
        .use_test_dashboard("browser-user", port)
        .await;
    let browsers = Arc::clone(&state.host.browsers);
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
        .host
        .native_auth
        .authenticate_for_test("another-user")
        .await;
    assert!(!stream_access(&state, "browser-user", &token).await);
    state
        .host
        .native_auth
        .authenticate_for_test("browser-user")
        .await;
    state.host.native_auth.sign_out().await.unwrap();
    assert!(!stream_access(&state, "browser-user", &token).await);
}
