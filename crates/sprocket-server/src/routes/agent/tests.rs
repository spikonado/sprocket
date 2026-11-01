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
    let native_auth = sprocket_host::native_auth::NativeAuthManager::configured_for_test(
        sprocket_host::native_auth::NativeAuthConfig {
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
        sprocket_host::package_update::PackageUpdateManager::from_env(),
    );
    let sessions = state
        .host
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
    let path = "/api/agent/commands/terminate";
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
    let mut commands = command_events(
        &state,
        serde_json::from_value(serde_json::json!({ "userId": "user", "threadId": "thread" }))
            .unwrap(),
    );
    let listed = commands.next().await.unwrap();
    assert_eq!(listed[0].session_id, session_id);
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
    let listed = tokio::time::timeout(std::time::Duration::from_secs(5), commands.next())
        .await
        .unwrap()
        .unwrap();
    assert!(listed.is_empty());
    state.host.command_sessions.stop_all().await;
    std::fs::remove_dir_all(root).unwrap();
}
