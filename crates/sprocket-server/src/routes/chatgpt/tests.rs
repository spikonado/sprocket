use std::net::SocketAddr;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{Request, StatusCode, header};
use tower::ServiceExt;

use super::*;

async fn fixture() -> (tempfile::TempDir, AppState, String) {
    let directory = tempfile::tempdir().unwrap();
    let auth = crate::auth::AuthState::load(directory.path()).unwrap();
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
