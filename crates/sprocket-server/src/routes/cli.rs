#[cfg(test)]
mod tests;

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::post;
use axum::{Json, Router};

use crate::AppState;
use crate::auth::bearer_token;
use crate::cli_protocol::*;
use crate::cli_sessions::CliSession;
use crate::routes::api_error::ApiError;

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/cli/discovery", post(discovery))
        .route("/cli/bootstrap", post(bootstrap))
        .route("/cli/connect", post(connect))
        .route("/cli/heartbeat", post(heartbeat))
        .route("/cli/release", post(release))
        .route("/cli/login", post(login))
        .route("/cli/auth", post(auth_status))
        .route("/cli/logout", post(logout))
}

async fn discovery(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(request): Json<crate::PairingProofRequest>,
) -> Result<Json<CliDiscovery>, ApiError> {
    if !peer.ip().is_loopback() {
        return Err(ApiError::authentication_required());
    }
    let proof = state
        .auth
        .pairing_proof(&cli_discovery_message(
            &request.challenge,
            &state.auth.instance_id,
            &state.http_base_url,
        ))
        .map_err(ApiError::internal)?;
    Ok(Json(CliDiscovery {
        instance_id: state.auth.instance_id.clone(),
        http_base_url: state.http_base_url,
        proof,
    }))
}

async fn bootstrap(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(request): Json<CliBootstrapRequest>,
) -> Result<Json<CliBootstrapResponse>, ApiError> {
    if !peer.ip().is_loopback()
        || uuid::Uuid::parse_str(&request.session_token).is_err()
        || request.client.client_version != sprocket_workspace::SPROCKET_VERSION
        || request.client.deployment_url.trim_end_matches('/')
            != state.convex_deployment_url.trim_end_matches('/')
        || !crate::verify_pairing_proof(
            state.auth.pairing_credential(),
            &cli_bootstrap_message(&state.auth.instance_id, &state.http_base_url, &request),
            &request.proof,
        )
    {
        return Err(ApiError::authentication_required());
    }
    let proof = state
        .auth
        .pairing_proof(&cli_bootstrap_response_message(
            &state.auth.instance_id,
            &state.http_base_url,
            &request,
        ))
        .map_err(ApiError::internal)?;
    state
        .lifetime
        .connect(&request.client.client_id, &request.session_token)
        .map_err(ApiError::bad_request)?;
    state.auth.create_cli_session(request.session_token).await;
    Ok(Json(CliBootstrapResponse { proof }))
}

async fn session(
    state: &AppState,
    peer: SocketAddr,
    headers: &HeaderMap,
) -> Result<String, ApiError> {
    if !peer.ip().is_loopback() {
        return Err(ApiError::with_status(
            StatusCode::FORBIDDEN,
            anyhow::anyhow!("CLI access is local-only"),
        ));
    }
    let token = bearer_token(headers).ok_or_else(ApiError::authentication_required)?;
    if !state.auth.session_state(Some(&token)).await.authenticated {
        return Err(ApiError::authentication_required());
    }
    Ok(token)
}

async fn client_session(
    state: &AppState,
    peer: SocketAddr,
    headers: &HeaderMap,
    client_id: &str,
) -> Result<Arc<CliSession>, ApiError> {
    let token = session(state, peer, headers).await?;
    state
        .lifetime
        .client(client_id, &token)
        .map_err(|error| ApiError::with_status(StatusCode::CONFLICT, error))
}

async fn connect(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(request): Json<CliConnectRequest>,
) -> Result<Json<bool>, ApiError> {
    let token = session(&state, peer, &headers).await?;
    if request.client_version != sprocket_workspace::SPROCKET_VERSION
        || request.deployment_url.trim_end_matches('/')
            != state.convex_deployment_url.trim_end_matches('/')
    {
        return Err(ApiError::with_status(
            StatusCode::CONFLICT,
            anyhow::anyhow!(
                "incompatible Sprocket server; update it or select a different data directory"
            ),
        ));
    }
    state
        .lifetime
        .connect(&request.client_id, &token)
        .map_err(ApiError::bad_request)?;
    Ok(Json(true))
}

async fn heartbeat(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(request): Json<CliClientRequest>,
) -> Result<Json<bool>, ApiError> {
    client_session(&state, peer, &headers, &request.client_id).await?;
    Ok(Json(true))
}

async fn release(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(request): Json<CliClientRequest>,
) -> Result<Json<bool>, ApiError> {
    let token = session(&state, peer, &headers).await?;
    state
        .lifetime
        .release(&request.client_id, &token)
        .map_err(ApiError::bad_request)?;
    state.native_auth.cancel_device_login(&token).await;
    state
        .auth
        .end_session(&token)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(true))
}

async fn auth_status(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(request): Json<CliClientRequest>,
) -> Result<Json<LoginStatus>, ApiError> {
    let client = client_session(&state, peer, &headers, &request.client_id).await?;
    let status = state.native_auth.device_status(&client.session_token).await;
    if let LoginStatus::Authenticated { user } = &status {
        state
            .auth
            .bind_session_user(&client.session_token, &user.id)
            .await
            .map_err(ApiError::internal)?;
    }
    Ok(Json(status))
}

async fn login(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(request): Json<CliLoginRequest>,
) -> Result<Json<DeviceLoginResponse>, ApiError> {
    let client = client_session(&state, peer, &headers, &request.client_id).await?;
    if let Some(store) = request.credential_store {
        state
            .native_auth
            .select_credential_store(store)
            .await
            .map_err(ApiError::bad_request)?;
    }
    let response = state
        .native_auth
        .start_device_login(client.session_token.clone())
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(response))
}

async fn logout(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(request): Json<CliClientRequest>,
) -> Result<Json<bool>, ApiError> {
    client_session(&state, peer, &headers, &request.client_id).await?;
    state
        .native_auth
        .sign_out()
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(true))
}
