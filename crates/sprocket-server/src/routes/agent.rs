use std::sync::Arc;

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::post;
use futures::StreamExt;
use futures::stream::{BoxStream, unfold};
use serde::Deserialize;
use sprocket_host::Host;
use sprocket_host::agent_launch::{AgentLaunchRequest, LaunchError, WorkspaceAccess, launch_agent};
use sprocket_workspace::RunningCommand;

use crate::AppState;
use crate::cli_protocol::{CliRunSettings, RunStarted};
use crate::routes::api_error::ApiError;
use crate::routes::events::Authorized;
use crate::routes::run_settings;
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

#[derive(Clone, Deserialize)]
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

pub(crate) fn command_events(
    state: &AppState,
    request: Authorized<CommandsRequest>,
) -> BoxStream<'static, Vec<RunningCommand>> {
    let payload = request.into_inner();
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
                    return Some((
                        commands.clone(),
                        (sessions, changes, payload, Some(commands)),
                    ));
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
    AuthorizedJson(mut payload): AuthorizedJson<AgentLaunchRequest>,
) -> Result<(StatusCode, Json<RunStarted>), ApiError> {
    let rpc = run_settings::convex_client(&state.host, &payload.user_id)
        .await
        .map_err(ApiError::internal)?;
    let overrides = sprocket_agent::SettingsOverrides {
        model: Some(payload.selected_model.clone()),
        reasoning: Some(payload.reasoning_effort.clone()),
        fast: Some(payload.fast_mode),
    };
    let settings = run_settings::resolve(&rpc, None, &overrides)
        .await
        .map_err(ApiError::bad_request)?;
    payload.completion_provider = settings.provider;
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
    })
}

#[cfg(test)]
mod tests;
