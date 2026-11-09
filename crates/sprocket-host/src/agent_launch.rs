use std::sync::Arc;
use std::time::Duration;

use anyhow::anyhow;
use serde::Deserialize;
use sprocket_agent::{
    CompletionProvider, RunAgentRequest, finalize_failed_start, run_agent, start_agent_run,
};
use tokio::sync::oneshot;
use tokio::time::timeout;

use crate::Host;
use crate::kicad_connector::KiCadConnector;
use crate::run_recovery::RunOwner;

const AGENT_START_CLEANUP_TIMEOUT: Duration = Duration::from_secs(12);

struct FinishedOnDrop(Option<Arc<sprocket_agent::RunOutput>>);

#[derive(Clone, Copy, serde::Serialize, serde::Deserialize)]
pub enum WorkspaceAccess {
    Attached,
    RunDirectory,
}

impl Drop for FinishedOnDrop {
    fn drop(&mut self) {
        if let Some(finished) = &self.0 {
            finished.finish(None);
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentLaunchRequest {
    pub user_id: String,
    pub submission_id: String,
    #[serde(default)]
    pub thread_id: Option<String>,
    #[serde(default)]
    pub repository_key: Option<String>,
    pub prompt: String,
    pub storage_ids: Vec<String>,
    pub selected_model: String,
    #[serde(default)]
    pub completion_provider: CompletionProvider,
    pub reasoning_effort: String,
    pub fast_mode: bool,
    pub workspace_path: String,
    #[serde(default)]
    pub continuation_of_run_id: Option<String>,
    /// Set when `subagents:createOrSend` already created the run with this secret.
    #[serde(default)]
    pub execution_secret: Option<String>,
}

pub struct LaunchedRun {
    pub run_id: String,
    pub thread_id: String,
}

#[derive(Debug)]
pub enum LaunchError {
    Rejected(anyhow::Error),
    Unauthorized(anyhow::Error),
    Internal(anyhow::Error),
}

impl std::fmt::Display for LaunchError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Rejected(error) | Self::Unauthorized(error) => write!(formatter, "{error}"),
            Self::Internal(error) => write!(formatter, "{error:#}"),
        }
    }
}

impl std::error::Error for LaunchError {}

pub async fn launch_agent(
    host: Host,
    payload: AgentLaunchRequest,
    workspace_access: WorkspaceAccess,
    allow_interaction: bool,
    cancellation: sprocket_workspace::WorkspaceCancellation,
    output: Option<Arc<sprocket_agent::RunOutput>>,
) -> Result<LaunchedRun, LaunchError> {
    launch_agent_inner(
        host,
        payload,
        workspace_access,
        allow_interaction,
        cancellation,
        output,
        None,
    )
    .await
}

pub async fn launch_recovery(
    host: Host,
    record: crate::run_recovery::RecoveryRecord,
) -> anyhow::Result<()> {
    launch_agent_inner(
        host,
        record.request.clone(),
        record.workspace_access,
        record.allow_interaction,
        Default::default(),
        None,
        Some(record),
    )
    .await
    .map(|_| ())
    .map_err(|error| anyhow!("failed to restart interrupted run: {error}"))
}

