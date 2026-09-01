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
    AuthTokenFetcher, LiveCompletionHub, LiveCompletionWatchEvent, RunAgentRequest,
    finalize_failed_start, run_agent, start_agent_run,
};
use tokio::sync::broadcast;
use tokio::sync::oneshot;
use tokio::time::timeout;
use uuid::Uuid;

use crate::AppState;
use crate::auth::require_session;
use crate::routes::api_error::ApiError;

const AGENT_START_TIMEOUT: Duration = Duration::from_secs(20);
const AGENT_START_CLEANUP_TIMEOUT: Duration = Duration::from_secs(12);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunAgentApiRequest {
    auth_token: String,
    submission_id: String,
    thread_id: String,
    prompt: String,
    image_upload_ids: Vec<String>,
    selected_model: String,
    reasoning_effort: String,
    service_tier: String,
    workspace_path: String,
    #[serde(default)]
    continuation_of_run_id: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RunAgentStartResponse {
    run_id: String,
}

fn static_auth_token_fetcher(token: String) -> AuthTokenFetcher {
    Arc::new(move |_force_refresh| {
        let token = token.clone();
        Box::pin(async move {
            if token.trim().is_empty() {
                return Err(anyhow!("agent auth token is empty"));
            }
            Ok(token)
        })
    })
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
) -> Result<(StatusCode, Json<RunAgentStartResponse>), ApiError> {
    require_session(&state.auth, &headers, &jar)
        .await
        .map_err(ApiError::unauthorized)?;

    let workspace_path = state
        .project_attachments
        .workspace_path(&payload.workspace_path)
        .await
        .map_err(ApiError::bad_request)?;

    let auth_token_fetcher = static_auth_token_fetcher(payload.auth_token);
    let request = RunAgentRequest {
        deployment_url: state.convex_deployment_url.clone(),
        auth_token_fetcher: auth_token_fetcher.clone(),
        execution_secret: format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple()),
        submission_id: payload.submission_id,
        thread_id: payload.thread_id,
        prompt: payload.prompt,
        image_upload_ids: payload.image_upload_ids,
        selected_model: payload.selected_model,
        reasoning_effort: payload.reasoning_effort,
        service_tier: payload.service_tier,
        workspace_path,
        transcript_root: state.transcript.root(),
        installation_id: state.machine_identity.installation_id.clone(),
        process_session_id: state.machine_identity.process_session_id.clone(),
        machine_credential: state.machine_identity.credential.clone(),
        machine_credential_hash: state.machine_identity.credential_hash.clone(),
        machine_friendly_name: state.machine_identity.friendly_name.clone(),
        machine_platform: state.machine_identity.platform.clone(),
        machine_architecture: state.machine_identity.architecture.clone(),
        continuation_of_run_id: payload.continuation_of_run_id,
    };

    let cleanup_request = request.clone();
    let live = Arc::clone(&state.live_completions);
    let transcript = Arc::clone(&state.transcript);
    let transcript_watchers = Arc::clone(&state.transcript_watchers);
    let thread_id = request.thread_id.clone();
    let (start_result_sender, start_result_receiver) = oneshot::channel();

    // Detach the complete launch before waiting for its acknowledgement. Hyper
    // may drop this handler when the browser closes the tab; the executor must
    // still either run or durably reconcile the submitted run.
    tokio::spawn(async move {
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
            Ok(run) => {
                let run_id = run.run_id().to_string();
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
                let _ = start_result_sender.send(Ok(run_id));
                if let Err(error) = run_agent(run, live).await {
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

    let run_id = start_result_receiver
        .await
        .map_err(|_| {
            ApiError::internal_with(
                "failed to start agent run",
                anyhow!("agent launch task stopped unexpectedly"),
            )
        })?
        .map_err(|error| ApiError::internal_with("failed to start agent run", anyhow!(error)))?;
    Ok((StatusCode::ACCEPTED, Json(RunAgentStartResponse { run_id })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LiveCompletionWatchRequest {
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
    require_session(&state.auth, &headers, &jar)
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

    struct DropSignal(Arc<AtomicBool>);

    impl Drop for DropSignal {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    #[tokio::test]
    async fn static_fetcher_returns_the_launch_token_without_waiting() {
        let fetcher = static_auth_token_fetcher("token-1".to_string());
        assert_eq!(fetcher(false).await.expect("initial token"), "token-1");
        assert_eq!(
            timeout(Duration::from_millis(20), fetcher(true))
                .await
                .expect("forced refresh must be noninteractive")
                .expect("same launch token"),
            "token-1"
        );
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
