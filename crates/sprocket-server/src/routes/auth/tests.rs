use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;

use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{Request, header};
use tower::ServiceExt;
use uuid::Uuid;

use super::*;
use crate::auth;

async fn test_state(loopback_supported: bool) -> (AppState, String, String) {
    let temp_dir =
        std::env::temp_dir().join(format!("sprocket-auth-route-test-{}", Uuid::new_v4()));
    let auth = auth::AuthState::load(&temp_dir).expect("auth state");
    let credential = auth.pairing_credential().to_string();
    let (_, session_token) = auth
        .bootstrap_browser_session(true)
        .await
        .expect("bootstrap");
    let native_auth = sprocket_host::native_auth::NativeAuthManager::configured_for_test(
        sprocket_host::native_auth::NativeAuthConfig {
            workos_client_id: "client_test".to_string(),
        },
        auth::desktop_login_callback_url(7731),
    );
    let state = AppState::for_test(
        auth,
        native_auth,
        temp_dir,
        loopback_supported,
        sprocket_host::package_update::PackageUpdateManager::disabled(),
    );
    (state, session_token, credential)
}

fn router(state: AppState) -> axum::Router {
    crate::build_router(state, None).layer(axum::middleware::from_fn(
        |mut request: Request<Body>, next: axum::middleware::Next| async move {
            if !request.headers().contains_key(header::HOST) {
                request
                    .headers_mut()
                    .insert(header::HOST, "127.0.0.1:7731".parse().unwrap());
            }
            if !request.headers().contains_key(header::ORIGIN) {
                request
                    .headers_mut()
                    .insert(header::ORIGIN, "http://127.0.0.1:7731".parse().unwrap());
            }
            if request
                .extensions()
                .get::<ConnectInfo<SocketAddr>>()
                .is_none()
            {
                request
                    .extensions_mut()
                    .insert(ConnectInfo(loopback_peer()));
            }
            next.run(request).await
        },
    ))
}

async fn read_json(response: axum::http::Response<Body>) -> serde_json::Value {
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    serde_json::from_slice(&bytes).expect("json")
}

async fn read_text(response: axum::http::Response<Body>) -> String {
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    String::from_utf8(bytes.to_vec()).expect("utf8")
}

fn session_cookie(session_token: &str) -> String {
    format!("{}={session_token}", crate::SESSION_COOKIE_NAME)
}

async fn start_login(app: &axum::Router, session_token: &str) -> (String, serde_json::Value) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/auth/desktop-login/start")
                .header(header::COOKIE, session_cookie(session_token))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"flow":"signIn"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let payload = read_json(response).await;
    let login_id = payload["loginId"].as_str().unwrap().to_string();
    (login_id, payload)
}

fn loopback_peer() -> SocketAddr {
    SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 54321)
}

fn lan_peer() -> SocketAddr {
    SocketAddr::new(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 50)), 54321)
}

fn with_peer(mut request: Request<Body>, peer: SocketAddr) -> Request<Body> {
    request.extensions_mut().insert(ConnectInfo(peer));
    request
}

