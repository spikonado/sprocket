use super::*;

#[tokio::test]
async fn subscriptions_require_the_session_user() {
    let root = tempfile::tempdir().unwrap();
    let auth = crate::auth::AuthState::load(root.path()).unwrap();
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
        root.path().to_path_buf(),
        true,
        sprocket_host::package_update::PackageUpdateManager::disabled(),
    );
    let mut headers = HeaderMap::new();
    headers.insert(axum::http::header::HOST, "127.0.0.1:7731".parse().unwrap());
    headers.insert(
        axum::http::header::ORIGIN,
        "http://127.0.0.1:7731".parse().unwrap(),
    );
    headers.insert(
        axum::http::header::COOKIE,
        format!("{}={token}", crate::SESSION_COOKIE_NAME)
            .parse()
            .unwrap(),
    );
    let transcript = |user: &str| {
        serde_json::from_value::<Topic>(serde_json::json!({
            "kind": "transcript",
            "params": { "userId": user, "threadId": "thread" }
        }))
        .unwrap()
    };

    let rejected = open(&state, &headers, transcript("other-user"))
        .await
        .err()
        .expect("another user's transcript is rejected");
    assert_eq!(rejected.status(), StatusCode::UNAUTHORIZED);
    assert!(open(&state, &headers, transcript("user")).await.is_ok());

    let browser_status =
        serde_json::from_value::<Topic>(serde_json::json!({ "kind": "browserStatus" })).unwrap();
    let Ok(mut statuses) = open(&state, &headers, browser_status).await else {
        panic!("the session user can watch the browser status");
    };
    assert_eq!(
        statuses.next().await,
        Some(serde_json::json!({ "state": "installing", "error": null }))
    );
    let package_update =
        || serde_json::from_value::<Topic>(serde_json::json!({ "kind": "packageUpdate" })).unwrap();
    let Ok(mut updates) = open(&state, &headers, package_update()).await else {
        panic!("the session may watch package updates");
    };
    assert_eq!(updates.next().await.unwrap()["status"], "unavailable");
    let mut anonymous = headers.clone();
    anonymous.remove(axum::http::header::COOKIE);
    let rejected = open(&state, &anonymous, package_update())
        .await
        .err()
        .expect("package updates need a session");
    assert_eq!(rejected.status(), StatusCode::UNAUTHORIZED);
}

#[test]
fn parses_the_client_protocol() {
    let parse = |json: serde_json::Value| serde_json::from_value::<ClientMessage>(json).unwrap();

    assert!(matches!(
        parse(serde_json::json!({
            "type": "subscribe",
            "id": 1,
            "topic": { "kind": "transcript", "params": { "userId": "user", "threadId": "thread" } }
        })),
        ClientMessage::Subscribe {
            id: 1,
            topic: Topic::Transcript(_)
        }
    ));
    assert!(matches!(
        parse(
            serde_json::json!({ "type": "subscribe", "id": 2, "topic": { "kind": "authChanges" } })
        ),
        ClientMessage::Subscribe {
            id: 2,
            topic: Topic::AuthChanges
        }
    ));
    assert!(matches!(
        parse(serde_json::json!({ "type": "unsubscribe", "id": 2 })),
        ClientMessage::Unsubscribe { id: 2 }
    ));
}

#[test]
fn encodes_server_messages() {
    let Message::Text(text) = encode(&ServerMessage::Error {
        id: 3,
        status: 401,
        message: "authentication required".into(),
    }) else {
        panic!("expected a text message");
    };
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(text.as_str()).unwrap(),
        serde_json::json!({ "type": "error", "id": 3, "status": 401, "message": "authentication required" })
    );
}
