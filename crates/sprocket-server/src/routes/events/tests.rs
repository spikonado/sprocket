use super::*;
use tokio_tungstenite::tungstenite::Message as ClientFrame;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

async fn state() -> (AppState, String, tempfile::TempDir) {
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
    (state, token, root)
}

#[tokio::test]
async fn subscriptions_require_the_session_user() {
    let (state, token, _root) = state().await;
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

async fn next_message<S>(socket: &mut S) -> serde_json::Value
where
    S: futures::Stream<Item = Result<ClientFrame, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    loop {
        let frame = tokio::time::timeout(Duration::from_secs(5), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        if let ClientFrame::Text(text) = frame {
            return serde_json::from_str(text.as_str()).unwrap();
        }
    }
}

#[tokio::test]
async fn serves_subscriptions_over_a_same_origin_socket_until_the_session_ends() {
    let (state, token, _root) = state().await;
    let auth = std::sync::Arc::clone(&state.auth);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = crate::build_router(state, None);
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
        .unwrap()
    });
    let request = |origin: String| {
        let mut request = format!("ws://{address}/api/events")
            .into_client_request()
            .unwrap();
        let headers = request.headers_mut();
        headers.insert(
            axum::http::header::COOKIE,
            format!("{}={token}", crate::SESSION_COOKIE_NAME)
                .parse()
                .unwrap(),
        );
        headers.insert(axum::http::header::ORIGIN, origin.parse().unwrap());
        request
    };

    assert!(matches!(
        tokio_tungstenite::connect_async(request("http://evil.example".into())).await,
        Err(tokio_tungstenite::tungstenite::Error::Http(response))
            if response.status() == StatusCode::FORBIDDEN
    ));

    let (mut socket, _) = tokio_tungstenite::connect_async(request(format!("http://{address}")))
        .await
        .unwrap();
    for (id, kind) in [(1, "packageUpdate"), (2, "browserStatus")] {
        let subscribe =
            serde_json::json!({ "type": "subscribe", "id": id, "topic": { "kind": kind } });
        socket
            .send(ClientFrame::Text(subscribe.to_string().into()))
            .await
            .unwrap();
    }
    let mut snapshots = HashMap::new();
    while snapshots.len() < 2 {
        let message = next_message(&mut socket).await;
        assert_eq!(message["type"], "event");
        snapshots
            .entry(message["id"].as_u64().unwrap())
            .or_insert(message["data"].clone());
    }
    assert_eq!(snapshots[&1]["status"], "unavailable");
    assert_eq!(
        snapshots[&2],
        serde_json::json!({ "state": "installing", "error": null })
    );

    socket
        .send(ClientFrame::Text(
            serde_json::json!({ "type": "unsubscribe", "id": 1 })
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    auth.end_session(&token).await.unwrap();
    let revoked = loop {
        let message = next_message(&mut socket).await;
        if message["type"] != "event" {
            break message;
        }
    };
    assert_eq!(revoked["status"], 401);
    assert_eq!(revoked["id"], 2);
    assert!(
        tokio::time::timeout(Duration::from_millis(1500), socket.next())
            .await
            .is_err()
    );
    server.abort();
}
