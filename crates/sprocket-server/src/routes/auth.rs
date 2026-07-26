use std::net::SocketAddr;

use axum::Json;
use axum::extract::{ConnectInfo, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum_extra::extract::CookieJar;
use serde::Deserialize;

use crate::auth::{
    AuthSessionResponse, AuthState, BootstrapRequest, BootstrapResponse,
    DesktopLoginResultResponse, DesktopLoginStartResponse, extract_session_token,
    peer_may_complete_desktop_login_callback, require_session,
};
use crate::{AppState, PairingProofRequest, PairingProofResponse};

const DESKTOP_BOOTSTRAP_TOKEN_HEADER: &str = "x-sprocket-desktop-bootstrap-token";

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopBootstrapResponse {
    http_base_url: String,
    desktop_login_callback_url: String,
    pairing_credential: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopLoginStartRequest {
    state: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopLoginCancelRequest {
    state: String,
}

#[derive(Debug, Deserialize)]
struct DesktopLoginCallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

pub fn routes() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/auth/session", get(session))
        .route("/auth/bootstrap", post(bootstrap))
        .route("/auth/pairing-proof", post(pairing_proof))
        .route("/auth/desktop-bootstrap", get(desktop_bootstrap))
        .route("/auth/desktop-login/start", post(desktop_login_start))
        .route("/auth/desktop-login/callback", get(desktop_login_callback))
        .route("/auth/desktop-login/result", get(desktop_login_result))
        .route("/auth/desktop-login/cancel", post(desktop_login_cancel))
}

async fn session(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
) -> Json<AuthSessionResponse> {
    let token = extract_session_token(&headers, &jar);
    Json(state.auth.session_state(token.as_deref()).await)
}

async fn bootstrap(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(payload): Json<BootstrapRequest>,
) -> Result<(StatusCode, CookieJar, Json<BootstrapResponse>), ApiError> {
    let (response, session_token) = state
        .auth
        .bootstrap(&payload.credential)
        .await
        .map_err(ApiError::bad_request)?;

    let cookie = AuthState::make_session_cookie(&session_token);
    let mut jar = jar;
    jar = jar.add(cookie);

    Ok((StatusCode::OK, jar, Json(response)))
}

async fn pairing_proof(
    State(state): State<AppState>,
    Json(payload): Json<PairingProofRequest>,
) -> Result<Json<PairingProofResponse>, ApiError> {
    if payload.challenge.trim().is_empty() {
        return Err(ApiError::bad_request(anyhow::anyhow!(
            "pairing challenge must not be empty"
        )));
    }
    let message = crate::pairing_proof_message(
        &payload.challenge,
        &state.http_base_url,
        state.web_ui_enabled,
    );
    let proof = state
        .auth
        .pairing_proof(&message)
        .map_err(ApiError::bad_request)?;
    Ok(Json(PairingProofResponse {
        http_base_url: state.http_base_url.clone(),
        web_ui_enabled: state.web_ui_enabled,
        proof,
    }))
}

async fn desktop_bootstrap(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<DesktopBootstrapResponse>, ApiError> {
    let Some(desktop_bootstrap_token) = &state.desktop_bootstrap_token else {
        return Err(ApiError::unauthorized());
    };
    let Some(provided_token) = headers
        .get(DESKTOP_BOOTSTRAP_TOKEN_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Err(ApiError::unauthorized());
    };

    let mut expected_token = desktop_bootstrap_token.lock().await;
    if expected_token.as_deref() != Some(provided_token) {
        return Err(ApiError::unauthorized());
    }
    *expected_token = None;

    Ok(desktop_bootstrap_response(&state))
}

async fn desktop_login_start(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(payload): Json<DesktopLoginStartRequest>,
) -> Result<Json<DesktopLoginStartResponse>, ApiError> {
    let session_token = require_session(&state.auth, &headers, &jar)
        .await
        .map_err(|_| ApiError::unauthorized())?;

    if !state.loopback_desktop_login_supported {
        return Err(ApiError::bad_request(anyhow::anyhow!(
            "desktop browser sign-in requires the local server to accept 127.0.0.1 loopback connections; set SPROCKET_HOST to 127.0.0.1 or 0.0.0.0"
        )));
    }

    state
        .desktop_login
        .start(&session_token, &payload.state)
        .await
        .map_err(ApiError::bad_request)?;

    Ok(Json(DesktopLoginStartResponse { ok: true }))
}

async fn desktop_login_callback(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Query(query): Query<DesktopLoginCallbackQuery>,
) -> Response {
    if !peer_may_complete_desktop_login_callback(peer) {
        return desktop_login_html_response(
            StatusCode::FORBIDDEN,
            "Sign-in failed",
            "Desktop login callback is only available from this machine.",
        );
    }

    let callback_state = query
        .state
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());

    if let Some(error) = query
        .error
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let description = query
            .error_description
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("Sign-in was cancelled or failed.");
        let message = format!("{error}: {description}");

        if let Some(callback_state) = callback_state {
            if let Err(fail_error) = state
                .desktop_login
                .fail_callback(&message, callback_state)
                .await
            {
                return desktop_login_html_response(
                    StatusCode::BAD_REQUEST,
                    "Sign-in failed",
                    &fail_error.to_string(),
                );
            }
        }

        return desktop_login_html_response(StatusCode::BAD_REQUEST, "Sign-in failed", &message);
    }

    let Some(code) = query
        .code
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return desktop_login_html_response(
            StatusCode::BAD_REQUEST,
            "Sign-in failed",
            "Authorization code is missing.",
        );
    };
    let Some(callback_state) = callback_state else {
        return desktop_login_html_response(
            StatusCode::BAD_REQUEST,
            "Sign-in failed",
            "Desktop login state is missing.",
        );
    };

    match state
        .desktop_login
        .complete_callback(code, callback_state)
        .await
    {
        Ok(()) => desktop_login_html_response(
            StatusCode::OK,
            "Signed in",
            "Return to Sprocket. You can close this tab.",
        ),
        Err(error) => desktop_login_html_response(
            StatusCode::BAD_REQUEST,
            "Sign-in failed",
            &error.to_string(),
        ),
    }
}

