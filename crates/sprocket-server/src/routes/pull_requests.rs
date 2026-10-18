use axum::Json;
use axum::routing::post;
use serde::Deserialize;
use sprocket_workspace::github::pull_requests::{
    PullRequestRef, PullRequestStatus, refresh_states,
};

use crate::AppState;
use crate::routes::session::{AuthorizedJson, UserScoped};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StatesRequest {
    user_id: String,
    pull_requests: Vec<PullRequestRef>,
}

impl UserScoped for StatesRequest {
    fn user_id(&self) -> &str {
        &self.user_id
    }
}

pub fn routes() -> axum::Router<AppState> {
    axum::Router::new().route("/pull-requests/states", post(states_handler))
}

/// Reads PR states with this machine's GitHub credentials, which never leave it.
/// PRs GitHub can't answer for are left out, so the caller keeps its last state.
async fn states_handler(
    AuthorizedJson(payload): AuthorizedJson<StatesRequest>,
) -> Json<Vec<PullRequestStatus>> {
    let fetched = refresh_states(&payload.user_id, &payload.pull_requests).await;
    for (host, error) in &fetched.failures {
        tracing::debug!("skipping linked PRs on {host}: {error}");
    }
    Json(fetched.states)
}
