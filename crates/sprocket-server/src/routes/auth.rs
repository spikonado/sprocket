use std::net::SocketAddr;

use axum::Json;
use axum::extract::{ConnectInfo, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum_extra::extract::CookieJar;
use serde::Deserialize;

use crate::auth::{
    AuthSessionResponse, AuthState, BootstrapResponse, BrowserConnection,
    DesktopLoginStartResponse, browser_connection, extract_session_token,
    peer_may_complete_desktop_login_callback, require_bootstrap_session,
};
use crate::native_auth::{NativeLoginFlow, NativeLoginStart, NativeLoginStatus};
use crate::routes::api_error::ApiError;
use crate::{AppState, PairingProofRequest, PairingProofResponse};

const DESKTOP_BOOTSTRAP_TOKEN_HEADER: &str = "x-sprocket-desktop-bootstrap-token";

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopBootstrapResponse {
    http_base_url: String,
    desktop_login_callback_url: String,
    pairing_credential: &'static str,
}

#[derive(Debug, Deserialize)]
struct DesktopLoginCallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopLoginCancelRequest {
    login_id: String,
}

#[derive(Debug, Deserialize)]
struct DesktopLoginStartRequest {
    flow: Option<NativeLoginFlow>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeSessionTokenRequest {
    force_refresh_token: bool,
}

pub fn routes() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/auth/changes", get(session_changes))
        .route(
            "/auth/session",
            get(session).delete(browser_session_sign_out),
        )
        .route("/auth/bootstrap", post(bootstrap))
        .route("/auth/pairing-proof", post(pairing_proof))
        .route("/auth/desktop-bootstrap", get(desktop_bootstrap))
        .route("/auth/desktop-login/start", post(desktop_login_start))
        .route("/auth/desktop-login/callback", get(desktop_login_callback))
        .route(
            "/auth/desktop-login/result",
            get(desktop_login_result_legacy).post(desktop_login_result),
        )
        .route("/auth/desktop-login/cancel", post(desktop_login_cancel))
        .route(
            "/auth/native-session",
            axum::routing::delete(native_sign_out),
        )
        .route("/auth/native-session/token", post(native_session_token))
}

async fn session_changes(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
) -> Result<
    axum::response::Sse<
        impl futures::Stream<Item = Result<axum::response::sse::Event, std::convert::Infallible>>,
    >,
    ApiError,
> {
    let session_token = require_bootstrap_session(&state.auth, &headers, &jar)
        .await
        .map_err(ApiError::unauthorized)?;
    if !state.auth.session_is_local_browser(&session_token).await
        && !state.auth.session_has_user(&session_token).await
    {
        return Err(ApiError::authentication_required());
    }
    let receiver = state.native_auth.subscribe_changes();
    let shutdown = state.lifetime.shutdown.clone();
    let guard = state.lifetime.run_guard().map_err(ApiError::bad_request)?;
    let stream = futures::stream::unfold(
        (receiver, true, shutdown, guard),
        |(mut receiver, initial, shutdown, guard)| async move {
            if !initial {
                tokio::select! {
                    _ = shutdown.cancelled() => return None,
                    changed = receiver.changed() => if changed.is_err() { return None; },
                }
            }
            let generation = *receiver.borrow_and_update();
            Some((
                Ok(axum::response::sse::Event::default().data(generation.to_string())),
                (receiver, false, shutdown, guard),
            ))
        },
    );
    Ok(axum::response::Sse::new(stream).keep_alive(axum::response::sse::KeepAlive::default()))
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
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    jar: CookieJar,
) -> Result<(StatusCode, CookieJar, Json<BootstrapResponse>), ApiError> {
    let Some(connection) = browser_connection(&headers, peer) else {
        return Err(ApiError::with_status(
            StatusCode::FORBIDDEN,
            anyhow::anyhow!("browser access requires loopback HTTP or same-origin HTTPS"),
        ));
    };
    let (response, session_token) = state
        .auth
        .bootstrap_browser_session(connection == BrowserConnection::Loopback)
        .await
        .map_err(ApiError::bad_request)?;

    let cookie =
        AuthState::make_session_cookie(&session_token, connection == BrowserConnection::Https);
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
        return Err(ApiError::authentication_required());
    };
    let Some(provided_token) = headers
        .get(DESKTOP_BOOTSTRAP_TOKEN_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Err(ApiError::authentication_required());
    };

    let mut expected_token = desktop_bootstrap_token.lock().await;
    if expected_token.as_deref() != Some(provided_token) {
        return Err(ApiError::authentication_required());
    }
    *expected_token = None;

    Ok(desktop_bootstrap_response(&state))
}

