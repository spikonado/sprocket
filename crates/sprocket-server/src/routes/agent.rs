use std::convert::Infallible;
use std::sync::Arc;

use axum::Json;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::routing::post;
use axum_extra::extract::CookieJar;
use futures::StreamExt;
use futures::stream::{self, unfold};
use serde::Deserialize;
use sprocket_agent::{LiveCompletionHub, LiveCompletionWatchEvent};
use tokio::sync::broadcast;

use crate::AppState;
use crate::agent_launch::{RunAgentApiRequest, WorkspaceAccess, launch_agent};
use crate::auth::require_session_user;
use crate::cli_protocol::RunStarted;
use crate::routes::api_error::ApiError;

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
}
