use std::collections::BTreeMap;
use std::convert::Infallible;
use std::time::Duration;

use anyhow::anyhow;
use axum::Json;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::routing::post;
use axum_extra::extract::CookieJar;
use convex::Value;
use futures::stream::unfold;
use serde::Deserialize;
use tokio::sync::broadcast;
use tokio::time::timeout;

use crate::AppState;
use crate::artifact_watch::is_native_account_revoked;
use crate::routes::api_error::ApiError;
use crate::transcript_client::UserConvexClient;

const AUTHORIZE_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ArtifactWatchRequest {
    user_id: String,
    repository_key: String,
    workspace_path: String,
    #[serde(default)]
    thread_id: Option<String>,
}

pub fn routes() -> axum::Router<AppState> {
    axum::Router::new().route("/artifacts/watch", post(watch_handler))
}

async fn require_session_user(
    state: &AppState,
    headers: &HeaderMap,
    jar: &CookieJar,
    user_id: &str,
) -> Result<(), ApiError> {
    crate::auth::require_session_user(&state.auth, headers, jar, user_id)
        .await
        .map_err(ApiError::unauthorized)?;
    state
        .native_auth
        .require_user(user_id)
        .await
        .map_err(ApiError::unauthorized)
}

fn normalize_thread_id(thread_id: Option<&str>) -> Option<&str> {
    thread_id.map(str::trim).filter(|id| !id.is_empty())
}

async fn watch_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(payload): Json<ArtifactWatchRequest>,
) -> Result<Sse<impl futures::Stream<Item = Result<Event, Infallible>>>, ApiError> {
    require_session_user(&state, &headers, &jar, &payload.user_id).await?;
    let repository_key = payload.repository_key.trim();
    let workspace_path = payload.workspace_path.trim();
    if repository_key.is_empty() || workspace_path.is_empty() {
        return Err(ApiError::bad_request(anyhow!(
            "repositoryKey and workspacePath are required"
        )));
    }
    let attachment = state
        .project_attachments
        .require_matching_workspace(workspace_path, repository_key)
        .await
        .map_err(ApiError::bad_request)?;
    let thread_id = normalize_thread_id(payload.thread_id.as_deref());
    authorize_watch_scope(&state, &payload.user_id, repository_key, thread_id).await?;
    let session = state
        .artifact_watchers
        .open(
            &payload.user_id,
            repository_key,
            &attachment.workspace_path,
            thread_id,
        )
        .await;
    let stream = unfold(
        (session.latest_event(), session),
        |(initial, mut session)| async move {
            if let Some(event) = initial {
                return encode_watch_event(event).map(|event| (event, (None, session)));
            }
            loop {
                match session.receiver().recv().await {
                    Ok(event) => {
                        return encode_watch_event(event).map(|event| (event, (None, session)));
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        if let Some(event) = session.latest_event() {
                            return encode_watch_event(event).map(|event| (event, (None, session)));
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => return None,
                }
            }
        },
    );
    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}

async fn authorize_watch_scope(
    state: &AppState,
    user_id: &str,
    repository_key: &str,
    thread_id: Option<&str>,
) -> Result<(), ApiError> {
    let mut args = BTreeMap::new();
    args.insert(
        "repositoryKey".to_string(),
        Value::String(repository_key.to_string()),
    );
    if let Some(thread_id) = thread_id {
        args.insert("threadId".to_string(), Value::String(thread_id.to_string()));
    }
    let query = timeout(AUTHORIZE_TIMEOUT, async {
        let client = UserConvexClient::connect_with_fetcher(
            &state.convex_deployment_url,
            state
                .native_auth
                .auth_token_fetcher_for_user(user_id.to_string()),
        )
        .await?;
        client
            .query::<serde_json::Value>("artifacts:getArtifactState", args)
            .await
    })
    .await;
    match query {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(error)) if is_native_account_revoked(&error) => Err(ApiError::unauthorized(error)),
        Ok(Err(error)) => Err(ApiError::bad_request(error)),
        Err(_) => Err(ApiError::bad_request(anyhow!(
            "artifact authorization timed out"
        ))),
    }
}

fn encode_watch_event(
    event: crate::artifact_watch::ArtifactWatchEvent,
) -> Option<Result<Event, Infallible>> {
    Event::default().json_data(event).ok().map(Ok)
}
