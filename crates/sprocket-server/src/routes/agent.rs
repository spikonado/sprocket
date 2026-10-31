use std::sync::Arc;

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::post;
use futures::StreamExt;
use futures::stream::{self, BoxStream, unfold};
use serde::{Deserialize, Serialize};
use sprocket_host::Host;
use sprocket_host::agent_launch::{AgentLaunchRequest, LaunchError, WorkspaceAccess, launch_agent};
use sprocket_transcript::{LiveCompletionHub, LiveCompletionOverlay, LiveCompletionWatchEvent};
use sprocket_workspace::RunningCommand;
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
        .route("/agent/commands/terminate", post(terminate_command_handler))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CommandsRequest {
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

#[derive(Serialize)]
pub(crate) struct CommandsSnapshot {
    commands: Vec<RunningCommand>,
}

/// Callers must authorize `payload.user_id` first.
pub(crate) fn command_events(
    state: &AppState,
    payload: CommandsRequest,
) -> BoxStream<'static, CommandsSnapshot> {
    let sessions = Arc::clone(&state.host.command_sessions);
    let changes = sessions.subscribe_changes();
    unfold(
        (sessions, changes, payload, None),
        |(sessions, mut changes, payload, last)| async move {
            loop {
                changes.borrow_and_update();
                let commands = sessions
                    .running_commands(&payload.user_id, &payload.thread_id)
                    .await;
                if last.as_ref() != Some(&commands) {
                    let snapshot = CommandsSnapshot {
                        commands: commands.clone(),
                    };
                    return Some((snapshot, (sessions, changes, payload, Some(commands))));
                }
                changes.changed().await.ok()?;
            }
        },
    )
    .boxed()
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
        stopped: launched.stopped,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LiveCompletionWatchRequest {
    user_id: String,
    thread_id: String,
}

impl UserScoped for LiveCompletionWatchRequest {
    fn user_id(&self) -> &str {
        &self.user_id
    }
}

struct LiveStream {
    receiver: broadcast::Receiver<LiveCompletionWatchEvent>,
    hub: Arc<LiveCompletionHub>,
    thread_id: String,
}

/// Callers must authorize `payload.user_id` first.
pub(crate) fn live_events(
    state: &AppState,
    payload: LiveCompletionWatchRequest,
) -> BoxStream<'static, LiveCompletionWatchEvent> {
    let hub = Arc::clone(&state.host.live_completions);
    let subscription = hub.subscribe(&payload.thread_id);
    let snapshot = snapshot_event(subscription.snapshot);
    let rest = unfold(
        LiveStream {
            receiver: subscription.receiver,
            hub,
            thread_id: payload.thread_id,
        },
        next_live_event,
    );
    stream::iter([snapshot]).chain(rest).boxed()
}

async fn next_live_event(mut state: LiveStream) -> Option<(LiveCompletionWatchEvent, LiveStream)> {
    match state.receiver.recv().await {
        Ok(event) => Some((event, state)),
        Err(broadcast::error::RecvError::Lagged(_)) => {
            // Resubscribe so buffered events older than the snapshot
            // (including a prior Cleared) are not replayed after catch-up.
            let subscription = state.hub.subscribe(&state.thread_id);
            state.receiver = subscription.receiver;
            Some((snapshot_event(subscription.snapshot), state))
        }
        Err(broadcast::error::RecvError::Closed) => None,
    }
}

fn snapshot_event(snapshot: Option<LiveCompletionOverlay>) -> LiveCompletionWatchEvent {
    match snapshot {
        Some(live) => LiveCompletionWatchEvent::Updated { live },
        None => LiveCompletionWatchEvent::Cleared,
    }
}

#[cfg(test)]
mod tests;
