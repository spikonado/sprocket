use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, anyhow};
use axum::Json;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum_extra::extract::CookieJar;
use serde::Deserialize;
use sprocket_agent::{
    AuthTokenFetcher, RunAgentRequest, finalize_failed_start, run_agent, start_agent_run,
};
use tokio::sync::oneshot;
use tokio::time::timeout;
use uuid::Uuid;

use crate::AppState;
use crate::auth::require_session;

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
    workspace_session_id: String,
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
        .route(
            "/agent/commands/{thread_id}/{session_id}",
            delete(stop_command_handler),
        )
        .route("/agent/commands/{thread_id}", get(list_commands_handler))
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
        .workspace_sessions
        .workspace_path(&payload.workspace_session_id)
        .await
        .map_err(ApiError::bad_request)?;
    let workspace_root = sprocket_workspace::resolve_workspace_root(&workspace_path)
        .map_err(ApiError::bad_request)?;
    let command_sessions = state
        .command_sessions
        .for_thread(&payload.thread_id, &workspace_root)
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
        command_sessions,
    };

    let cleanup_request = request.clone();
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
                let _ = start_result_sender.send(Ok(run_id));
                if let Err(error) = run_agent(run).await {
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
        .map_err(|_| ApiError::internal(anyhow!("agent launch task stopped unexpectedly")))?
        .map_err(|error| ApiError::internal(anyhow!(error)))?;
    Ok((StatusCode::ACCEPTED, Json(RunAgentStartResponse { run_id })))
}

async fn stop_command_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Path((thread_id, session_id)): Path<(String, String)>,
) -> Result<StatusCode, ApiError> {
    require_session(&state.auth, &headers, &jar)
        .await
        .map_err(ApiError::unauthorized)?;
    state
        .command_sessions
        .stop_by_user(&thread_id, &session_id)
        .await
        .map_err(ApiError::not_found)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn list_commands_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Path(thread_id): Path<String>,
) -> Result<Json<Vec<sprocket_workspace::CommandSessionInfo>>, ApiError> {
    require_session(&state.auth, &headers, &jar)
        .await
        .map_err(ApiError::unauthorized)?;
    Ok(Json(
        state.command_sessions.available_sessions(&thread_id).await,
    ))
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

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn with_status(status: StatusCode, error: anyhow::Error) -> Self {
        Self {
            status,
            message: error.to_string(),
        }
    }

    fn unauthorized(error: anyhow::Error) -> Self {
        Self::with_status(StatusCode::UNAUTHORIZED, error)
    }

    fn bad_request(error: anyhow::Error) -> Self {
        Self::with_status(StatusCode::BAD_REQUEST, error)
    }

    fn not_found(error: anyhow::Error) -> Self {
        Self::with_status(StatusCode::NOT_FOUND, error)
    }

    fn internal(error: anyhow::Error) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: format!("failed to start agent run: {error:#}"),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(serde_json::json!({ "error": self.message })),
        )
            .into_response()
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
