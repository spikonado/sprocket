use axum::Json;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum_extra::extract::CookieJar;
use serde::Deserialize;
use sprocket_agent::{RunAgentRequest, run_agent};

use crate::AppState;
use crate::auth::require_session;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunAgentApiRequest {
    auth_token: Option<String>,
    guest_id: Option<String>,
    submission_id: String,
    thread_id: String,
    prompt: String,
    selected_model: String,
    reasoning_effort: String,
    workspace_session_id: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RunAgentAcceptedResponse {
    accepted: bool,
}

pub fn routes() -> axum::Router<AppState> {
    axum::Router::new().route("/agent/run", post(run_agent_handler))
}

async fn run_agent_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(payload): Json<RunAgentApiRequest>,
) -> Result<(StatusCode, Json<RunAgentAcceptedResponse>), ApiError> {
    require_session(&state.auth, &headers, &jar)
        .await
        .map_err(ApiError::unauthorized)?;

    let workspace_path = state
        .workspace_sessions
        .workspace_path(&payload.workspace_session_id)
        .await
        .map_err(ApiError::bad_request)?;

    let request = RunAgentRequest {
        deployment_url: state.convex_deployment_url.clone(),
        auth_token: payload.auth_token,
        guest_id: payload.guest_id,
        submission_id: payload.submission_id,
        thread_id: payload.thread_id,
        prompt: payload.prompt,
        selected_model: payload.selected_model,
        reasoning_effort: payload.reasoning_effort,
        workspace_path,
    };

    tokio::spawn(async move {
        if let Err(error) = run_agent(request).await {
            eprintln!("sprocket-server: agent run failed: {error:#}");
        }
    });

    Ok((
        StatusCode::ACCEPTED,
        Json(RunAgentAcceptedResponse { accepted: true }),
    ))
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn unauthorized(error: anyhow::Error) -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            message: error.to_string(),
        }
    }

    fn bad_request(error: anyhow::Error) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: error.to_string(),
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