async fn launch_agent_inner(
    host: Host,
    payload: AgentLaunchRequest,
    workspace_access: WorkspaceAccess,
    allow_interaction: bool,
    cancellation: sprocket_workspace::WorkspaceCancellation,
    output: Option<Arc<sprocket_agent::RunOutput>>,
    recovery: Option<crate::run_recovery::RecoveryRecord>,
) -> Result<LaunchedRun, LaunchError> {
    let guard = host.lifetime.run_guard().map_err(LaunchError::Rejected)?;
    host.native_auth
        .require_user(&payload.user_id)
        .await
        .map_err(LaunchError::Unauthorized)?;

    let attachment = match workspace_access {
        WorkspaceAccess::Attached if recovery.is_some() => {
            host.project_attachments
                .recovered_run_workspace(&payload.workspace_path)
                .await
        }
        WorkspaceAccess::Attached => {
            host.project_attachments
                .require_available_workspace(&payload.workspace_path)
                .await
        }
        WorkspaceAccess::RunDirectory => {
            host.project_attachments
                .resolve_run_workspace(payload.workspace_path.clone())
                .await
        }
    }
    .map_err(LaunchError::Rejected)?;
    let workspace_path = attachment.workspace_path.clone();
    let artifact_workspace_path = workspace_path.clone();
    let command_workspace_root = std::path::PathBuf::from(&workspace_path);
    let artifact_repository_key = payload
        .repository_key
        .as_deref()
        .map(str::trim)
        .filter(|key| crate::project_attachments::repository_key_matches(&attachment, key))
        .unwrap_or(attachment.repository_key.as_str())
        .to_string();
    let project_attachments = Arc::clone(&host.project_attachments);
    let attachment_key = attachment.attachment_key.clone();
    host.prepare_tools();
    let tool_environment = host.tool_environment();
    let records_message = !payload.prompt.trim().is_empty()
        || !payload.storage_ids.is_empty()
        || payload.continuation_of_run_id.is_some();

    host.machines
        .register(&payload.user_id)
        .await
        .map_err(LaunchError::Rejected)?;
    let auth_token_fetcher = host
        .native_auth
        .auth_token_fetcher_for_user(payload.user_id.clone());
    let automatic_recovery = recovery.is_some();
    let mut recovery = recovery.unwrap_or_else(|| {
        crate::run_recovery::RecoveryRecord::new(
            payload.clone(),
            workspace_access,
            allow_interaction,
        )
    });
    recovery.request.workspace_path = workspace_path.clone();
    let owner = if output.is_some() {
        RunOwner::Client
    } else {
        RunOwner::Host
    };
    let (recovery_guard, saved) = host
        .run_recovery
        .begin(recovery, owner)
        .await
        .map_err(LaunchError::Internal)?;
    let request = RunAgentRequest {
        chatgpt_credentials: Some(host.chatgpt_credentials.for_user(payload.user_id.clone())),
        claude_code: host.claude_code.clone(),
        muse: host.muse.clone(),
        allow_interaction,
        cancellation,
        deployment_url: host.convex_deployment_url.clone(),
        auth_token_fetcher: auth_token_fetcher.clone(),
        execution_secret: saved
            .request
            .execution_secret
            .expect("the recovery record has an execution secret"),
        submission_id: payload.submission_id,
        thread_id: payload.thread_id.unwrap_or_default(),
        repository_key: payload.repository_key,
        prompt: payload.prompt,
        storage_ids: payload.storage_ids,
        selected_model: payload.selected_model,
        completion_provider: payload.completion_provider,
        reasoning_effort: payload.reasoning_effort,
        fast_mode: payload.fast_mode,
        workspace_path,
        installation_id: host.machine_identity.installation_id.clone(),
        continuation_of_run_id: payload.continuation_of_run_id,
        automatic_recovery,
        subagent_launcher: Some(crate::subagent_launcher::launcher(&host)),
        transcript_store: Some(Arc::clone(&host.transcript)),
        installed_connectors: host.kicad.installed().into_iter().collect(),
    };

    let cleanup_request = request.clone();
    let command_sessions = Arc::clone(&host.command_sessions);
    let command_lifetime = Arc::clone(&host.lifetime);
    let command_machine_id = host.machine_identity.installation_id.clone();
    let command_auth = Arc::clone(&host.native_auth);
    let command_deployment = host.convex_deployment_url.clone();
    let kicad = Arc::clone(&host.kicad);
    let live = Arc::clone(&host.live_completions);
    let transcript = Arc::clone(&host.transcript);
    let transcript_watchers = Arc::clone(&host.transcript_watchers);
    let artifact_watchers = Arc::clone(&host.artifact_watchers);
    let (start_result_sender, start_result_receiver) = oneshot::channel();

    // Hyper may drop this handler when the browser closes the tab, so the launch runs
    // detached and this only waits for Convex to hold the run.
    tokio::spawn(async move {
        let _guard = guard;
        let _recovery_guard = recovery_guard;
        let _finished = FinishedOnDrop(output.clone());
        let run = match start_agent_run(request).await {
            Ok(run) => Ok(run),
            Err(error) => {
                let startup_error = format!("{error:#}");
                let mut cleanup_request = cleanup_request;
                cleanup_request.auth_token_fetcher = auth_token_fetcher;
                let cleanup = timeout(
                    AGENT_START_CLEANUP_TIMEOUT,
                    finalize_failed_start(cleanup_request, &error),
                )
                .await;
                match cleanup {
                    Ok(Ok(())) => Err(error),
                    Ok(Err(cleanup_error)) => Err(anyhow!(
                        "{startup_error}; additionally failed to reconcile the startup: {cleanup_error:#}"
                    )),
                    Err(_) => Err(anyhow!(
                        "{startup_error}; additionally timed out reconciling the startup"
                    )),
                }
            }
        };

        match run {
            Ok(mut run) => {
                if let Some(output) = &output {
                    run.observe_output(Arc::clone(output), Arc::clone(&transcript))
                        .await;
                }
                let run_id = run.run_id().to_string();
                let thread_id = run.thread_id().to_string();
                let user_id = run.user_id().to_string();
                if records_message
                    && let Err(error) = project_attachments
                        .record_message_sent(&attachment_key, crate::now_ms())
                        .await
                {
                    eprintln!(
                        "sprocket-server: failed to save project message recency for run {run_id}: {error:#}"
                    );
                }
                let _ = start_result_sender.send(Ok(LaunchedRun {
                    run_id: run_id.clone(),
                    thread_id: thread_id.clone(),
                }));
                let sessions = command_sessions
                    .for_run(
                        &user_id,
                        &thread_id,
                        command_workspace_root,
                        transcript
                            .thread_dir(&user_id, &thread_id)
                            .join("command-logs"),
                    )
                    .await
                    .with_environment(
                        tool_environment
                            .into_iter()
                            .chain(thread_tool_sessions(&thread_id)),
                    )
                    .with_history_scope(user_id.clone(), thread_id.clone(), command_machine_id)
                    .with_command_environment({
                        let user_id = user_id.clone();
                        move || {
                            let kicad = Arc::clone(&kicad);
                            let user_id = user_id.clone();
                            async move { command_environment(&kicad, &user_id).await }
                        }
                    })
                    .with_history_resolver({
                        let user_id = user_id.clone();
                        let thread_id = thread_id.clone();
                        move |session_id, directory| {
                            let auth = Arc::clone(&command_auth);
                            let deployment = command_deployment.clone();
                            let user_id = user_id.clone();
                            let thread_id = thread_id.clone();
                            async move {
                                crate::command_sync::fetch(
                                    &deployment,
                                    &auth,
                                    &user_id,
                                    &thread_id,
                                    &session_id,
                                    &directory,
                                )
                                .await
                            }
                        }
                    })
                    .with_lifetime_guard_factory(move || command_lifetime.run_guard());
                let artifact_watch = if artifact_repository_key.is_empty() {
                    None
                } else {
                    Some(
                        artifact_watchers
                            .open(&user_id, &artifact_repository_key, &artifact_workspace_path)
                            .await,
                    )
                };
                let transcript_watch = transcript_watchers.open(&user_id, &thread_id).await;
                let result = run_agent(run, sessions, live, transcript).await;
                if let Some(output) = &output {
                    output.finish(result.as_ref().err().map(ToString::to_string));
                }
                if let Some(watch) = &artifact_watch
                    && let Err(error) = watch.flush().await
                {
                    tracing::warn!("artifact sync after run {run_id} failed: {error:#}");
                }
                drop(artifact_watch);
                drop(transcript_watch);
                if let Err(error) = result {
                    eprintln!("sprocket-server: agent run failed: {error:#}");
                }
            }
            Err(error) => {
                let failure =
                    LaunchError::Internal(anyhow!("failed to start agent run: {error:#}"));
                if let Err(Err(error)) = start_result_sender.send(Err(failure)) {
                    eprintln!("sprocket-server: detached agent launch failed: {error}");
                }
            }
        }
    });

    start_result_receiver.await.map_err(|_| {
        LaunchError::Internal(anyhow!(
            "failed to start agent run: agent launch task stopped unexpectedly"
        ))
    })?
}

/// agent-browser and agent-desktop fall back to these when a command passes no
/// `--session` or `--agent-id`, so parallel agents get their own browser and cursor.
fn thread_tool_sessions(thread_id: &str) -> [(std::ffi::OsString, std::ffi::OsString); 2] {
    ["AGENT_BROWSER_SESSION", "AGENT_DESKTOP_AGENT_ID"].map(|name| (name.into(), thread_id.into()))
}

/// Read for every command, since connector installs and GitHub sign-ins change during a run.
async fn command_environment(
    kicad: &KiCadConnector,
    user_id: &str,
) -> Vec<(std::ffi::OsString, std::ffi::OsString)> {
    let mut environment = kicad.environment();
    environment.extend(
        sprocket_workspace::github::agent_environment(user_id)
            .await
            .into_iter()
            .map(|(key, value)| (key.into(), value.into())),
    );
    environment
}

#[cfg(test)]
mod tests;