async fn desktop_login_result(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
) -> Result<Json<DesktopLoginResultResponse>, ApiError> {
    let session_token = require_session(&state.auth, &headers, &jar)
        .await
        .map_err(|_| ApiError::unauthorized())?;

    Ok(Json(state.desktop_login.take_result(&session_token).await))
}

async fn desktop_login_cancel(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(payload): Json<DesktopLoginCancelRequest>,
) -> Result<Json<DesktopLoginStartResponse>, ApiError> {
    let session_token = require_session(&state.auth, &headers, &jar)
        .await
        .map_err(|_| ApiError::unauthorized())?;

    state
        .desktop_login
        .cancel(&session_token, &payload.state)
        .await;
    Ok(Json(DesktopLoginStartResponse { ok: true }))
}

fn desktop_bootstrap_response(state: &AppState) -> Json<DesktopBootstrapResponse> {
    Json(DesktopBootstrapResponse {
        http_base_url: state.http_base_url.clone(),
        desktop_login_callback_url: state.desktop_login_callback_url.clone(),
        pairing_credential: state.auth.pairing_credential().to_string(),
    })
}

fn desktop_login_html_response(status: StatusCode, title: &str, message: &str) -> Response {
    let title = html_escape(title);
    let message = html_escape(message);
    let body = format!(
        r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{title} — Sprocket</title>
  <style>
    :root {{ color-scheme: dark; }}
    body {{
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 2rem;
      box-sizing: border-box;
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif;
      background: #0f1218;
      color: #e2e8f0;
      text-align: center;
    }}
    h1 {{ margin: 0 0 0.75rem; font-size: 1.35rem; }}
    p {{ margin: 0; line-height: 1.55; color: #94a3b8; }}
  </style>
</head>
<body>
  <div>
    <h1>{title}</h1>
    <p>{message}</p>
  </div>
</body>
</html>"#
    );

    (
        status,
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        Html(body),
    )
        .into_response()
}

fn html_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn bad_request(error: anyhow::Error) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: error.to_string(),
        }
    }

    fn unauthorized() -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            message: "authentication required".to_string(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(serde_json::json!({ "error": self.message })),
        )
            .into_response()
    }
}

#[cfg(test)]
mod tests {
    use std::net::{IpAddr, Ipv4Addr, SocketAddr};

    use axum::body::Body;
    use axum::extract::ConnectInfo;
    use axum::http::{Request, header};
    use hmac::{KeyInit, Mac};
    use tower::ServiceExt;
    use uuid::Uuid;

    use super::*;
    use crate::auth::{self, DesktopLoginStore};
    use crate::workspace_sessions::WorkspaceSessionStore;