async fn desktop_login_start(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(payload): Json<DesktopLoginStartRequest>,
) -> Result<Json<NativeLoginStart>, ApiError> {
    let (session_token, connection) = require_browser_session(&state, &headers, &jar, peer).await?;

    let login = match connection {
        BrowserConnection::Loopback => {
            if !state.loopback_desktop_login_supported {
                return Err(ApiError::bad_request(anyhow::anyhow!(
                    "browser sign-in requires the local server to accept 127.0.0.1 loopback connections; set SPROCKET_HOST to 127.0.0.1 or 0.0.0.0"
                )));
            }
            state
                .native_auth
                .start_login(
                    &session_token,
                    payload.flow.unwrap_or(NativeLoginFlow::SignIn),
                )
                .await
        }
        BrowserConnection::Https => {
            state
                .native_auth
                .start_remote_device_login(session_token)
                .await
        }
    }
    .map_err(ApiError::bad_request)?;

    Ok(Json(login))
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
            if let Err(fail_error) = state.native_auth.fail_login(callback_state, &message).await {
                return desktop_login_error_response(StatusCode::BAD_REQUEST, &fail_error);
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

    match state.native_auth.complete_login(code, callback_state).await {
        Ok((user, session_token)) => {
            if let Err(error) = state.auth.bind_session_user(&session_token, &user.id).await {
                return desktop_login_error_response(StatusCode::INTERNAL_SERVER_ERROR, &error);
            }
            desktop_login_html_response(
                StatusCode::OK,
                "Signed in",
                "Return to Sprocket. You can close this tab.",
            )
        }
        Err(error) => desktop_login_error_response(StatusCode::BAD_REQUEST, &error),
    }
}

async fn desktop_login_result(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    jar: CookieJar,
) -> Result<Json<NativeLoginStatus>, ApiError> {
    let (session_token, connection) = require_browser_session(&state, &headers, &jar, peer).await?;
    let status = match connection {
        BrowserConnection::Loopback => state.native_auth.status(&session_token).await,
        BrowserConnection::Https => state
            .native_auth
            .complete_remote_device_login(&session_token)
            .await
            .map_err(ApiError::internal)?,
    };
    if matches!(status, NativeLoginStatus::Authenticated { .. })
        && connection == BrowserConnection::Loopback
        && !state.auth.session_has_user(&session_token).await
    {
        return Ok(Json(NativeLoginStatus::SignedOut));
    }
    Ok(Json(status))
}

async fn desktop_login_result_legacy(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    jar: CookieJar,
) -> Result<Json<NativeLoginStatus>, ApiError> {
    let session_token = require_bootstrap_session(&state.auth, &headers, &jar)
        .await
        .map_err(|_| ApiError::authentication_required())?;
    if !peer.ip().is_loopback() || !state.auth.session_is_local_browser(&session_token).await {
        return Err(ApiError::with_status(
            StatusCode::FORBIDDEN,
            anyhow::anyhow!("legacy browser sign-in status is only available over loopback"),
        ));
    }
    Ok(Json(state.native_auth.status(&session_token).await))
}

async fn desktop_login_cancel(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(payload): Json<DesktopLoginCancelRequest>,
) -> Result<Json<DesktopLoginStartResponse>, ApiError> {
    let (session_token, connection) = require_browser_session(&state, &headers, &jar, peer).await?;
    match connection {
        BrowserConnection::Loopback => {
            state
                .native_auth
                .cancel_login(&session_token, payload.login_id.trim())
                .await;
        }
        BrowserConnection::Https => {
            let login_id = payload.login_id.trim();
            state
                .native_auth
                .cancel_remote_device_login(
                    &session_token,
                    (!login_id.is_empty()).then_some(login_id),
                )
                .await;
        }
    }
    Ok(Json(DesktopLoginStartResponse { ok: true }))
}

async fn native_sign_out(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    jar: CookieJar,
) -> Result<Json<DesktopLoginStartResponse>, ApiError> {
    let (_, connection) = require_browser_session(&state, &headers, &jar, peer).await?;
    if connection != BrowserConnection::Loopback {
        return Err(ApiError::with_status(
            StatusCode::FORBIDDEN,
            anyhow::anyhow!("host sign-out is only available from this machine"),
        ));
    }
    state
        .native_auth
        .sign_out()
        .await
        .map_err(|error| ApiError::internal_with("failed to clear native session", error))?;
    Ok(Json(DesktopLoginStartResponse { ok: true }))
}

async fn browser_session_sign_out(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    jar: CookieJar,
) -> Result<(CookieJar, Json<DesktopLoginStartResponse>), ApiError> {
    let (session_token, connection) = require_browser_session(&state, &headers, &jar, peer).await?;
    state.native_auth.cancel_device_login(&session_token).await;
    state
        .native_auth
        .cancel_remote_device_login(&session_token, None)
        .await;
    state
        .auth
        .end_session(&session_token)
        .await
        .map_err(ApiError::internal)?;
    let jar = jar.remove(AuthState::expire_session_cookie(
        connection == BrowserConnection::Https,
    ));
    Ok((jar, Json(DesktopLoginStartResponse { ok: true })))
}

async fn native_session_token(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(payload): Json<NativeSessionTokenRequest>,
) -> Response {
    let _activity = match state.lifetime.run_guard() {
        Ok(guard) => guard,
        Err(error) => return ApiError::bad_request(error).into_response(),
    };
    let result = native_session_token_response(&state, peer, &headers, &jar, payload).await;
    let mut response = result.into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
}

async fn native_session_token_response(
    state: &AppState,
    peer: SocketAddr,
    headers: &HeaderMap,
    jar: &CookieJar,
    payload: NativeSessionTokenRequest,
) -> Result<Json<Option<crate::native_auth::NativeBrowserSession>>, ApiError> {
    let (session_token, connection) = require_browser_session(state, headers, jar, peer).await?;
    if connection == BrowserConnection::Https && !state.auth.session_has_user(&session_token).await
    {
        return Err(ApiError::authentication_required());
    }
    let session = state
        .native_auth
        .browser_session(payload.force_refresh_token)
        .await
        .map_err(|error| {
            tracing::warn!("native browser session unavailable: {error:#}");
            ApiError::with_status(
                StatusCode::SERVICE_UNAVAILABLE,
                anyhow::anyhow!("Native sign-in is temporarily unavailable. Try again."),
            )
        })?;
    if let Some(session) = &session {
        if connection == BrowserConnection::Https {
            state
                .auth
                .require_session_user(&session_token, &session.user.id)
                .await
                .map_err(|_| ApiError::authentication_required())?;
        } else if state.auth.session_has_user(&session_token).await {
            state
                .auth
                .require_session_user(&session_token, &session.user.id)
                .await
                .map_err(|error| ApiError::with_status(StatusCode::CONFLICT, error))?;
        } else {
            state
                .auth
                .bind_session_user(&session_token, &session.user.id)
                .await
                .map_err(ApiError::internal)?;
        }
    }
    Ok(Json(session))
}

async fn session_browser_connection(
    state: &AppState,
    headers: &HeaderMap,
    peer: SocketAddr,
    session_token: &str,
) -> Result<BrowserConnection, ApiError> {
    let connection = browser_connection(headers, peer).ok_or_else(|| {
        ApiError::with_status(
            StatusCode::FORBIDDEN,
            anyhow::anyhow!("browser access requires loopback HTTP or same-origin HTTPS"),
        )
    })?;
    let local_session = state.auth.session_is_local_browser(session_token).await;
    if local_session != (connection == BrowserConnection::Loopback) {
        return Err(ApiError::authentication_required());
    }
    Ok(connection)
}

async fn require_browser_session(
    state: &AppState,
    headers: &HeaderMap,
    jar: &CookieJar,
    peer: SocketAddr,
) -> Result<(String, BrowserConnection), ApiError> {
    let session_token = require_bootstrap_session(&state.auth, headers, jar)
        .await
        .map_err(|_| ApiError::authentication_required())?;
    let connection = session_browser_connection(state, headers, peer, &session_token).await?;
    Ok((session_token, connection))
}

fn desktop_bootstrap_response(state: &AppState) -> Json<DesktopBootstrapResponse> {
    Json(DesktopBootstrapResponse {
        http_base_url: state.http_base_url.clone(),
        desktop_login_callback_url: state.desktop_login_callback_url.clone(),
        pairing_credential: "not-required",
    })
}

fn desktop_login_error_response(status: StatusCode, error: &anyhow::Error) -> Response {
    // Provider error causes can contain response bodies. Only expand credential-store errors.
    let message = if error.downcast_ref::<keyring::Error>().is_some() {
        format!("{error:#}")
    } else {
        error.to_string()
    };
    desktop_login_html_response(status, "Sign-in failed", &message)
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

#[cfg(test)]
mod tests {
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
        let native_auth = crate::native_auth::NativeAuthManager::configured_for_test(
            crate::native_auth::NativeAuthConfig {
                workos_client_id: "client_test".to_string(),
            },
            auth::desktop_login_callback_url(7731),
        );
        let state = AppState::for_test(
            auth,
            native_auth,
            temp_dir,
            loopback_supported,
            crate::package_update::PackageUpdateManager::disabled(),
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
                lan_peer(),
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
                lan_peer(),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn remote_browser_can_revoke_itself_but_cannot_sign_out_the_host() {
        let (state, _, _) = test_state(true).await;
        state.native_auth.authenticate_for_test("user-a").await;
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
        let native_auth = Arc::clone(&state.native_auth);
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
                lan_peer(),
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
                lan_peer(),
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
    async fn native_token_binds_a_resumed_session_but_rejects_another_account() {
        let (state, session_token, _) = test_state(true).await;
        let auth = Arc::clone(&state.auth);
        let native_auth = Arc::clone(&state.native_auth);
        native_auth.authenticate_for_test("user-a").await;
        let app = router(state);
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
        auth.require_session_user(&session_token, "user-a")
            .await
            .unwrap();

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
    async fn remote_native_token_requires_a_matching_bound_owner() {
        let (state, _, _) = test_state(true).await;
        state.native_auth.authenticate_for_test("user-a").await;
        let (_, remote_session) = state
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
            .oneshot(with_peer(request(&remote_session), lan_peer()))
            .await
            .unwrap();
        assert_eq!(unbound.status(), StatusCode::UNAUTHORIZED);

        auth.bind_session_user(&remote_session, "user-a")
            .await
            .unwrap();
        let accepted = app
            .clone()
            .oneshot(with_peer(request(&remote_session), lan_peer()))
            .await
            .unwrap();
        assert_eq!(accepted.status(), StatusCode::OK);
        assert_eq!(
            read_json(accepted).await["accessToken"],
            "test-access-token"
        );

        auth.bind_session_user(&remote_session, "user-b")
            .await
            .unwrap();
        let mismatched = app
            .oneshot(with_peer(request(&remote_session), lan_peer()))
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
        assert_eq!(
            browser_connection(&headers, lan_peer()),
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
    async fn desktop_bootstrap_keeps_a_non_secret_legacy_pairing_field() {
        let (mut state, _, credential) = test_state(true).await;
        state.desktop_bootstrap_token = Some(Arc::new(tokio::sync::Mutex::new(Some(
            "one-time-token".to_string(),
        ))));
        let app = router(state);

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/auth/desktop-bootstrap")
                    .header(DESKTOP_BOOTSTRAP_TOKEN_HEADER, "one-time-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let payload = read_json(response).await;
        assert_eq!(payload["pairingCredential"], "not-required");
        assert_ne!(payload["pairingCredential"], credential);
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
        let native_auth = Arc::clone(&state.native_auth);
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
}
