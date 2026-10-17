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
            .bind(sprocket_workspace::artifact_bindings::ArtifactBinding {
                registration_id: "registration".into(),
                artifact_id: Some("artifact".into()),
                local_path: "notes.md".into(),
                content_hash: sprocket_workspace::artifact_bindings::content_hash("local source"),
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
