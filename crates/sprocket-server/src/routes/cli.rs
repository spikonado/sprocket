mod models;
#[cfg(test)]
mod tests;

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use anyhow::Context;
use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::post;
use axum::{Json, Router};
use convex::Value;
use serde::Deserialize;

use crate::AppState;
use crate::auth::bearer_token;
use crate::cli_protocol::*;
use crate::cli_sessions::CliSession;
use crate::project_attachments::{AttachProjectRequest, repository_key_matches};
use crate::routes::agent::{RunAgentApiRequest, launch_agent};
use crate::routes::api_error::ApiError;
use crate::transcript_client::UserConvexClient;

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
        .route("/cli/run", post(start))
        .route("/cli/poll", post(poll))
        .route("/cli/cancel", post(cancel))
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
        || request.client.protocol_version != CLI_PROTOCOL_VERSION
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
    if request.protocol_version != CLI_PROTOCOL_VERSION
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

async fn start(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(request): Json<CliRunRequest>,
) -> Result<Json<RunStarted>, ApiError> {
    let client = client_session(&state, peer, &headers, &request.client_id).await?;
    let result = tokio::spawn(async move {
        let mut submission = client.submission.lock().await;
        if let Some(previous) = &submission.request {
            anyhow::ensure!(
                previous == &request,
                "a CLI submission cannot be reused with different arguments"
            );
            return submission
                .result
                .clone()
                .context("submission result is missing")?
                .map_err(anyhow::Error::msg);
        }
        submission.request = Some(request.clone());
        let result = tokio::select! {
            biased;
            _ = client.cancellation.cancelled() => Err(anyhow::anyhow!("CLI run was cancelled before submission")),
            result = tokio::time::timeout(Duration::from_secs(45), prepare_run(&state, &client, &request)) => {
                result.context("CLI run preparation timed out").and_then(|result| result)
            }
        };
        let result = match result {
            Ok((payload, rpc)) => {
                submission.user_id = Some(payload.user_id.clone());
                submission.rpc = Some(rpc);
                if client.cancellation.is_cancelled() {
                    Err(anyhow::anyhow!("CLI run was cancelled before submission"))
                } else {
                    launch_agent(
                        state,
                        payload,
                        false,
                        client.cancellation.clone(),
                        Some(Arc::clone(&client.execution_finished)),
                    )
                    .await
                    .map_err(anyhow::Error::from)
                }
            }
            Err(error) => Err(error),
        };
        submission.result = Some(
            result
                .as_ref()
                .map(Clone::clone)
                .map_err(ToString::to_string),
        );
        result
    })
    .await
    .map_err(|error| ApiError::internal(error.into()))?;
    result.map(Json).map_err(ApiError::bad_request)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunContext {
    user_id: String,
    gateway_url: String,
    tier: String,
    thread: Option<ThreadSettings>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadSettings {
    repository_key: String,
    selected_model: String,
    reasoning_effort: String,
    fast_mode: bool,
    active_run_id: Option<String>,
}

async fn convex_client(state: &AppState, user_id: &str) -> anyhow::Result<UserConvexClient> {
    state.native_auth.require_user(user_id).await?;
    UserConvexClient::connect_with_fetcher(
        &state.convex_deployment_url,
        state
            .native_auth
            .auth_token_fetcher_for_user(user_id.to_owned()),
    )
    .await
}

async fn prepare_run(
    state: &AppState,
    client: &CliSession,
    request: &CliRunRequest,
) -> anyhow::Result<(RunAgentApiRequest, UserConvexClient)> {
    anyhow::ensure!(!request.prompt.trim().is_empty(), "prompt is empty");
    let user = state
        .native_auth
        .browser_session(false)
        .await?
        .context("not signed in; run sprocket login")?
        .user;
    state
        .auth
        .bind_session_user(&client.session_token, &user.id)
        .await?;
    let rpc = convex_client(state, &user.id).await?;
    let args = request
        .thread_id
        .as_ref()
        .map(|id| BTreeMap::from([("threadId".into(), Value::String(id.clone()))]))
        .unwrap_or_default();
    let context: RunContext =
        tokio::time::timeout(Duration::from_secs(20), rpc.query("cliRuns:context", args)).await??;
    anyhow::ensure!(
        context.user_id == user.id,
        "run account changed during preparation"
    );
    let attachment = state
        .project_attachments
        .attach(AttachProjectRequest {
            workspace_path: request.directory.clone(),
            replace_workspace_path: None,
        })
        .await?;
    if let Some(thread) = &context.thread {
        anyhow::ensure!(
            repository_key_matches(&attachment, &thread.repository_key),
            "thread belongs to a different repository"
        );
        if let Some(active) = &thread.active_run_id {
            anyhow::bail!("thread already has active run {active}");
        }
    }
    let settings = models::resolve(&context, request).await?;
    Ok((
        RunAgentApiRequest {
            user_id: user.id,
            submission_id: format!("cli:{}", request.client_id),
            thread_id: request.thread_id.clone(),
            repository_key: request
                .thread_id
                .is_none()
                .then_some(attachment.repository_key),
            prompt: request.prompt.clone(),
            storage_ids: Vec::new(),
            selected_model: settings.model,
            reasoning_effort: settings.reasoning,
            fast_mode: settings.fast,
            workspace_path: attachment.workspace_path,
            continuation_of_run_id: None,
        },
        rpc,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    run_id: String,
    thread_id: String,
    status: String,
    error: Option<String>,
    parts: Vec<sprocket_agent::TranscriptPart>,
    has_more: bool,
}

async fn poll(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(request): Json<CliPollRequest>,
) -> Result<Json<CliRunSnapshot>, ApiError> {
    let client = client_session(&state, peer, &headers, &request.client_id).await?;
    let (started, user_id, rpc) = {
        let submission = client.submission.lock().await;
        let started = submission
            .result
            .as_ref()
            .and_then(|result| result.as_ref().ok())
            .cloned()
            .ok_or_else(|| ApiError::bad_request(anyhow::anyhow!("CLI run has not started")))?;
        (
            started,
            submission.user_id.clone().unwrap_or_default(),
            submission
                .rpc
                .clone()
                .ok_or_else(|| ApiError::internal(anyhow::anyhow!("run connection is missing")))?,
        )
    };
    state
        .native_auth
        .require_user(&user_id)
        .await
        .map_err(ApiError::unauthorized)?;
    let snapshot: Snapshot = tokio::time::timeout(
        Duration::from_secs(15),
        rpc.query(
            "cliRuns:snapshot",
            BTreeMap::from([
                ("runId".into(), Value::String(started.run_id.clone())),
                (
                    "afterPart".into(),
                    Value::Float64(request.after_part as f64),
                ),
            ]),
        ),
    )
    .await
    .map_err(|_| {
        ApiError::with_status(
            StatusCode::GATEWAY_TIMEOUT,
            anyhow::anyhow!("run snapshot timed out"),
        )
    })?
    .map_err(ApiError::internal)?;
    let live = state
        .live_completions
        .snapshot(&started.thread_id)
        .filter(|live| live.run_id == started.run_id);
    Ok(Json(CliRunSnapshot {
        run_id: snapshot.run_id,
        thread_id: snapshot.thread_id,
        status: snapshot.status,
        error: snapshot.error,
        parts: snapshot.parts,
        has_more: snapshot.has_more,
        execution_finished: client.execution_finished.load(Ordering::Acquire),
        live,
    }))
}

async fn cancel(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(request): Json<CliClientRequest>,
) -> Result<Json<bool>, ApiError> {
    let client = client_session(&state, peer, &headers, &request.client_id).await?;
    client.cancellation.cancel();
    state
        .native_auth
        .cancel_device_login(&client.session_token)
        .await;
    Ok(Json(true))
}
