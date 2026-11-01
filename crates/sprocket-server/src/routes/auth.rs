use std::net::SocketAddr;

use axum::Json;
use axum::body::Bytes;
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
use crate::routes::api_error::{ApiError, no_store};
use crate::{AppState, PairingProofRequest, PairingProofResponse};
use sprocket_host::native_auth::{
    CredentialStore, NativeLoginFlow, NativeLoginStart, NativeLoginStatus,
    UNENCRYPTED_CREDENTIALS_NOTICE,
};

const DESKTOP_BOOTSTRAP_TOKEN_HEADER: &str = "x-sprocket-desktop-bootstrap-token";

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopBootstrapResponse {
    http_base_url: String,
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
        .route(
            "/auth/session",
            get(session).delete(browser_session_sign_out),
        )
        .route("/auth/bootstrap", post(bootstrap))
        .route("/auth/pairing-proof", post(pairing_proof))
        .route("/auth/desktop-bootstrap", get(desktop_bootstrap))
        .route("/auth/desktop-login/start", post(desktop_login_start))
        .route("/auth/desktop-login/callback", get(desktop_login_callback))
        .route("/auth/desktop-login/result", post(desktop_login_result))
        .route("/auth/desktop-login/cancel", post(desktop_login_cancel))
        .route(
            "/auth/native-session",
            axum::routing::delete(native_sign_out),
        )
        .route("/auth/native-session/token", post(native_session_token))
}

pub(crate) async fn authorize_session_changes(
    state: &AppState,
    headers: &HeaderMap,
    jar: &CookieJar,
) -> Result<(), ApiError> {
    let session_token = require_bootstrap_session(&state.auth, headers, jar)
        .await
        .map_err(ApiError::unauthorized)?;
    if !state.auth.session_is_local_browser(&session_token).await
        && !state.auth.session_has_user(&session_token).await
    {
        return Err(ApiError::authentication_required());
    }
    Ok(())
}

/// Emits the current auth generation, then each change. Holding the stream keeps
/// an idle CLI-started server running while a browser is open. Callers must run
/// `authorize_session_changes` first.
pub(crate) fn session_change_events(
    state: &AppState,
) -> Result<futures::stream::BoxStream<'static, u64>, ApiError> {
    let mut receiver = state.host.native_auth.subscribe_changes();
    receiver.mark_changed();
    let guard = state
        .host
        .lifetime
        .run_guard()
        .map_err(ApiError::bad_request)?;
    let stream = futures::stream::unfold((receiver, guard), |(mut receiver, guard)| async move {
        receiver.changed().await.ok()?;
        let generation = *receiver.borrow_and_update();
        Some((generation, (receiver, guard)))
    });
    Ok(futures::StreamExt::boxed(stream))
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
    body: Bytes,
) -> Result<(StatusCode, CookieJar, Json<BootstrapResponse>), ApiError> {
    if !body.is_empty() {
        return Err(ApiError::bad_request(anyhow::anyhow!(
            "browser bootstrap does not accept a request body"
        )));
    }
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
            state.host
                .native_auth
                .start_login(
                    &session_token,
                    payload.flow.unwrap_or(NativeLoginFlow::SignIn),
                )
                .await
        }
        BrowserConnection::Https => {
            state.host
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
            if let Err(fail_error) = state
                .host
                .native_auth
                .fail_login(callback_state, &message)
                .await
            {
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

    match state
        .host
        .native_auth
        .complete_login(code, callback_state)
        .await
    {
        Ok((user, session_token)) => {
            if let Err(error) = state.auth.bind_session_user(&session_token, &user.id).await {
                return desktop_login_error_response(StatusCode::INTERNAL_SERVER_ERROR, &error);
            }
            let mut message = "Return to Sprocket. You can close this tab.".to_string();
            if state.host.native_auth.credential_store().await == Some(CredentialStore::File) {
                message = format!("{message} {UNENCRYPTED_CREDENTIALS_NOTICE}");
            }
            desktop_login_html_response(StatusCode::OK, "Signed in", &message)
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
        BrowserConnection::Loopback => state.host.native_auth.status(&session_token).await,
        BrowserConnection::Https => state
            .host
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
                .host
                .native_auth
                .cancel_login(&session_token, payload.login_id.trim())
                .await;
        }
        BrowserConnection::Https => {
            let login_id = payload.login_id.trim();
            state
                .host
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
        .host
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
    state
        .host
        .native_auth
        .cancel_device_login(&session_token)
        .await;
    state
        .host
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
    let _activity = match state.host.lifetime.run_guard() {
        Ok(guard) => guard,
        Err(error) => return ApiError::bad_request(error).into_response(),
    };
    let result = native_session_token_response(&state, peer, &headers, &jar, payload).await;
    no_store(result)
}

async fn native_session_token_response(
    state: &AppState,
    peer: SocketAddr,
    headers: &HeaderMap,
    jar: &CookieJar,
    payload: NativeSessionTokenRequest,
) -> Result<Json<Option<sprocket_host::native_auth::NativeBrowserSession>>, ApiError> {
    let (session_token, connection) = require_browser_session(state, headers, jar, peer).await?;
    if !state.auth.session_has_user(&session_token).await {
        return Ok(Json(None));
    }
    let session = state
        .host
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
        state
            .auth
            .require_session_user(&session_token, &session.user.id)
            .await
            .map_err(|error| match connection {
                BrowserConnection::Https => ApiError::authentication_required(),
                BrowserConnection::Loopback => ApiError::with_status(StatusCode::CONFLICT, error),
            })?;
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
mod tests;
