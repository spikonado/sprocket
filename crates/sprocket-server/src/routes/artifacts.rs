use std::collections::BTreeMap;
use std::convert::Infallible;
use std::time::Duration;

use anyhow::anyhow;
use axum::Json;
use axum::extract::State;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::routing::post;
use convex::Value;
use futures::stream::unfold;
use serde::Deserialize;
use tokio::sync::broadcast;
use tokio::time::timeout;

use crate::AppState;
use crate::artifact_watch::is_native_account_revoked;
use crate::routes::api_error::ApiError;
use crate::routes::session::{AuthorizedJson, UserScoped};

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

impl UserScoped for ArtifactWatchRequest {
    fn user_id(&self) -> &str {
        &self.user_id
    }
}

impl UserScoped for ArtifactDeleteRequest {
    fn user_id(&self) -> &str {
        &self.user_id
    }
}

pub fn routes() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/artifacts/watch", post(watch_handler))
        .route("/artifacts/delete", post(delete_handler))
}

async fn delete_handler(
    State(state): State<AppState>,
    AuthorizedJson(payload): AuthorizedJson<ArtifactDeleteRequest>,
) -> Result<Json<()>, ApiError> {
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
    bindings
        .delete_artifact(
            std::path::Path::new(&attachment.workspace_path),
            artifact_id,
        )
        .await
        .map_err(ApiError::internal)?;
    let args = BTreeMap::from([
        ("repositoryKey".into(), Value::String(repository_key.into())),
        ("artifactId".into(), Value::String(artifact_id.into())),
    ]);
    // Keep the store exclusive until Convex removes the artifact so a
    // concurrent save cannot recreate the file from the still-visible record.
    let result = timeout(AUTHORIZE_TIMEOUT, async {
        let client = state.convex_client_for(&payload.user_id).await?;
        client
            .mutate::<serde_json::Value>("artifacts:deleteArtifact", args)
            .await
    })
    .await;
    match result {
        Ok(Ok(_)) => Ok(Json(())),
        Ok(Err(error)) if is_native_account_revoked(&error) => Err(ApiError::unauthorized(error)),
        Ok(Err(error)) => Err(ApiError::bad_request(error)),
        Err(_) => Err(ApiError::bad_request(anyhow!(
            "artifact deletion timed out"
        ))),
    }
}

async fn watch_handler(
    State(state): State<AppState>,
    AuthorizedJson(payload): AuthorizedJson<ArtifactWatchRequest>,
) -> Result<Sse<impl futures::Stream<Item = Result<Event, Infallible>>>, ApiError> {
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
        (true, session.latest_event(), session),
        |(first, last, mut session)| async move {
            if first {
                if let Some(event) = last.clone() {
                    return encode_watch_event(event).map(|event| (event, (false, last, session)));
                }
            }
            loop {
                match session.receiver().recv().await {
                    Ok(event) if last.as_ref() == Some(&event) => continue,
                    Ok(event) => {
                        return encode_watch_event(event.clone())
                            .map(|encoded| (encoded, (false, Some(event), session)));
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        if let Some(event) = session.latest_event() {
                            if last.as_ref() == Some(&event) {
                                continue;
                            }
                            return encode_watch_event(event.clone())
                                .map(|encoded| (encoded, (false, Some(event), session)));
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
    async fn deletion_validates_scope_and_removes_local_file_even_when_cloud_fails() {
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
        native_auth.authenticate_for_test("alice").await;
        let mut state = AppState::for_test(
            auth,
            native_auth,
            data.path().to_path_buf(),
            true,
            crate::package_update::PackageUpdateManager::disabled(),
        );
        // Fail cloud initialization immediately without using the network.
        state.convex_deployment_url.clear();
        let bindings = state.artifact_watchers.bindings("alice", workspace.path());
        std::fs::write(workspace.path().join("notes.md"), "local source").unwrap();
        {
            let mut guard = bindings.lock().await.unwrap();
            guard
                .bind(sprocket_agent::artifact_bindings::ArtifactBinding {
                    registration_id: "registration".into(),
                    artifact_id: Some("artifact".into()),
                    local_path: "notes.md".into(),
                    content_hash: sprocket_agent::artifact_bindings::content_hash("local source"),
                })
                .unwrap();
            guard.persist().await.unwrap();
        }
        let app = routes().with_state(state.clone());
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
        assert_eq!(bindings.snapshot().await.unwrap().len(), 1);
        assert!(workspace.path().join("notes.md").exists());
        let attachment = state
            .project_attachments
            .attach(crate::project_attachments::AttachProjectRequest {
                workspace_path: workspace.path().to_str().unwrap().into(),
                replace_workspace_path: None,
            })
            .await
            .unwrap();
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/artifacts/delete")
                    .header("content-type", "application/json")
                    .header("authorization", format!("Bearer {token}"))
                    .body(Body::from(
                        serde_json::json!({
                            "userId": "alice", "repositoryKey": attachment.repository_key,
                            "workspacePath": attachment.workspace_path, "artifactId": "artifact",
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert!(bindings.snapshot().await.unwrap().is_empty());
        assert!(!workspace.path().join("notes.md").exists());
    }
}
