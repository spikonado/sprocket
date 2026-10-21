use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use axum::Json;
use axum::extract::{ConnectInfo, State};
use axum::http::HeaderMap;
use convex::Value;

use super::client_session;
use super::models::{RunContext, available, gateway_url, resolve};
use crate::AppState;
use crate::cli_protocol::*;
use crate::cli_sessions::CliSession;
use crate::routes::agent::launch_run;
use crate::routes::api_error::ApiError;
use sprocket_host::agent_launch::{AgentLaunchRequest, WorkspaceAccess};
use sprocket_host::project_attachments::repository_key_matches;
use sprocket_host::transcript_client::UserConvexClient;

pub(super) async fn list_models(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(request): Json<CliClientRequest>,
) -> Result<Json<CliModelsResponse>, ApiError> {
    let client = client_session(&state, peer, &headers, &request.client_id).await?;
    let user = state
        .host
        .native_auth
        .browser_session(false)
        .await
        .map_err(ApiError::internal)?
        .ok_or_else(ApiError::authentication_required)?
        .user;
    state
        .auth
        .bind_session_user(&client.session_token, &user.id)
        .await
        .map_err(ApiError::internal)?;
    let rpc = convex_client(&state, &user.id)
        .await
        .map_err(ApiError::internal)?;
    let context = tokio::time::timeout(Duration::from_secs(20), run_context(&rpc, None))
        .await
        .map_err(|error| ApiError::internal(error.into()))?
        .map_err(ApiError::internal)?;
    let response = available(&context).await.map_err(ApiError::internal)?;
    Ok(Json(response))
}

pub(super) async fn start(
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
            Ok(payload) => {
                submission.user_id = Some(payload.user_id.clone());
                if client.cancellation.is_cancelled() {
                    Err(anyhow::anyhow!("CLI run was cancelled before submission"))
                } else {
                    launch_run(
                        state.host,
                        payload,
                        WorkspaceAccess::RunDirectory,
                        false,
                        client.cancellation.clone(),
                        Some(Arc::clone(&client.output)),
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

async fn convex_client(state: &AppState, user_id: &str) -> anyhow::Result<UserConvexClient> {
    state.host.native_auth.require_user(user_id).await?;
    state.host.convex_client_for(user_id).await
}

async fn run_context(
    rpc: &UserConvexClient,
    thread_id: Option<&str>,
) -> anyhow::Result<RunContext> {
    let thread = match thread_id {
        Some(thread_id) => {
            let args = BTreeMap::from([("threadId".into(), Value::String(thread_id.to_owned()))]);
            Some(rpc.query("threads:getByThreadId", args).await?)
        }
        None => None,
    };
    Ok(RunContext {
        gateway_url: gateway_url()?,
        thread,
    })
}

async fn prepare_run(
    state: &AppState,
    client: &CliSession,
    request: &CliRunRequest,
) -> anyhow::Result<AgentLaunchRequest> {
    anyhow::ensure!(!request.prompt.trim().is_empty(), "prompt is empty");
    let user = state
        .host
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
    let context = tokio::time::timeout(
        Duration::from_secs(20),
        run_context(&rpc, request.thread_id.as_deref()),
    )
    .await??;
    let attachment = state
        .host
        .project_attachments
        .resolve_run_workspace(request.directory.clone())
        .await?;
    if let Some(thread) = &context.thread {
        anyhow::ensure!(
            repository_key_matches(&attachment, &thread.repository_key),
            "thread belongs to a different repository"
        );
    }
    let settings = resolve(&context, request).await?;
    Ok(AgentLaunchRequest {
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
        completion_provider: context
            .thread
            .as_ref()
            .map(|thread| thread.completion_provider)
            .unwrap_or_default(),
        reasoning_effort: settings.reasoning,
        fast_mode: settings.fast,
        workspace_path: attachment.workspace_path,
        continuation_of_run_id: None,
        execution_secret: None,
    })
}

pub(super) async fn output(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(request): Json<CliOutputRequest>,
) -> Result<Json<CliRunSnapshot>, ApiError> {
    let client = client_session(&state, peer, &headers, &request.client_id).await?;
    let (started, user_id) = {
        let submission = client.submission.lock().await;
        let started = submission
            .result
            .as_ref()
            .and_then(|result| result.as_ref().ok())
            .cloned()
            .ok_or_else(|| ApiError::bad_request(anyhow::anyhow!("CLI run has not started")))?;
        (started, submission.user_id.clone().unwrap_or_default())
    };
    state
        .auth
        .require_session_user(&client.session_token, &user_id)
        .await
        .map_err(ApiError::unauthorized)?;
    let mut changed = client.output.subscribe();
    let revision = *changed.borrow_and_update();
    if request.after_revision == Some(revision) {
        let _ = tokio::time::timeout(Duration::from_secs(15), changed.changed()).await;
    }
    state
        .auth
        .require_session_user(&client.session_token, &user_id)
        .await
        .map_err(ApiError::unauthorized)?;
    let snapshot = client
        .output
        .page(request.after_part)
        .await
        .map_err(ApiError::bad_request)?;
    let live = state
        .host
        .live_completions
        .snapshot(&started.thread_id)
        .filter(|live| live.run_id == started.run_id);
    Ok(Json(CliRunSnapshot {
        run_id: started.run_id,
        thread_id: started.thread_id,
        revision: snapshot.revision,
        answer: snapshot.answer,
        status: snapshot
            .outcome
            .as_ref()
            .map(|outcome| outcome.status.clone())
            .unwrap_or_else(|| "running".into()),
        error: match (
            snapshot.outcome.and_then(|outcome| outcome.error),
            snapshot.output_error,
        ) {
            (Some(run_error), Some(output_error)) => Some(format!("{run_error}\n{output_error}")),
            (run_error, output_error) => run_error.or(output_error),
        },
        parts: snapshot.parts,
        has_more: snapshot.has_more,
        execution_finished: snapshot.finished,
        live,
    }))
}

pub(super) async fn cancel(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(request): Json<CliClientRequest>,
) -> Result<Json<bool>, ApiError> {
    let client = client_session(&state, peer, &headers, &request.client_id).await?;
    client.cancellation.cancel();
    state
        .host
        .native_auth
        .cancel_device_login(&client.session_token)
        .await;
    Ok(Json(true))
}
