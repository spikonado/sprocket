use std::convert::Infallible;
use std::sync::Arc;

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::routing::post;
use futures::StreamExt;
use futures::stream::{self, unfold};
use serde::Deserialize;
use sprocket_host::Host;
use sprocket_host::agent_launch::{AgentLaunchRequest, LaunchError, WorkspaceAccess, launch_agent};
use sprocket_transcript::{LiveCompletionHub, LiveCompletionWatchEvent};
use tokio::sync::broadcast;

use crate::AppState;
use crate::cli_protocol::{CliRunSettings, RunStarted};
use crate::routes::api_error::ApiError;
use crate::routes::session::{AuthorizedJson, UserScoped};

impl UserScoped for AgentLaunchRequest {
    fn user_id(&self) -> &str {
        &self.user_id
    }
}

pub fn routes() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/agent/run", post(run_agent_handler))
        .route("/agent/queue", post(queue_message_handler))
        .route("/agent/live", post(live_handler))
        .route("/agent/commands", post(commands_handler))
        .route("/agent/commands/terminate", post(terminate_command_handler))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CommandsRequest {
    user_id: String,
    thread_id: String,
}

impl UserScoped for CommandsRequest {
    fn user_id(&self) -> &str {
        &self.user_id
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TerminateCommandRequest {
    user_id: String,
    thread_id: String,
    session_id: String,
}

impl UserScoped for TerminateCommandRequest {
    fn user_id(&self) -> &str {
        &self.user_id
    }
}

async fn commands_handler(
    State(state): State<AppState>,
    AuthorizedJson(payload): AuthorizedJson<CommandsRequest>,
) -> Result<axum::response::Response, ApiError> {
    let commands = match state
        .host
        .command_sessions
        .get(&payload.user_id, &payload.thread_id)
        .await
    {
        Some(sessions) => sessions.running_commands().await,
        None => Vec::new(),
    };
    Ok(super::api_error::no_store(Json(
        serde_json::json!({ "commands": commands }),
    )))
}

async fn terminate_command_handler(
    State(state): State<AppState>,
    AuthorizedJson(payload): AuthorizedJson<TerminateCommandRequest>,
) -> Result<axum::response::Response, ApiError> {
    let terminated = match state
        .host
        .command_sessions
        .get(&payload.user_id, &payload.thread_id)
        .await
    {
        Some(sessions) => sessions.terminate_command(&payload.session_id).await,
        None => false,
    };
    Ok(super::api_error::no_store(Json(
        serde_json::json!({ "terminated": terminated }),
    )))
}

async fn run_agent_handler(
    State(state): State<AppState>,
    AuthorizedJson(payload): AuthorizedJson<AgentLaunchRequest>,
) -> Result<(StatusCode, Json<RunStarted>), ApiError> {
    let started = launch_run(
        state.host,
        payload,
        WorkspaceAccess::Attached,
        true,
        Default::default(),
        None,
    )
    .await?;
    Ok((StatusCode::ACCEPTED, Json(started)))
}

async fn queue_message_handler(
    State(state): State<AppState>,
    AuthorizedJson(payload): AuthorizedJson<AgentLaunchRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let host = state.host;
    host.project_attachments
        .require_available_workspace(&payload.workspace_path)
        .await
        .map_err(ApiError::bad_request)?;
    host.machines
        .register(&payload.user_id)
        .await
        .map_err(ApiError::bad_request)?;
    let client = host
        .convex_client_for(&payload.user_id)
        .await
        .map_err(ApiError::bad_request)?;
    let args = sprocket_host::message_queue::enqueue_args(
        payload,
        host.machine_identity.installation_id.clone(),
        host.machine_identity.credential.clone(),
    )
    .map_err(ApiError::bad_request)?;
    let _: serde_json::Value = client
        .mutate("messageQueue:enqueue", args)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(serde_json::json!({ "queued": true })))
}

pub(crate) async fn launch_run(
    host: Host,
    payload: AgentLaunchRequest,
    workspace_access: WorkspaceAccess,
    allow_interaction: bool,
    cancellation: sprocket_workspace::WorkspaceCancellation,
    output: Option<Arc<sprocket_agent::RunOutput>>,
) -> Result<RunStarted, LaunchError> {
    let settings = CliRunSettings {
        model: payload.selected_model.clone(),
        reasoning: payload.reasoning_effort.clone(),
        fast: payload.fast_mode,
    };
    let launched = launch_agent(
        host,
        payload,
        workspace_access,
        allow_interaction,
        cancellation,
        output,
    )
    .await?;
    Ok(RunStarted {
        run_id: launched.run_id,
        thread_id: launched.thread_id,
        settings,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LiveCompletionWatchRequest {
    user_id: String,
    thread_id: String,
}

impl UserScoped for LiveCompletionWatchRequest {
    fn user_id(&self) -> &str {
        &self.user_id
    }
}

struct LiveSseStream {
    receiver: broadcast::Receiver<LiveCompletionWatchEvent>,
    hub: Arc<LiveCompletionHub>,
    thread_id: String,
}

async fn live_handler(
    State(state): State<AppState>,
    AuthorizedJson(payload): AuthorizedJson<LiveCompletionWatchRequest>,
) -> Result<Sse<impl futures::Stream<Item = Result<Event, Infallible>>>, ApiError> {
    let hub = Arc::clone(&state.host.live_completions);
    let subscription = hub.subscribe(&payload.thread_id);
    let snapshot = encode_live_event(match subscription.snapshot {
        Some(live) => LiveCompletionWatchEvent::Updated { live },
        None => LiveCompletionWatchEvent::Cleared,
    });
    let rest = unfold(
        LiveSseStream {
            receiver: subscription.receiver,
            hub,
            thread_id: payload.thread_id,
        },
        |state| async move { next_live_event(state).await },
    );
    let stream = stream::iter(snapshot).chain(rest);
    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}

async fn next_live_event(
    mut state: LiveSseStream,
) -> Option<(Result<Event, Infallible>, LiveSseStream)> {
    loop {
        match state.receiver.recv().await {
            Ok(event) => {
                if let Some(encoded) = encode_live_event(event) {
                    return Some((encoded, state));
                }
            }
            Err(broadcast::error::RecvError::Lagged(_)) => {
                // Resubscribe so buffered events older than the snapshot
                // (including a prior Cleared) are not replayed after catch-up.
                let subscription = state.hub.subscribe(&state.thread_id);
                state.receiver = subscription.receiver;
                let event = match subscription.snapshot {
                    Some(live) => LiveCompletionWatchEvent::Updated { live },
                    None => LiveCompletionWatchEvent::Cleared,
                };
                if let Some(encoded) = encode_live_event(event) {
                    return Some((encoded, state));
                }
            }
            Err(broadcast::error::RecvError::Closed) => return None,
        }
    }
}

fn encode_live_event(event: LiveCompletionWatchEvent) -> Option<Result<Event, Infallible>> {
    Event::default().json_data(event).ok().map(Ok)
}

#[cfg(test)]
mod tests;
