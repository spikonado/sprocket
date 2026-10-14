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

fn request(json: serde_json::Value) -> RunAgentApiRequest {
    serde_json::from_value(json).expect("valid agent request")
}

fn base_request() -> serde_json::Value {
    serde_json::json!({
        "userId": "user-1",
        "submissionId": "submission-1",
        "prompt": "Build it",
        "storageIds": [],
        "selectedModel": "gpt-5.6-sol",
        "reasoningEffort": "medium",
        "fastMode": false,
        "workspacePath": "/workspace"
    })
}

#[test]
fn accepts_fast_mode_requests() {
    let mut json = base_request();
    json["fastMode"] = true.into();
    assert!(request(json).fast_mode);
}

#[test]
fn defaults_older_requests_to_spikonado() {
    assert_eq!(
        request(base_request()).completion_provider,
        CompletionProvider::Spikonado
    );
}

#[test]
fn accepts_direct_openai_requests() {
    let mut json = base_request();
    json["completionProvider"] = "openai".into();
    assert_eq!(
        request(json).completion_provider,
        CompletionProvider::Openai
    );
}

#[test]
fn accepts_chatgpt_subscription_requests() {
    let mut json = base_request();
    json["completionProvider"] = "chatgpt".into();
    assert_eq!(
        request(json).completion_provider,
        CompletionProvider::Chatgpt
    );
}

#[test]
fn requires_fast_mode() {
    let mut json = base_request();
    json.as_object_mut().unwrap().remove("fastMode");
    json["serviceTier"] = "fast".into();
    assert!(serde_json::from_value::<RunAgentApiRequest>(json).is_err());
}
