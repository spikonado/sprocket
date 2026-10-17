use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, header};
use tower::ServiceExt;
use uuid::Uuid;

use super::*;
use crate::auth;
use sprocket_host::package_update::PackageUpdateManager;

async fn test_state(package_updates: Arc<PackageUpdateManager>) -> (AppState, String) {
    let temp_dir = std::env::temp_dir().join(format!("sprocket-update-route-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&temp_dir).unwrap();
    let auth = auth::AuthState::load(&temp_dir).expect("auth state");
    let (_, session_token) = auth
        .bootstrap_browser_session(true)
        .await
        .expect("bootstrap");
    auth.bind_session_user(&session_token, "test-user")
        .await
        .unwrap();
    let native_auth = sprocket_host::native_auth::NativeAuthManager::configured_for_test(
        sprocket_host::native_auth::NativeAuthConfig {
            workos_client_id: "client_test".to_string(),
        },
        auth::desktop_login_callback_url(7731),
    );
    let state = AppState::for_test(auth, native_auth, temp_dir, true, package_updates);
    (state, session_token)
}

fn router(state: AppState) -> axum::Router {
    crate::build_router(state, None)
}

async fn read_json(response: axum::http::Response<Body>) -> serde_json::Value {
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    serde_json::from_slice(&bytes).expect("json")
}

fn session_cookie(session_token: &str) -> String {
    format!("{}={session_token}", crate::SESSION_COOKIE_NAME)
}

fn status_request(session_token: Option<&str>, origin: Option<&str>) -> Request<Body> {
    let mut request = Request::builder()
        .method("GET")
        .uri("/api/update")
        .header(header::HOST, "192.168.1.10:7731");
    if let Some(origin) = origin {
        request = request.header(header::ORIGIN, origin);
    }
    if let Some(session_token) = session_token {
        request = request.header(header::COOKIE, session_cookie(session_token));
    }
    request.body(Body::empty()).unwrap()
}

fn install_request(
    session_token: Option<&str>,
    origin: Option<&str>,
    body: &'static str,
) -> Request<Body> {
    let mut request = Request::builder()
        .method("POST")
        .uri("/api/update/install")
        .header(header::HOST, "127.0.0.1:7731")
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(origin) = origin {
        request = request.header(header::ORIGIN, origin);
    }
    if let Some(session_token) = session_token {
        request = request.header(header::COOKIE, session_cookie(session_token));
    }
    request.body(Body::from(body)).unwrap()
}

#[tokio::test]
async fn update_status_requires_session_and_rejects_hostile_origin() {
    let (state, session_token) = test_state(PackageUpdateManager::disabled()).await;
    let app = router(state);

    let unauthenticated = app
        .clone()
        .oneshot(status_request(None, Some("http://192.168.1.10:7731")))
        .await
        .unwrap();
    assert_eq!(unauthenticated.status(), StatusCode::UNAUTHORIZED);

    let missing_origin = app
        .clone()
        .oneshot(status_request(Some(&session_token), None))
        .await
        .unwrap();
    assert_eq!(missing_origin.status(), StatusCode::OK);
    assert_eq!(missing_origin.headers()[header::CACHE_CONTROL], "no-store");
    let payload = read_json(missing_origin).await;
    assert_eq!(payload["status"], "unavailable");
    assert_eq!(payload["method"], "package");

    let cross_origin = app
        .clone()
        .oneshot(status_request(
            Some(&session_token),
            Some("https://attacker.example"),
        ))
        .await
        .unwrap();
    assert_eq!(cross_origin.status(), StatusCode::UNAUTHORIZED);

    let ok = app
        .oneshot(status_request(
            Some(&session_token),
            Some("http://192.168.1.10:7731"),
        ))
        .await
        .unwrap();
    assert_eq!(ok.status(), StatusCode::OK);
    let payload = read_json(ok).await;
    assert_eq!(payload["status"], "unavailable");
}

#[tokio::test]
async fn install_requires_session_and_same_origin() {
    let (state, session_token) = test_state(PackageUpdateManager::disabled()).await;
    let app = router(state);

    let unauthenticated = app
        .clone()
        .oneshot(install_request(None, Some("http://127.0.0.1:7731"), "{}"))
        .await
        .unwrap();
    assert_eq!(unauthenticated.status(), StatusCode::UNAUTHORIZED);

    let missing_origin = app
        .clone()
        .oneshot(install_request(Some(&session_token), None, "{}"))
        .await
        .unwrap();
    assert_eq!(missing_origin.status(), StatusCode::FORBIDDEN);

    let cross_origin = app
        .clone()
        .oneshot(install_request(
            Some(&session_token),
            Some("https://attacker.example"),
            "{}",
        ))
        .await
        .unwrap();
    assert_eq!(cross_origin.status(), StatusCode::UNAUTHORIZED);

    let ok = app
        .oneshot(install_request(
            Some(&session_token),
            Some("http://127.0.0.1:7731"),
            "{}",
        ))
        .await
        .unwrap();
    assert_eq!(ok.status(), StatusCode::OK);
}