fn native_token_request(session_token: Option<&str>, origin: &str) -> Request<Body> {
    let mut request = Request::builder()
        .method("POST")
        .uri("/api/auth/native-session/token")
        .header(header::HOST, "127.0.0.1:7731")
        .header(header::ORIGIN, origin)
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(session_token) = session_token {
        request = request.header(header::COOKIE, session_cookie(session_token));
    }
    request
        .body(Body::from(r#"{"forceRefreshToken":false}"#))
        .unwrap()
}

fn bootstrap_request(host: &str, origin: &str) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri("/api/auth/bootstrap")
        .header(header::HOST, host)
        .header(header::ORIGIN, origin)
        .body(Body::empty())
        .unwrap()
}

#[tokio::test]
async fn bootstrap_accepts_loopback_http_and_same_origin_https_only() {
    let (state, _, _) = test_state(true).await;
    let app = router(state);

    let accepted = app
        .clone()
        .oneshot(with_peer(
            bootstrap_request("127.0.0.1:7731", "http://127.0.0.1:7731"),
            loopback_peer(),
        ))
        .await
        .unwrap();
    assert_eq!(accepted.status(), StatusCode::OK);
    let local_cookie = accepted.headers()[header::SET_COOKIE].to_str().unwrap();
    assert!(!local_cookie.contains("Secure"));

    let https = app
        .clone()
        .oneshot(with_peer(
            bootstrap_request("machine.tailnet.ts.net", "https://machine.tailnet.ts.net"),
            loopback_peer(),
        ))
        .await
        .unwrap();
    assert_eq!(https.status(), StatusCode::OK);
    assert!(
        https.headers()[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .contains("Secure")
    );

    let localhost = app
        .clone()
        .oneshot(with_peer(
            bootstrap_request("localhost:7731", "http://localhost:7731"),
            loopback_peer(),
        ))
        .await
        .unwrap();
    assert_eq!(localhost.status(), StatusCode::OK);

    for (host, origin, peer) in [
        (
            "127.0.0.1:7731",
            "https://attacker.example",
            loopback_peer(),
        ),
        (
            "machine.local:7731",
            "http://machine.local:7731",
            loopback_peer(),
        ),
        ("127.0.0.1:7731", "http://127.0.0.1:7731", lan_peer()),
        (
            "machine.tailnet.ts.net",
            "https://machine.tailnet.ts.net",
            lan_peer(),
        ),
    ] {
        let response = app
            .clone()
            .oneshot(with_peer(bootstrap_request(host, origin), peer))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN, "{host} {origin}");
    }
}

#[tokio::test]
async fn unbound_remote_session_cannot_access_machine_routes() {
    let (state, _, _) = test_state(true).await;
    let auth = Arc::clone(&state.auth);
    let app = router(state);
    let bootstrap = app
        .clone()
        .oneshot(with_peer(
            bootstrap_request("machine.tailnet.ts.net", "https://machine.tailnet.ts.net"),
            loopback_peer(),
        ))
        .await
        .unwrap();
    let cookie = bootstrap.headers()[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string();
    let session_token = cookie.split_once('=').unwrap().1.to_string();

    let denied = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/workspace/projects")
                .header(header::COOKIE, &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);

    auth.bind_session_user(&session_token, "user-a")
        .await
        .unwrap();
    let accepted = app
        .oneshot(
            Request::builder()
                .uri("/api/workspace/projects")
                .header(header::COOKIE, cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(accepted.status(), StatusCode::OK);
}

#[tokio::test]
async fn unbound_remote_session_cannot_open_the_auth_event_stream() {
    let (state, _, _) = test_state(true).await;
    let (_, remote_session) = state
        .auth
        .bootstrap_browser_session(false)
        .await
        .expect("remote session");
    let app = router(state);

    let response = app
        .oneshot(with_peer(
            Request::builder()
                .uri("/api/auth/changes")
                .header(header::HOST, "machine.tailnet.ts.net")
                .header(header::ORIGIN, "https://machine.tailnet.ts.net")
                .header(header::COOKIE, session_cookie(&remote_session))
                .body(Body::empty())
                .unwrap(),
            loopback_peer(),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn remote_browser_can_revoke_itself_but_cannot_sign_out_the_host() {
    let (state, _, _) = test_state(true).await;
    state.host.native_auth.authenticate_for_test("user-a").await;
    let (_, remote_session) = state
        .auth
        .bootstrap_browser_session(false)
        .await
        .expect("remote session");
    state
        .auth
        .bind_session_user(&remote_session, "user-a")
        .await
        .unwrap();
    let auth = Arc::clone(&state.auth);
    let native_auth = Arc::clone(&state.host.native_auth);
    let app = router(state);

    let host_sign_out = app
        .clone()
        .oneshot(with_peer(
            Request::builder()
                .method("DELETE")
                .uri("/api/auth/native-session")
                .header(header::HOST, "machine.tailnet.ts.net")
                .header(header::ORIGIN, "https://machine.tailnet.ts.net")
                .header(header::COOKIE, session_cookie(&remote_session))
                .body(Body::empty())
                .unwrap(),
            loopback_peer(),
        ))
        .await
        .unwrap();
    assert_eq!(host_sign_out.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        native_auth
            .browser_session(false)
            .await
            .unwrap()
            .unwrap()
            .user
            .id,
        "user-a"
    );

    let browser_sign_out = app
        .oneshot(with_peer(
            Request::builder()
                .method("DELETE")
                .uri("/api/auth/session")
                .header(header::HOST, "machine.tailnet.ts.net")
                .header(header::ORIGIN, "https://machine.tailnet.ts.net")
                .header(header::COOKIE, session_cookie(&remote_session))
                .body(Body::empty())
                .unwrap(),
            loopback_peer(),
        ))
        .await
        .unwrap();
    assert_eq!(browser_sign_out.status(), StatusCode::OK);
    let expired = browser_sign_out.headers()[header::SET_COOKIE]
        .to_str()
        .unwrap();
    assert!(expired.contains("Secure"));
    assert!(
        !auth
            .session_state(Some(&remote_session))
            .await
            .authenticated
    );
    assert_eq!(
        native_auth
            .browser_session(false)
            .await
            .unwrap()
            .unwrap()
            .user
            .id,
        "user-a"
    );
}

#[tokio::test]
async fn login_error_preserves_credential_store_causes_and_escapes_html() {
    let error = anyhow::Error::new(keyring::Error::NoStorageAccess(
        std::io::Error::other("keyring <login> is locked & cannot be unlocked").into(),
    ))
    .context("failed to persist WorkOS refresh token");

    let response = desktop_login_error_response(StatusCode::BAD_REQUEST, &error);
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let html = read_text(response).await;
    assert!(html.contains("failed to persist WorkOS refresh token"));
    assert!(html.contains("keyring &lt;login&gt; is locked &amp; cannot be unlocked"));
    assert!(!html.contains("<login>"));
}

#[tokio::test]
async fn login_error_does_not_disclose_credential_bytes() {
    let secret = "private-refresh-token";
    let error = anyhow::Error::new(keyring::Error::BadEncoding(secret.as_bytes().to_vec()))
        .context("failed to load WorkOS refresh token");

    let response = desktop_login_error_response(StatusCode::BAD_REQUEST, &error);
    let html = read_text(response).await;
    assert!(html.contains("failed to load WorkOS refresh token"));
    assert!(html.contains("Password data is not valid UTF-8"));
    assert!(!html.contains(secret));
    assert!(!html.contains(&format!("{:?}", secret.as_bytes())));
}

#[tokio::test]
async fn login_error_keeps_provider_causes_private() {
    let error = anyhow::Error::new(workos::Error::Builder(
        "private-authorization-code".to_string(),
    ))
    .context("WorkOS authorization-code exchange failed");

    let response = desktop_login_error_response(StatusCode::BAD_REQUEST, &error);
    let html = read_text(response).await;
    assert!(html.contains("WorkOS authorization-code exchange failed"));
    assert!(!html.contains("private-authorization-code"));
}

#[tokio::test]
async fn native_token_requires_a_browser_session_and_does_not_cache_signed_out_response() {
    let (state, session_token, _) = test_state(true).await;
    let app = router(state);
    let unauthenticated = app
        .clone()
        .oneshot(with_peer(
            native_token_request(None, "http://127.0.0.1:7731"),
            loopback_peer(),
        ))
        .await
        .unwrap();
    assert_eq!(unauthenticated.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(unauthenticated.headers()[header::CACHE_CONTROL], "no-store");

    let signed_out = app
        .oneshot(with_peer(
            native_token_request(Some(&session_token), "http://127.0.0.1:7731"),
            loopback_peer(),
        ))
        .await
        .unwrap();
    assert_eq!(signed_out.status(), StatusCode::OK);
    assert_eq!(signed_out.headers()[header::CACHE_CONTROL], "no-store");
    assert!(read_json(signed_out).await.is_null());
}

#[tokio::test]
async fn native_token_rejects_cross_origin_and_plain_remote_http() {
    let (state, session_token, _) = test_state(true).await;
    let app = router(state);
    for origin in [
        "https://attacker.example",
        "http://127.0.0.1:8080",
        "null",
        "http://127.0.0.1:7731/",
    ] {
        let response = app
            .clone()
            .oneshot(with_peer(
                native_token_request(Some(&session_token), origin),
                loopback_peer(),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{origin}");
    }

    let mut request = native_token_request(Some(&session_token), "http://127.0.0.1:7731");
    request
        .headers_mut()
        .insert("x-forwarded-for", "127.0.0.1".parse().unwrap());
    let response = app.oneshot(with_peer(request, lan_peer())).await.unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn native_token_requires_a_sign_in_on_the_session_and_rejects_another_account() {
    let (state, session_token, _) = test_state(true).await;
    let auth = Arc::clone(&state.auth);
    let native_auth = Arc::clone(&state.host.native_auth);
    native_auth.authenticate_for_test("user-a").await;
    let app = router(state);
    let unbound = app
        .clone()
        .oneshot(with_peer(
            native_token_request(Some(&session_token), "http://127.0.0.1:7731"),
            loopback_peer(),
        ))
        .await
        .unwrap();
    assert_eq!(unbound.status(), StatusCode::OK);
    assert_eq!(read_json(unbound).await, serde_json::Value::Null);
    assert!(!auth.session_has_user(&session_token).await);

    auth.bind_session_user(&session_token, "user-a")
        .await
        .unwrap();
    let response = app
        .clone()
        .oneshot(with_peer(
            native_token_request(Some(&session_token), "http://127.0.0.1:7731"),
            loopback_peer(),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    let payload = read_json(response).await;
    assert_eq!(payload["accessToken"], "test-access-token");
    assert_eq!(payload["user"]["id"], "user-a");
    assert!(payload.get("refreshToken").is_none());

    native_auth.authenticate_for_test("user-b").await;
    let response = app
        .oneshot(with_peer(
            native_token_request(Some(&session_token), "http://127.0.0.1:7731"),
            loopback_peer(),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    assert!(read_json(response).await.get("accessToken").is_none());
    auth.require_session_user(&session_token, "user-a")
        .await
        .unwrap();
}

#[tokio::test]
async fn remote_native_token_is_empty_until_bound_to_the_matching_owner() {
    let (state, _, _) = test_state(true).await;
    state.host.native_auth.authenticate_for_test("user-a").await;
    let (_, remote_session) = state
        .auth
        .bootstrap_browser_session(false)
        .await
        .expect("remote session");
    let (_, foreign_session) = state
        .auth
        .bootstrap_browser_session(false)
        .await
        .expect("remote session");
    let auth = Arc::clone(&state.auth);
    let app = router(state);
    let request = |session_token: &str| {
        Request::builder()
            .method("POST")
            .uri("/api/auth/native-session/token")
            .header(header::HOST, "machine.tailnet.ts.net")
            .header(header::ORIGIN, "https://machine.tailnet.ts.net")
            .header(header::COOKIE, session_cookie(session_token))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(r#"{"forceRefreshToken":false}"#))
            .unwrap()
    };

    let unbound = app
        .clone()
        .oneshot(with_peer(request(&remote_session), loopback_peer()))
        .await
        .unwrap();
    assert_eq!(unbound.status(), StatusCode::OK);
    assert_eq!(read_json(unbound).await, serde_json::Value::Null);

    auth.bind_session_user(&remote_session, "user-a")
        .await
        .unwrap();
    let accepted = app
        .clone()
        .oneshot(with_peer(request(&remote_session), loopback_peer()))
        .await
        .unwrap();
    assert_eq!(accepted.status(), StatusCode::OK);
    assert_eq!(
        read_json(accepted).await["accessToken"],
        "test-access-token"
    );

    auth.bind_session_user(&foreign_session, "user-b")
        .await
        .unwrap();
    let mismatched = app
        .oneshot(with_peer(request(&foreign_session), loopback_peer()))
        .await
        .unwrap();
    assert_eq!(mismatched.status(), StatusCode::UNAUTHORIZED);
}

#[test]
fn browser_connection_rejects_missing_headers_and_plain_remote_http() {
    let mut headers = HeaderMap::new();
    assert_eq!(browser_connection(&headers, loopback_peer()), None);
    headers.insert(header::HOST, "localhost:5173".parse().unwrap());
    assert_eq!(browser_connection(&headers, loopback_peer()), None);
    headers.insert(header::ORIGIN, "http://localhost:5173".parse().unwrap());
    assert_eq!(
        browser_connection(&headers, loopback_peer()),
        Some(BrowserConnection::Loopback)
    );
    headers.insert(header::HOST, "[::1]:17731".parse().unwrap());
    headers.insert(header::ORIGIN, "http://[::1]:17731".parse().unwrap());
    assert_eq!(
        browser_connection(&headers, loopback_peer()),
        Some(BrowserConnection::Loopback)
    );
    headers.insert(header::HOST, "attacker.example:7731".parse().unwrap());
    headers.insert(
        header::ORIGIN,
        "http://attacker.example:7731".parse().unwrap(),
    );
    assert_eq!(browser_connection(&headers, loopback_peer()), None);
    headers.insert(
        header::ORIGIN,
        "https://attacker.example:7731".parse().unwrap(),
    );
    assert_eq!(browser_connection(&headers, lan_peer()), None);
    assert_eq!(
        browser_connection(&headers, loopback_peer()),
        Some(BrowserConnection::Https)
    );
}

#[tokio::test]
async fn pairing_proof_authenticates_the_running_server() {
    let (state, _, credential) = test_state(true).await;
    let app = router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/auth/pairing-proof")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"challenge":"challenge"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let payload = read_json(response).await;
    let proof: Vec<u8> = serde_json::from_value(payload["proof"].clone()).unwrap();
    let message = crate::pairing_proof_message(
        "challenge",
        payload["httpBaseUrl"].as_str().unwrap(),
        payload["webUiEnabled"].as_bool().unwrap(),
    );
    assert!(crate::auth::verify_pairing_proof(
        &credential,
        &message,
        &proof
    ));
}

#[tokio::test]
async fn provider_error_terminates_pending_attempt() {
    let (state, session_token, _) = test_state(true).await;
    let app = router(state);
    let (login_id, _) = start_login(&app, &session_token).await;

    let callback = app
        .clone()
        .oneshot(with_peer(
            Request::builder()
                .uri(format!("/api/auth/desktop-login/callback?error=access_denied&error_description=User%20cancelled&state={login_id}"))
                .body(Body::empty())
                .unwrap(),
            loopback_peer(),
        ))
        .await
        .unwrap();
    assert_eq!(callback.status(), StatusCode::BAD_REQUEST);
    let html = read_text(callback).await;
    assert!(html.contains("access_denied"));

    let result = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/auth/desktop-login/result")
                .header(header::COOKIE, session_cookie(&session_token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(result.status(), StatusCode::OK);
    let payload = read_json(result).await;
    assert_eq!(payload["status"], "failed");
    assert!(
        payload["error"]
            .as_str()
            .unwrap_or_default()
            .contains("access_denied")
    );
}

#[tokio::test]
async fn concurrent_sessions_have_independent_pending_attempts() {
    let (state, session_a, _) = test_state(true).await;
    let (_, session_b) = state
        .auth
        .bootstrap_browser_session(true)
        .await
        .expect("second session");
    let app = router(state);

    let (login_a, _) = start_login(&app, &session_a).await;
    let (login_b, _) = start_login(&app, &session_b).await;
    assert_ne!(login_a, login_b);

    let status_b = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/auth/desktop-login/result")
                .header(header::COOKIE, session_cookie(&session_b))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(read_json(status_b).await["status"], "pending");

    let status_a = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/auth/desktop-login/result")
                .header(header::COOKIE, session_cookie(&session_a))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(read_json(status_a).await["status"], "pending");
}

#[tokio::test]
async fn cancel_clears_pending_attempt() {
    let (state, session_token, _) = test_state(true).await;
    let app = router(state);

    let (login_id, _) = start_login(&app, &session_token).await;

    let cancel = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/auth/desktop-login/cancel")
                .header(header::COOKIE, session_cookie(&session_token))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(format!(r#"{{"loginId":"{login_id}"}}"#)))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(cancel.status(), StatusCode::OK);

    let callback = app
        .oneshot(with_peer(
            Request::builder()
                .uri(format!(
                    "/api/auth/desktop-login/callback?code=auth-code&state={login_id}"
                ))
                .body(Body::empty())
                .unwrap(),
            loopback_peer(),
        ))
        .await
        .unwrap();
    assert_eq!(callback.status(), StatusCode::BAD_REQUEST);
    let html = read_text(callback).await;
    assert!(html.contains("no pending desktop login attempt"));
}

#[tokio::test]
async fn stale_cancel_does_not_remove_replacement_attempt() {
    let (state, session_token, _) = test_state(true).await;
    let app = router(state);

    let (old_login_id, _) = start_login(&app, &session_token).await;
    let (new_login_id, _) = start_login(&app, &session_token).await;

    let stale_cancel = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/auth/desktop-login/cancel")
                .header(header::COOKIE, session_cookie(&session_token))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(format!(r#"{{"loginId":"{old_login_id}"}}"#)))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(stale_cancel.status(), StatusCode::OK);

    let result = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/auth/desktop-login/result")
                .header(header::COOKIE, session_cookie(&session_token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let payload = read_json(result).await;
    assert_eq!(payload["status"], "pending");

    let callback = app
        .oneshot(with_peer(
            Request::builder()
                .uri(format!(
                    "/api/auth/desktop-login/callback?error=access_denied&state={new_login_id}"
                ))
                .body(Body::empty())
                .unwrap(),
            loopback_peer(),
        ))
        .await
        .unwrap();
    assert_eq!(callback.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn start_rejects_incompatible_bind_host() {
    let (state, session_token, _) = test_state(false).await;
    let app = router(state);

    let start = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/auth/desktop-login/start")
                .header(header::COOKIE, session_cookie(&session_token))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"flow":"signIn"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(start.status(), StatusCode::BAD_REQUEST);
    let payload = read_json(start).await;
    assert!(
        payload["error"]
            .as_str()
            .unwrap_or_default()
            .contains("127.0.0.1")
    );
}

#[tokio::test]
async fn expired_attempt_cannot_complete() {
    let (state, session_token, _) = test_state(true).await;
    let native_auth = Arc::clone(&state.host.native_auth);
    let app = router(state);
    let (login_id, _) = start_login(&app, &session_token).await;
    native_auth.expire_login_for_test(&session_token).await;

    let callback = app
        .clone()
        .oneshot(with_peer(
            Request::builder()
                .uri(format!(
                    "/api/auth/desktop-login/callback?code=auth-code&state={login_id}"
                ))
                .body(Body::empty())
                .unwrap(),
            loopback_peer(),
        ))
        .await
        .unwrap();
    assert_eq!(callback.status(), StatusCode::BAD_REQUEST);

    let result = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/auth/desktop-login/result")
                .header(header::COOKIE, session_cookie(&session_token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let payload = read_json(result).await;
    assert_eq!(payload["status"], "signedOut");
}

#[tokio::test]
async fn non_loopback_peer_cannot_complete_callback() {
    let (state, session_token, _) = test_state(true).await;
    let app = router(state);
    let (login_id, _) = start_login(&app, &session_token).await;

    let callback = app
        .clone()
        .oneshot(with_peer(
            Request::builder()
                .uri(format!(
                    "/api/auth/desktop-login/callback?code=attacker-code&state={login_id}"
                ))
                .header("x-forwarded-for", "127.0.0.1")
                .header(header::HOST, "127.0.0.1:7731")
                .body(Body::empty())
                .unwrap(),
            lan_peer(),
        ))
        .await
        .unwrap();
    assert_eq!(callback.status(), StatusCode::FORBIDDEN);
    let html = read_text(callback).await;
    assert!(html.contains("only available from this machine"));

    let result = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/auth/desktop-login/result")
                .header(header::COOKIE, session_cookie(&session_token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let payload = read_json(result).await;
    assert_eq!(payload["status"], "pending");
}

#[tokio::test]
async fn start_generates_distinct_state_across_sessions() {
    let (state, session_a, _) = test_state(true).await;
    let (_, session_b) = state
        .auth
        .bootstrap_browser_session(true)
        .await
        .expect("second session");
    let app = router(state);

    let (login_a, payload_a) = start_login(&app, &session_a).await;
    let (login_b, payload_b) = start_login(&app, &session_b).await;

    assert_ne!(login_a, login_b);
    assert!(
        payload_a["authorizationUrl"]
            .as_str()
            .unwrap()
            .contains(&login_a)
    );
    assert!(
        payload_b["authorizationUrl"]
            .as_str()
            .unwrap()
            .contains(&login_b)
    );
}
