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

const AUTHORIZE_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ArtifactWatchRequest {
    user_id: String,
    repository_key: String,
    workspace_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ArtifactDeleteRequest {
    user_id: String,
    repository_key: String,
    workspace_path: String,
    artifact_id: String,
}

pub fn routes() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/artifacts/watch", post(watch_handler))
        .route("/artifacts/delete", post(delete_handler))
}

async fn delete_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(payload): Json<ArtifactDeleteRequest>,
) -> Result<Json<()>, ApiError> {
    state
        .require_session_user(&headers, &jar, &payload.user_id)
        .await?;
    let repository_key = payload.repository_key.trim();
    let workspace_path = payload.workspace_path.trim();
    let artifact_id = payload.artifact_id.trim();
    if repository_key.is_empty() || workspace_path.is_empty() || artifact_id.is_empty() {
        return Err(ApiError::bad_request(anyhow!(
            "repositoryKey, workspacePath, and artifactId are required"
        )));
    }
    let attachment = state
        .project_attachments
        .require_matching_workspace(workspace_path, repository_key)
        .await
        .map_err(ApiError::bad_request)?;
    let store = state.artifact_watchers.bindings(
        &payload.user_id,
        std::path::Path::new(&attachment.workspace_path),
    );
    let mut bindings = store.lock().await.map_err(ApiError::internal)?;
    let args = BTreeMap::from([
        ("repositoryKey".into(), Value::String(repository_key.into())),
        ("artifactId".into(), Value::String(artifact_id.into())),
    ]);
    let result = timeout(AUTHORIZE_TIMEOUT, async {
        let client = state.convex_client_for(&payload.user_id).await?;
        client
            .mutate::<serde_json::Value>("artifacts:deleteArtifact", args)
            .await
    })
    .await;
    match result {
        Ok(Ok(_)) => {}
        Ok(Err(error)) if is_native_account_revoked(&error) => {
            return Err(ApiError::unauthorized(error));
        }
        Ok(Err(error)) => return Err(ApiError::bad_request(error)),
        Err(_) => {
            return Err(ApiError::bad_request(anyhow!(
                "artifact deletion timed out"
            )));
        }
    }
    if bindings.remove(artifact_id) {
        bindings.persist().await.map_err(ApiError::internal)?;
    }
    Ok(Json(()))
}

async fn watch_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(payload): Json<ArtifactWatchRequest>,
) -> Result<Sse<impl futures::Stream<Item = Result<Event, Infallible>>>, ApiError> {
    state
        .require_session_user(&headers, &jar, &payload.user_id)
        .await?;
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
    authorize_watch_project(&state, &payload.user_id, repository_key).await?;
    let session = state
        .artifact_watchers
        .open(&payload.user_id, repository_key, &attachment.workspace_path)
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

async fn authorize_watch_project(
    state: &AppState,
    user_id: &str,
    repository_key: &str,
) -> Result<(), ApiError> {
    let mut args = BTreeMap::new();
    args.insert(
        "repositoryKey".to_string(),
        Value::String(repository_key.to_string()),
    );
    let query = timeout(AUTHORIZE_TIMEOUT, async {
        let client = state.convex_client_for(user_id).await?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    #[tokio::test]
    async fn deletion_requires_the_session_account_and_an_attached_workspace() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let auth = crate::auth::AuthState::load(data.path()).unwrap();
        let (_, token) = auth.bootstrap_browser_session(true).await.unwrap();
        auth.bind_session_user(&token, "alice").await.unwrap();
        let native_auth = crate::native_auth::NativeAuthManager::configured_for_test(
            crate::native_auth::NativeAuthConfig {
                workos_client_id: "client_test".into(),
            },
            crate::auth::desktop_login_callback_url(7731),
        );
        let state = AppState::for_test(
            auth,
            native_auth,
            data.path().to_path_buf(),
            true,
            crate::package_update::PackageUpdateManager::disabled(),
        );
        let app = routes().with_state(state);
        for (user_id, session, expected) in [
            ("alice", None, StatusCode::UNAUTHORIZED),
            ("bob", Some(token.as_str()), StatusCode::UNAUTHORIZED),
            ("alice", Some(token.as_str()), StatusCode::BAD_REQUEST),
        ] {
            let mut request = Request::builder()
                .method("POST")
                .uri("/artifacts/delete")
                .header("content-type", "application/json");
            if let Some(session) = session {
                request = request.header("authorization", format!("Bearer {session}"));
            }
            let response = app.clone().oneshot(request.body(Body::from(serde_json::json!({
                "userId": user_id, "repositoryKey": "repo", "workspacePath": workspace.path(),
                "artifactId": "artifact",
            }).to_string())).unwrap()).await.unwrap();
            assert_eq!(response.status(), expected);
        }
    }
}
