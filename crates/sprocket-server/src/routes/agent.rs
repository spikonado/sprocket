use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use anyhow::anyhow;
use axum::Json;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::routing::post;
use axum_extra::extract::CookieJar;
use futures::StreamExt;
use futures::stream::{self, unfold};
use serde::Deserialize;
use sprocket_agent::{
    CompletionProvider, LiveCompletionHub, LiveCompletionWatchEvent, RunAgentRequest,
    finalize_failed_start, run_agent, start_agent_run,
};
use tokio::sync::broadcast;
use tokio::sync::oneshot;
use tokio::time::timeout;

use crate::AppState;
use crate::auth::require_session_user;
use crate::cli_protocol::RunStarted;
use crate::routes::api_error::ApiError;

const AGENT_START_CLEANUP_TIMEOUT: Duration = Duration::from_secs(12);

struct FinishedOnDrop(Option<Arc<sprocket_agent::RunOutput>>);

#[derive(Clone, Copy, serde::Serialize, serde::Deserialize)]
pub(crate) enum WorkspaceAccess {
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
pub(crate) struct RunAgentApiRequest {
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
    /// Pre-committed run capability for native delegation: the child run was
    /// already durably created by `subagents:createOrSend` with this fresh
    /// secret; the launch reuses it instead of minting its own.
    #[serde(default)]
    pub execution_secret: Option<String>,
}

pub fn routes() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/agent/run", post(run_agent_handler))
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TerminateCommandRequest {
    user_id: String,
    thread_id: String,
    session_id: String,
}

async fn commands_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(payload): Json<CommandsRequest>,
) -> Result<axum::response::Response, ApiError> {
    state
        .require_session_user(&headers, &jar, &payload.user_id)
        .await?;
    let commands = match state
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
    headers: HeaderMap,
    jar: CookieJar,
    Json(payload): Json<TerminateCommandRequest>,
) -> Result<axum::response::Response, ApiError> {
    state
        .require_session_user(&headers, &jar, &payload.user_id)
        .await?;
    let terminated = match state
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
    headers: HeaderMap,
    jar: CookieJar,
    Json(payload): Json<RunAgentApiRequest>,
) -> Result<(StatusCode, Json<RunStarted>), ApiError> {
    require_session_user(&state.auth, &headers, &jar, &payload.user_id)
        .await
        .map_err(ApiError::unauthorized)?;
    let started = launch_agent(
        state,
        payload,
        WorkspaceAccess::Attached,
        true,
        Default::default(),
        None,
    )
    .await?;
    Ok((StatusCode::ACCEPTED, Json(started)))
}

pub(crate) async fn launch_agent(
    state: AppState,
    payload: RunAgentApiRequest,
    workspace_access: WorkspaceAccess,
    allow_interaction: bool,
    cancellation: sprocket_workspace::WorkspaceCancellation,
    output: Option<Arc<sprocket_agent::RunOutput>>,
) -> Result<RunStarted, ApiError> {
    launch_agent_inner(
        state,
        payload,
        workspace_access,
        allow_interaction,
        cancellation,
        output,
        None,
    )
    .await
}