    async fn test_state(loopback_supported: bool) -> (AppState, String, String) {
        let temp_dir =
            std::env::temp_dir().join(format!("sprocket-auth-route-test-{}", Uuid::new_v4()));
        let auth = auth::AuthState::load(&temp_dir).expect("auth state");
        let credential = auth.pairing_credential().to_string();
        let (_, session_token) = auth.bootstrap(&credential).await.expect("bootstrap");

        let state = AppState {
            auth,
            command_sessions: crate::command_sessions::CommandSessionStore::default(),
            desktop_login: DesktopLoginStore::new(),
            workspace_sessions: WorkspaceSessionStore::new(temp_dir),
            http_base_url: "http://127.0.0.1:7731".to_string(),
            desktop_login_callback_url: auth::desktop_login_callback_url(7731),
            loopback_desktop_login_supported: loopback_supported,
            convex_deployment_url: "https://example.convex.cloud".to_string(),
            web_ui_enabled: true,
            desktop_bootstrap_token: None,
        };

        (state, session_token, credential)
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

    async fn read_text(response: axum::http::Response<Body>) -> String {
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        String::from_utf8(bytes.to_vec()).expect("utf8")
    }

    fn session_cookie(session_token: &str) -> String {
        format!("{}={session_token}", crate::SESSION_COOKIE_NAME)
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
        let mut mac = hmac::Hmac::<sha2::Sha256>::new_from_slice(credential.as_bytes()).unwrap();
        mac.update(message.as_bytes());
        mac.verify_slice(&proof).unwrap();
    }

    #[tokio::test]
    async fn provider_error_terminates_pending_attempt() {
        let (state, session_token, _) = test_state(true).await;
        let app = router(state);

        let start = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/auth/desktop-login/start")
                    .header(header::COOKIE, session_cookie(&session_token))
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"state":"nonce-1"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(start.status(), StatusCode::OK);

        let callback = app
            .clone()
            .oneshot(with_peer(
                Request::builder()
                    .uri("/api/auth/desktop-login/callback?error=access_denied&error_description=User%20cancelled&state=%7B%22nonce%22%3A%22nonce-1%22%7D")
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
    async fn concurrent_sessions_cannot_steal_results() {
        let (state, session_a, credential) = test_state(true).await;
        let (_, session_b) = state
            .auth
            .bootstrap(&credential)
            .await
            .expect("second session");
        let app = router(state);

        for (token, nonce) in [(&session_a, "nonce-a"), (&session_b, "nonce-b")] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/api/auth/desktop-login/start")
                        .header(header::COOKIE, session_cookie(token))
                        .header(header::CONTENT_TYPE, "application/json")
                        .body(Body::from(format!(r#"{{"state":"{nonce}"}}"#)))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
        }

        let callback = app
            .clone()
            .oneshot(with_peer(
                Request::builder()
                    .uri("/api/auth/desktop-login/callback?code=code-a&state=%7B%22nonce%22%3A%22nonce-a%22%7D")
                    .body(Body::empty())
                    .unwrap(),
                loopback_peer(),
            ))
            .await
            .unwrap();
        assert_eq!(callback.status(), StatusCode::OK);

        let stolen = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/auth/desktop-login/result")
                    .header(header::COOKIE, session_cookie(&session_b))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let stolen_payload = read_json(stolen).await;
        assert_eq!(stolen_payload["status"], "pending");

        let owned = app
            .oneshot(
                Request::builder()
                    .uri("/api/auth/desktop-login/result")
                    .header(header::COOKIE, session_cookie(&session_a))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let owned_payload = read_json(owned).await;
        assert_eq!(owned_payload["status"], "complete");
        assert_eq!(owned_payload["code"], "code-a");
    }

    #[tokio::test]
    async fn cancel_clears_pending_attempt() {
        let (state, session_token, _) = test_state(true).await;
        let app = router(state);

        let start = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/auth/desktop-login/start")
                    .header(header::COOKIE, session_cookie(&session_token))
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"state":"nonce-1"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(start.status(), StatusCode::OK);

        let cancel = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/auth/desktop-login/cancel")
                    .header(header::COOKIE, session_cookie(&session_token))
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"state":"nonce-1"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(cancel.status(), StatusCode::OK);

        let callback = app
            .oneshot(with_peer(
                Request::builder()
                    .uri("/api/auth/desktop-login/callback?code=auth-code&state=%7B%22nonce%22%3A%22nonce-1%22%7D")
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

        for nonce in ["nonce-old", "nonce-new"] {
            let start = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/api/auth/desktop-login/start")
                        .header(header::COOKIE, session_cookie(&session_token))
                        .header(header::CONTENT_TYPE, "application/json")
                        .body(Body::from(format!(r#"{{"state":"{nonce}"}}"#)))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(start.status(), StatusCode::OK);
        }

        let stale_cancel = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/auth/desktop-login/cancel")
                    .header(header::COOKIE, session_cookie(&session_token))
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"state":"nonce-old"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(stale_cancel.status(), StatusCode::OK);

        let callback = app
            .clone()
            .oneshot(with_peer(
                Request::builder()
                    .uri("/api/auth/desktop-login/callback?code=auth-code&state=%7B%22nonce%22%3A%22nonce-new%22%7D")
                    .body(Body::empty())
                    .unwrap(),
                loopback_peer(),
            ))
            .await
            .unwrap();
        assert_eq!(callback.status(), StatusCode::OK);

        let result = app
            .oneshot(
                Request::builder()
                    .uri("/api/auth/desktop-login/result")
                    .header(header::COOKIE, session_cookie(&session_token))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let payload = read_json(result).await;
        assert_eq!(payload["status"], "complete");
        assert_eq!(payload["code"], "auth-code");
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
                    .body(Body::from(r#"{"state":"nonce-1"}"#))
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
        let desktop_login = state.desktop_login.clone();
        let app = router(state);

        let start = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/auth/desktop-login/start")
                    .header(header::COOKIE, session_cookie(&session_token))
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"state":"nonce-1"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(start.status(), StatusCode::OK);

        desktop_login.expire_for_test(&session_token).await;

        let callback = app
            .clone()
            .oneshot(with_peer(
                Request::builder()
                    .uri("/api/auth/desktop-login/callback?code=auth-code&state=%7B%22nonce%22%3A%22nonce-1%22%7D")
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
    async fn loopback_peer_can_complete_callback() {
        let (state, session_token, _) = test_state(true).await;
        let app = router(state);

        let start = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/auth/desktop-login/start")
                    .header(header::COOKIE, session_cookie(&session_token))
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"state":"nonce-1"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(start.status(), StatusCode::OK);

        let callback = app
            .clone()
            .oneshot(with_peer(
                Request::builder()
                    .uri("/api/auth/desktop-login/callback?code=auth-code&state=%7B%22nonce%22%3A%22nonce-1%22%7D")
                    .body(Body::empty())
                    .unwrap(),
                loopback_peer(),
            ))
            .await
            .unwrap();
        assert_eq!(callback.status(), StatusCode::OK);

        let result = app
            .oneshot(
                Request::builder()
                    .uri("/api/auth/desktop-login/result")
                    .header(header::COOKIE, session_cookie(&session_token))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let payload = read_json(result).await;
        assert_eq!(payload["status"], "complete");
        assert_eq!(payload["code"], "auth-code");
    }

    #[tokio::test]
    async fn non_loopback_peer_cannot_complete_callback() {
        let (state, session_token, _) = test_state(true).await;
        let app = router(state);

        let start = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/auth/desktop-login/start")
                    .header(header::COOKIE, session_cookie(&session_token))
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"state":"nonce-1"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(start.status(), StatusCode::OK);

        let callback = app
            .clone()
            .oneshot(with_peer(
                Request::builder()
                    .uri("/api/auth/desktop-login/callback?code=attacker-code&state=%7B%22nonce%22%3A%22nonce-1%22%7D")
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
    async fn start_rejects_nonce_collision_across_sessions() {
        let (state, session_a, credential) = test_state(true).await;
        let (_, session_b) = state
            .auth
            .bootstrap(&credential)
            .await
            .expect("second session");
        let app = router(state);

        let first = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/auth/desktop-login/start")
                    .header(header::COOKIE, session_cookie(&session_a))
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"state":"shared-nonce"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(first.status(), StatusCode::OK);

        let collision = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/auth/desktop-login/start")
                    .header(header::COOKIE, session_cookie(&session_b))
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"state":"shared-nonce"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(collision.status(), StatusCode::BAD_REQUEST);
        let payload = read_json(collision).await;
        assert!(
            payload["error"]
                .as_str()
                .unwrap_or_default()
                .contains("already in use")
        );
    }
}
