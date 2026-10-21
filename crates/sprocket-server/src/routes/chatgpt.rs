use std::net::SocketAddr;
use std::sync::Arc;

use axum::Json;
use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::routing::post;
use axum_extra::extract::CookieJar;
use serde::{Deserialize, Serialize};

use crate::AppState;
use crate::auth::{
    BrowserConnection, browser_connection, cookie_request_is_csrf_safe, require_session_user,
};
use crate::chatgpt_oauth::{LoginResult, StartError, StartedLogin};
use crate::routes::api_error::ApiError;
use sprocket_host::chatgpt_credentials::ServiceStatus;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UserRequest {
    user_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StartRequest {
    user_id: String,
    connection_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LoginRequest {
    user_id: String,
    state: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConnectionRequest {
    user_id: String,
    connection_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderStatus {
    #[serde(flatten)]
    status: ServiceStatus,
    login_available: bool,
}

#[derive(Serialize)]
struct Disconnected {
    warning: Option<String>,
}

pub(crate) fn routes() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/chatgpt/status", post(status))
        .route("/chatgpt/browser/start", post(start))
        .route("/chatgpt/browser/result", post(result))
        .route("/chatgpt/browser/cancel", post(cancel))
        .route("/chatgpt/select", post(select))
        .route("/chatgpt/disconnect", post(disconnect))
        .layer(axum::middleware::map_response(
            |mut response: axum::response::Response| async move {
                response.headers_mut().insert(
                    header::CACHE_CONTROL,
                    axum::http::HeaderValue::from_static("no-store"),
                );
                response
            },
        ))
}

async fn session_user(
    state: &AppState,
    headers: &HeaderMap,
    jar: &CookieJar,
    user: &str,
) -> Result<String, ApiError> {
    if !cookie_request_is_csrf_safe(headers) {
        return Err(ApiError::authentication_required());
    }
    require_session_user(&state.auth, headers, jar, user)
        .await
        .map_err(|_| ApiError::authentication_required())
}

async fn local_session(
    state: &AppState,
    peer: SocketAddr,
    headers: &HeaderMap,
    jar: &CookieJar,
    user: &str,
) -> Result<String, ApiError> {
    if !state.loopback_desktop_login_supported
        || browser_connection(headers, peer) != Some(BrowserConnection::Loopback)
    {
        return Err(ApiError::bad_request(anyhow::anyhow!(
            "ChatGPT sign-in requires Sprocket running on your own computer. Open its local settings."
        )));
    }
    let session = session_user(state, headers, jar, user).await?;
    if !state.auth.session_is_local_browser(&session).await {
        return Err(ApiError::authentication_required());
    }
    Ok(session)
}

async fn start(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(request): Json<StartRequest>,
) -> Result<Json<StartedLogin>, ApiError> {
    let session = local_session(&state, peer, &headers, &jar, &request.user_id).await?;
    match state
        .chatgpt_oauth
        .start(session, request.user_id, request.connection_id)
        .await
    {
        Ok(started) => Ok(Json(started)),
        Err(StartError::Listener) => Err(ApiError::with_status(
            StatusCode::SERVICE_UNAVAILABLE,
            anyhow::anyhow!("Could not open the local ChatGPT callback listener."),
        )),
        Err(StartError::Failed(error)) => Err(ApiError::bad_request(error)),
    }
}

async fn result(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(request): Json<LoginRequest>,
) -> Result<Json<LoginResult>, ApiError> {
    let session = local_session(&state, peer, &headers, &jar, &request.user_id).await?;
    state
        .chatgpt_oauth
        .poll(&session, &request.user_id, &request.state)
        .await
        .map(Json)
        .ok_or_else(ApiError::authentication_required)
}

async fn cancel(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(request): Json<LoginRequest>,
) -> Result<Json<()>, ApiError> {
    let session = local_session(&state, peer, &headers, &jar, &request.user_id).await?;
    state
        .chatgpt_oauth
        .cancel(&session, &request.user_id, &request.state)
        .await;
    Ok(Json(()))
}

async fn status(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(request): Json<UserRequest>,
) -> Result<Json<ProviderStatus>, ApiError> {
    let session = session_user(&state, &headers, &jar, &request.user_id).await?;
    let login_available = state.host.chatgpt_credentials.available()
        && state.loopback_desktop_login_supported
        && browser_connection(&headers, peer) == Some(BrowserConnection::Loopback)
        && state.auth.session_is_local_browser(&session).await;
    Ok(Json(ProviderStatus {
        status: state
            .host
            .chatgpt_credentials
            .status(&request.user_id)
            .await
            .map_err(ApiError::bad_request)?,
        login_available,
    }))
}

async fn select(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(request): Json<ConnectionRequest>,
) -> Result<Json<()>, ApiError> {
    session_user(&state, &headers, &jar, &request.user_id).await?;
    state.chatgpt_oauth.forget_user(&request.user_id).await;
    state
        .host
        .chatgpt_credentials
        .select(&request.user_id, &request.connection_id)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(()))
}

async fn disconnect(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(request): Json<ConnectionRequest>,
) -> Result<Json<Disconnected>, ApiError> {
    session_user(&state, &headers, &jar, &request.user_id).await?;
    let pending = Arc::clone(&state.chatgpt_oauth);
    let service = Arc::clone(&state.host.chatgpt_credentials);
    let warning = tokio::spawn(async move {
        pending.forget_user(&request.user_id).await;
        service
            .disconnect(&request.user_id, &request.connection_id)
            .await
    })
    .await
    .map_err(|_| ApiError::internal(anyhow::anyhow!("Sign-out task stopped.")))?
    .map_err(ApiError::bad_request)?;
    Ok(Json(Disconnected { warning }))
}

#[cfg(test)]
mod tests;