pub(crate) async fn launch_recovery(
    state: AppState,
    record: crate::run_recovery::RecoveryRecord,
) -> anyhow::Result<()> {
    launch_agent_inner(
        state,
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
    state: AppState,
    mut payload: RunAgentApiRequest,
    workspace_access: WorkspaceAccess,
    allow_interaction: bool,
    cancellation: sprocket_workspace::WorkspaceCancellation,
    output: Option<Arc<sprocket_agent::RunOutput>>,
    recovery: Option<crate::run_recovery::RecoveryRecord>,
) -> Result<RunStarted, ApiError> {
    let guard = state.lifetime.run_guard().map_err(ApiError::bad_request)?;
    state
        .native_auth
        .require_user(&payload.user_id)
        .await
        .map_err(ApiError::unauthorized)?;

    let attachment = match workspace_access {
        WorkspaceAccess::Attached => {
            state
                .project_attachments
                .require_available_workspace(&payload.workspace_path)
                .await
        }
        WorkspaceAccess::RunDirectory => {
            state
                .project_attachments
                .resolve_run_workspace(payload.workspace_path.clone())
                .await
        }
    }
    .map_err(ApiError::bad_request)?;
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
    let project_attachments = Arc::clone(&state.project_attachments);
    let attachment_key = attachment.attachment_key.clone();
    let records_message = !payload.prompt.trim().is_empty()
        || !payload.storage_ids.is_empty()
        || payload.continuation_of_run_id.is_some();

    state
        .machines
        .register(&payload.user_id)
        .await
        .map_err(ApiError::bad_request)?;
    let auth_token_fetcher = state
        .native_auth
        .auth_token_fetcher_for_user(payload.user_id.clone());
    let settings = crate::cli_protocol::CliRunSettings {
        model: payload.selected_model.clone(),
        reasoning: payload.reasoning_effort.clone(),
        fast: payload.fast_mode,
    };
    if payload.execution_secret.is_none() {
        if let Some(saved) = state
            .run_recovery
            .saved(&payload.user_id, &payload.submission_id)
            .await
        {
            payload.execution_secret = saved.request.execution_secret;
        }
    }
    payload.workspace_path = workspace_path.clone();
    if payload.execution_secret.is_none() {
        payload.execution_secret = Some(crate::run_recovery::new_execution_secret());
    }
    let mut recovery = recovery.unwrap_or_else(|| {
        crate::run_recovery::RecoveryRecord::new(
            payload.clone(),
            workspace_access,
            allow_interaction,
        )
    });
    recovery.request.execution_secret = payload.execution_secret.clone();
    recovery.request.workspace_path = payload.workspace_path.clone();
    let recovery_guard = state
        .run_recovery
        .begin(recovery)
        .await
        .map_err(ApiError::internal)?;
    let request = RunAgentRequest {
        chatgpt_credentials: Some(state.chatgpt_credentials.for_user(payload.user_id.clone())),
        allow_interaction,
        cancellation,
        deployment_url: state.convex_deployment_url.clone(),
        auth_token_fetcher: auth_token_fetcher.clone(),
        execution_secret: payload
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
        installation_id: state.machine_identity.installation_id.clone(),
        continuation_of_run_id: payload.continuation_of_run_id,
        subagent_launcher: Some(crate::subagent_launcher::launcher(&state)),
        transcript_store: Some(Arc::clone(&state.transcript)),
    };

    let cleanup_request = request.clone();
    let command_sessions = Arc::clone(&state.command_sessions);
    let command_lifetime = Arc::clone(&state.lifetime);
    let command_machine_id = state.machine_identity.installation_id.clone();
    let command_auth = Arc::clone(&state.native_auth);
    let command_deployment = state.convex_deployment_url.clone();
    let live = Arc::clone(&state.live_completions);
    let transcript = Arc::clone(&state.transcript);
    let transcript_watchers = Arc::clone(&state.transcript_watchers);
    let artifact_watchers = Arc::clone(&state.artifact_watchers);
    let (start_result_sender, start_result_receiver) = oneshot::channel();

    // Detach the complete launch before waiting for its acknowledgement. Hyper
    // may drop this handler when the browser closes the tab; the executor must
    // still either run or durably reconcile the submitted run.
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
                match timeout(
                    AGENT_START_CLEANUP_TIMEOUT,
                    finalize_failed_start(cleanup_request, startup_error.clone()),
                )
                .await
                {
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
                    .with_history_scope(user_id.clone(), thread_id.clone(), command_machine_id)
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
                let prompt_part = run.prompt_part().cloned();
                let sent_at = prompt_part
                    .as_ref()
                    .map(|part| part.created_at.unwrap_or_else(crate::now_ms))
                    .or_else(|| records_message.then(crate::now_ms));
                if let Some(sent_at) = sent_at
                    && let Err(error) = project_attachments
                        .record_message_sent(&attachment_key, sent_at)
                        .await
                {
                    eprintln!(
                        "sprocket-server: failed to save project message recency for run {run_id}: {error:#}"
                    );
                }
                if let Some(prompt_part) = prompt_part {
                    match transcript
                        .append_parts(&user_id, &thread_id, std::slice::from_ref(&prompt_part))
                        .await
                    {
                        Ok(state) => {
                            transcript_watchers
                                .notify_local_update(
                                    &user_id,
                                    &thread_id,
                                    prompt_part.number + 1,
                                    state.stale,
                                )
                                .await;
                        }
                        Err(error) => {
                            eprintln!(
                                "sprocket-server: failed to update local transcript for run {run_id}: {error:#}"
                            );
                        }
                    }
                }
                let artifact_watch = if artifact_repository_key.is_empty() {
                    None
                } else {
                    Some(
                        artifact_watchers
                            .open(&user_id, &artifact_repository_key, &artifact_workspace_path)
                            .await,
                    )
                };
                let _ = start_result_sender.send(Ok((run_id.clone(), thread_id.clone())));
                let transcript_watch = transcript_watchers.open(&user_id, &thread_id).await;
                let result = run_agent(run, sessions, live, transcript).await;
                if let Some(output) = &output {
                    output.finish(result.as_ref().err().map(ToString::to_string));
                }
                if let Some(watch) = &artifact_watch {
                    if let Err(error) = watch.flush().await {
                        tracing::warn!("artifact sync after run {run_id} failed: {error:#}");
                    }
                }
                drop(artifact_watch);
                drop(transcript_watch);
                if let Err(error) = result {
                    eprintln!("sprocket-server: agent run failed: {error:#}");
                }
            }
            Err(error) => {
                let error = format!("{error:#}");
                if start_result_sender.send(Err(error.clone())).is_err() {
                    eprintln!("sprocket-server: detached agent launch failed: {error}");
                }
            }
        }
    });

    let (run_id, thread_id) = start_result_receiver
        .await
        .map_err(|_| {
            ApiError::internal_with(
                "failed to start agent run",
                anyhow!("agent launch task stopped unexpectedly"),
            )
        })?
        .map_err(|error| ApiError::internal_with("failed to start agent run", anyhow!(error)))?;
    Ok(RunStarted {
        run_id,
        thread_id,
        settings,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LiveCompletionWatchRequest {
    user_id: String,
    thread_id: String,
}

struct LiveSseStream {
    receiver: broadcast::Receiver<LiveCompletionWatchEvent>,
    hub: Arc<LiveCompletionHub>,
    thread_id: String,
}

async fn live_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(payload): Json<LiveCompletionWatchRequest>,
) -> Result<Sse<impl futures::Stream<Item = Result<Event, Infallible>>>, ApiError> {
    require_session_user(&state.auth, &headers, &jar, &payload.user_id)
        .await
        .map_err(ApiError::unauthorized)?;
    let hub = Arc::clone(&state.live_completions);
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
mod tests {
    use super::*;
    use uuid::Uuid;

    #[tokio::test]
    async fn command_endpoints_authenticate_and_keep_other_scopes_isolated() {
        use axum::body::Body;
        use axum::http::{Request, header};
        use sprocket_workspace::{WorkspaceCancellation, default_command_shell};
        use tower::ServiceExt;

        let root = std::env::temp_dir().join(format!("sprocket-command-routes-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let auth = crate::auth::AuthState::load(&root).unwrap();
        let (_, token) = auth.bootstrap_browser_session(true).await.unwrap();
        auth.bind_session_user(&token, "user").await.unwrap();
        let native_auth = crate::native_auth::NativeAuthManager::configured_for_test(
            crate::native_auth::NativeAuthConfig {
                workos_client_id: "client_test".into(),
            },
            crate::auth::desktop_login_callback_url(7731),
        );
        native_auth.authenticate_for_test("user").await;
        let state = AppState::for_test(
            auth,
            native_auth,
            root.clone(),
            true,
            crate::package_update::PackageUpdateManager::from_env(),
        );
        let sessions = state
            .command_sessions
            .for_run("user", "thread", root.clone(), root.join("logs"))
            .await;
        let started = sessions
            .exec_command(
                WorkspaceCancellation::new(),
                "sleep 5",
                ".",
                &default_command_shell(),
                Some(5_000),
                0,
                20_000,
            )
            .await
            .unwrap();
        let session_id = started.session_id.unwrap();
        let router = crate::build_router(state.clone(), None);
        let make_request = |path: &str, user: &str, thread: &str, authenticated: bool| {
            let mut body = serde_json::json!({ "userId": user, "threadId": thread });
            if path.ends_with("terminate") {
                body["sessionId"] = session_id.clone().into();
            }
            let mut builder = Request::builder()
                .method("POST")
                .uri(path)
                .header(header::HOST, "127.0.0.1:7731")
                .header(header::ORIGIN, "http://127.0.0.1:7731")
                .header(header::CONTENT_TYPE, "application/json");
            if authenticated {
                builder = builder.header(
                    header::COOKIE,
                    format!("{}={token}", crate::SESSION_COOKIE_NAME),
                );
            }
            builder.body(Body::from(body.to_string())).unwrap()
        };
        for path in ["/api/agent/commands", "/api/agent/commands/terminate"] {
            let response = router
                .clone()
                .oneshot(make_request(path, "user", "thread", false))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
            let response = router
                .clone()
                .oneshot(make_request(path, "other-user", "thread", true))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }
        let other_thread = router
            .clone()
            .oneshot(make_request(
                "/api/agent/commands/terminate",
                "user",
                "other-thread",
                true,
            ))
            .await
            .unwrap();
        assert_eq!(other_thread.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(other_thread.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&bytes).unwrap(),
            serde_json::json!({ "terminated": false })
        );
        let listed = router
            .clone()
            .oneshot(make_request("/api/agent/commands", "user", "thread", true))
            .await
            .unwrap();
        assert_eq!(listed.status(), StatusCode::OK);
        assert_eq!(listed.headers()[header::CACHE_CONTROL], "no-store");
        let bytes = axum::body::to_bytes(listed.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["commands"][0]["sessionId"], session_id);
        let terminated = router
            .oneshot(make_request(
                "/api/agent/commands/terminate",
                "user",
                "thread",
                true,
            ))
            .await
            .unwrap();
        assert_eq!(terminated.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(terminated.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&bytes).unwrap(),
            serde_json::json!({ "terminated": true })
        );
        state.command_sessions.stop_all().await;
        std::fs::remove_dir_all(root).unwrap();
    }

    fn request(json: serde_json::Value) -> RunAgentApiRequest {
        serde_json::from_value(json).expect("valid agent request")
    }

    fn base_request() -> serde_json::Value {
        serde_json::json!({
            "userId": "user-1",
            "submissionId": "submission-1",
            "prompt": "Build it",
            "storageIds": [],
            "selectedModel": "gpt-5.6-sol",
            "reasoningEffort": "medium",
            "fastMode": false,
            "workspacePath": "/workspace"
        })
    }

    #[test]
    fn accepts_fast_mode_requests() {
        let mut json = base_request();
        json["fastMode"] = true.into();
        assert!(request(json).fast_mode);
    }

    #[test]
    fn defaults_older_requests_to_spikonado() {
        assert_eq!(
            request(base_request()).completion_provider,
            CompletionProvider::Spikonado
        );
    }

    #[test]
    fn accepts_direct_openai_requests() {
        let mut json = base_request();
        json["completionProvider"] = "openai".into();
        assert_eq!(
            request(json).completion_provider,
            CompletionProvider::Openai
        );
    }

    #[test]
    fn accepts_chatgpt_subscription_requests() {
        let mut json = base_request();
        json["completionProvider"] = "chatgpt".into();
        assert_eq!(
            request(json).completion_provider,
            CompletionProvider::Chatgpt
        );
    }

    #[test]
    fn requires_fast_mode() {
        let mut json = base_request();
        json.as_object_mut().unwrap().remove("fastMode");
        json["serviceTier"] = "fast".into();
        assert!(serde_json::from_value::<RunAgentApiRequest>(json).is_err());
    }
}
