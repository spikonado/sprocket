use std::convert::Infallible;
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, anyhow};
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
    LiveCompletionHub, LiveCompletionWatchEvent, RunAgentRequest, finalize_failed_start, run_agent,
    start_agent_run,
};
use tokio::sync::broadcast;
use tokio::sync::oneshot;
use tokio::time::timeout;
use uuid::Uuid;

use crate::AppState;
use crate::auth::require_session_user;
use crate::cli_protocol::RunStarted;
use crate::routes::api_error::ApiError;

const AGENT_START_TIMEOUT: Duration = Duration::from_secs(20);
const AGENT_START_CLEANUP_TIMEOUT: Duration = Duration::from_secs(12);

struct FinishedOnDrop(Option<Arc<sprocket_agent::RunOutput>>);

impl Drop for FinishedOnDrop {
    fn drop(&mut self) {
        if let Some(finished) = &self.0 {
            finished.finish(None);
        }
    }
}

#[derive(Debug, Deserialize)]
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
    pub reasoning_effort: String,
    pub fast_mode: bool,
    pub workspace_path: String,
    #[serde(default)]
    pub continuation_of_run_id: Option<String>,
}

pub fn routes() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/agent/run", post(run_agent_handler))
        .route("/agent/live", post(live_handler))
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
    let started = launch_agent(state, payload, true, Default::default(), None).await?;
    Ok((StatusCode::ACCEPTED, Json(started)))
}

pub(crate) async fn launch_agent(
    state: AppState,
    payload: RunAgentApiRequest,
    allow_interaction: bool,
    cancellation: sprocket_workspace::WorkspaceCancellation,
    output: Option<Arc<sprocket_agent::RunOutput>>,
) -> Result<RunStarted, ApiError> {
    let guard = state.lifetime.run_guard().map_err(ApiError::bad_request)?;
    state
        .native_auth
        .require_user(&payload.user_id)
        .await
        .map_err(ApiError::unauthorized)?;

    let attachment = state
        .project_attachments
        .require_available_workspace(&payload.workspace_path)
        .await
        .map_err(ApiError::bad_request)?;
    let workspace_path = attachment.workspace_path.clone();
    let artifact_workspace_path = workspace_path.clone();
    let artifact_repository_key = payload
        .repository_key
        .as_deref()
        .map(str::trim)
        .filter(|key| crate::project_attachments::repository_key_matches(&attachment, key))
        .unwrap_or(attachment.repository_key.as_str())
        .to_string();

    state
        .machines
        .register(&payload.user_id)
        .await
        .map_err(ApiError::bad_request)?;
    let auth_token_fetcher = state
        .native_auth
        .auth_token_fetcher_for_user(payload.user_id.clone());
    let request = RunAgentRequest {
        allow_interaction,
        cancellation,
        deployment_url: state.convex_deployment_url.clone(),
        auth_token_fetcher: auth_token_fetcher.clone(),
        execution_secret: format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple()),
        submission_id: payload.submission_id,
        thread_id: payload.thread_id.unwrap_or_default(),
        repository_key: payload.repository_key,
        prompt: payload.prompt,
        storage_ids: payload.storage_ids,
        selected_model: payload.selected_model,
        reasoning_effort: payload.reasoning_effort,
        fast_mode: payload.fast_mode,
        workspace_path,
        installation_id: state.machine_identity.installation_id.clone(),
        continuation_of_run_id: payload.continuation_of_run_id,
    };

    let cleanup_request = request.clone();
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
        let _finished = FinishedOnDrop(output.clone());
        let run = await_agent_start(
            start_agent_run(request),
            AGENT_START_TIMEOUT,
            AGENT_START_CLEANUP_TIMEOUT,
            move |startup_error| {
                let mut cleanup_request = cleanup_request;
                cleanup_request.auth_token_fetcher = auth_token_fetcher;
                finalize_failed_start(cleanup_request, startup_error)
            },
        )
        .await;

        match run {
            Ok(mut run) => {
                if let Some(output) = &output {
                    run.observe_output(Arc::clone(output), Arc::clone(&transcript))
                        .await;
                }
                let run_id = run.run_id().to_string();
                let thread_id = run.thread_id().to_string();
                let user_id = run.user_id().to_string();
                if let Some(prompt_part) = run.prompt_part().cloned() {
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
                            .open(
                                &user_id,
                                &artifact_repository_key,
                                &artifact_workspace_path,
                                (!thread_id.is_empty()).then_some(thread_id.as_str()),
                            )
                            .await,
                    )
                };
                let _ = start_result_sender.send(Ok((run_id.clone(), thread_id.clone())));
                let mut transcript_watch = transcript_watchers.open(&user_id, &thread_id).await;
                let result = run_agent(run, live, transcript).await;
                if let Some(output) = &output {
                    output.finish(result.as_ref().err().map(ToString::to_string));
                }
                match tokio::time::timeout(
                    std::time::Duration::from_secs(30),
                    transcript_watch.wait_for_run(&run_id),
                )
                .await
                {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => {
                        tracing::warn!("transcript sync after run {run_id} failed: {error:#}")
                    }
                    Err(_) => tracing::warn!(
                        "transcript sync after run {run_id} timed out; it will resume when reopened"
                    ),
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
    Ok(RunStarted { run_id, thread_id })
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

async fn await_agent_start<F, T, C, CF>(
    startup: F,
    startup_timeout: Duration,
    cleanup_timeout: Duration,
    cleanup: C,
) -> anyhow::Result<T>
where
    F: Future<Output = anyhow::Result<T>>,
    C: FnOnce(String) -> CF,
    CF: Future<Output = anyhow::Result<()>>,
{
    let result = timeout(startup_timeout, startup)
        .await
        .context("timed out starting agent run")
        .and_then(|result| result);

    match result {
        Ok(started) => Ok(started),
        Err(error) => {
            let startup_error = format!("{error:#}");
            let cleanup_result = timeout(cleanup_timeout, cleanup(startup_error.clone())).await;
            match cleanup_result {
                Ok(Ok(())) => Err(error),
                Ok(Err(cleanup_error)) => Err(anyhow!(
                    "{startup_error}; additionally failed to reconcile the startup: {cleanup_error:#}"
                )),
                Err(_) => Err(anyhow!(
                    "{startup_error}; additionally timed out reconciling the startup"
                )),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};

    use super::*;

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
    fn requires_fast_mode() {
        let mut json = base_request();
        json.as_object_mut().unwrap().remove("fastMode");
        json["serviceTier"] = "fast".into();
        assert!(serde_json::from_value::<RunAgentApiRequest>(json).is_err());
    }

    struct DropSignal(Arc<AtomicBool>);

    impl Drop for DropSignal {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    #[tokio::test]
    async fn timed_out_startup_reconciles_before_returning() {
        let dropped = Arc::new(AtomicBool::new(false));
        let drop_signal = DropSignal(dropped.clone());
        let startup = async move {
            let _drop_signal = drop_signal;
            std::future::pending::<anyhow::Result<()>>().await
        };
        let reconciled = Arc::new(AtomicBool::new(false));
        let cleanup_reconciled = reconciled.clone();

        let error = await_agent_start(
            startup,
            Duration::from_millis(1),
            Duration::from_secs(1),
            move |_| async move {
                cleanup_reconciled.store(true, Ordering::SeqCst);
                Ok(())
            },
        )
        .await
        .expect_err("startup should time out");

        assert!(error.to_string().contains("timed out starting agent run"));
        assert!(dropped.load(Ordering::SeqCst));
        assert!(reconciled.load(Ordering::SeqCst));
    }
}
