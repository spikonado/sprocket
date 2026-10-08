use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode};
use tower::ServiceExt;

use super::*;

#[tokio::test]
async fn workspace_search_requires_session_and_returns_completion_entries() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    std::fs::create_dir(workspace.path().join("src")).unwrap();
    std::fs::write(workspace.path().join("src/main.rs"), "fn main() {}").unwrap();
    let auth = crate::auth::AuthState::load(data.path()).unwrap();
    let (_, token) = auth.bootstrap_browser_session(true).await.unwrap();
    auth.bind_session_user(&token, "test-user").await.unwrap();
    let native_auth = crate::native_auth::NativeAuthManager::configured_for_test(
        crate::native_auth::NativeAuthConfig {
            workos_client_id: "client_test".to_string(),
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
    let payload =
        serde_json::json!({"workspacePath": workspace.path(), "query": "src"}).to_string();
    let request = |body: String, token: Option<&str>| {
        let mut builder = Request::builder()
            .method("POST")
            .uri("/workspace/search")
            .header("content-type", "application/json");
        if let Some(token) = token {
            builder = builder.header("authorization", format!("Bearer {token}"));
        }
        builder.body(Body::from(body)).unwrap()
    };
    let denied = app
        .clone()
        .oneshot(request(payload.clone(), None))
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);
    let oversized = serde_json::json!({"workspacePath": workspace.path(), "query": "x".repeat(MAX_QUERY_CHARS + 1)}).to_string();
    let invalid = app
        .clone()
        .oneshot(request(oversized, Some(&token)))
        .await
        .unwrap();
    assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let response = app
            .clone()
            .oneshot(request(payload.clone(), Some(&token)))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), 65536).await.unwrap();
        let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
        if value["scanning"] == false {
            let entries = value["entries"].as_array().unwrap();
            assert!(
                entries
                    .iter()
                    .any(|entry| entry["path"] == "src" && entry["kind"] == "directory")
            );
            assert!(
                entries
                    .iter()
                    .any(|entry| entry["path"] == "src/main.rs" && entry["kind"] == "file")
            );
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "workspace scan timed out"
        );
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
}
