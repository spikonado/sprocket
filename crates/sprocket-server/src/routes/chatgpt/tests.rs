use axum::body::Body;
use axum::http::Request;
use tower::ServiceExt;

use super::*;

async fn fixture() -> (tempfile::TempDir, AppState, String) {
    let directory = tempfile::tempdir().unwrap();
    let auth = AuthState::load(directory.path()).unwrap();
    let (_, session) = auth.bootstrap_browser_session(true).await.unwrap();
    auth.bind_session_user(&session, "user-a").await.unwrap();
    let native_auth = sprocket_host::native_auth::NativeAuthManager::new(
        "https://example.convex.cloud".into(),
        "http://127.0.0.1:7731/auth/callback".into(),
        directory.path(),
        Some(Arc::clone(&auth) as Arc<dyn sprocket_host::native_auth::BrowserSessions>),
    );
    let state = AppState::for_test(
        auth,
        native_auth,
        directory.path().to_owned(),
        true,
        sprocket_host::package_update::PackageUpdateManager::from_env(),
    );
    (directory, state, session)
}

fn request(path: &str, session: &str, user: &str) -> Request<Body> {
    let mut request = Request::builder()
        .method("POST")
        .uri(path)
        .header(header::HOST, "127.0.0.1:7731")
        .header(header::ORIGIN, "http://127.0.0.1:7731")
        .header(
            header::COOKIE,
            format!("{}={session}", crate::SESSION_COOKIE_NAME),
        )
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::json!({"userId":user}).to_string()))
        .unwrap();
    request
        .extensions_mut()
        .insert(ConnectInfo("127.0.0.1:1234".parse::<SocketAddr>().unwrap()));
    request
}

#[tokio::test]
async fn local_status_is_account_scoped_and_reports_login_availability() {
    let (_directory, state, session) = fixture().await;
    let app = crate::build_router(state, None);
    let response = app
        .clone()
        .oneshot(request("/api/chatgpt/status", &session, "user-a"))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), 65536)
        .await
        .unwrap();
    let status: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
        status,
        serde_json::json!({
            "accounts":[], "activeConnectionId":null, "loginAvailable":true
        })
    );
    let response = app
        .oneshot(request("/api/chatgpt/status", &session, "user-b"))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn callback_records_failure_once_without_exposing_oauth_material() {
    let (_directory, state, session) = fixture().await;
    let pending = state.chatgpt_oauth;
    let value = secret();
    pending.logins.lock().await.attempts.insert(
        value.clone(),
        PendingLogin {
            session,
            user: "user-a".into(),
            connection: None,
            expires: Instant::now() + LOGIN_LIFETIME,
            nonce: secret(),
            verifier: secret(),
            redirect_uri: "http://127.0.0.1:1234/auth/callback".into(),
            processing: false,
            result: None,
        },
    );
    let query = || CallbackQuery {
        state: Some(value.clone()),
        code: None,
        client_id: None,
        error: Some("access_denied".into()),
    };
    let (status, headers, _) = callback(State(Arc::clone(&pending)), Query(query())).await;
    assert_eq!(status, StatusCode::OK);
    assert!(headers.contains(&(header::CACHE_CONTROL, "no-store")));
    let (status, _, _) = callback(State(Arc::clone(&pending)), Query(query())).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            let logins = pending.logins.lock().await;
            let login = logins.attempts.get(&value).unwrap();
            if let Some(Err(error)) = &login.result {
                assert_eq!(error, "ChatGPT sign-in was cancelled or failed.");
                assert!(login.verifier.is_empty());
                assert!(login.nonce.is_empty());
                break;
            }
            drop(logins);
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        serde_json::to_value(LoginResult::Complete).unwrap(),
        serde_json::json!({"status":"complete"})
    );
}

#[tokio::test]
async fn callback_listener_uses_an_available_loopback_port() {
    let (_directory, state, _) = fixture().await;
    let (redirect_uri, listener) = bind_callback(Arc::clone(&state.chatgpt_oauth))
        .await
        .unwrap();
    let url = url::Url::parse(&redirect_uri).unwrap();
    assert_eq!(url.host_str(), Some("127.0.0.1"));
    assert_eq!(url.path(), "/auth/callback");
    assert!(url.port().unwrap() > 0);
    let response = reqwest::get(redirect_uri).await.unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    listener.abort();
    let _ = listener.await;
}
