use super::*;
use axum::body::Body;
use axum::http::Request;
use tower::ServiceExt;

async fn fixture() -> (tempfile::TempDir, AppState, String, CliRunRequest) {
    let directory = tempfile::tempdir().unwrap();
    let auth = crate::auth::AuthState::load(directory.path()).unwrap();
    let (_, token) = auth.bootstrap(auth.pairing_credential()).await.unwrap();
    let native_auth = crate::native_auth::NativeAuthManager::configured_for_test(
        crate::native_auth::NativeAuthConfig {
            workos_client_id: "client_test".into(),
        },
        "http://127.0.0.1/callback".into(),
    );
    let state = AppState::for_test(
        auth,
        native_auth,
        directory.path().to_owned(),
        true,
        crate::package_update::PackageUpdateManager::disabled(),
    );
    let request = CliRunRequest {
        client_id: uuid::Uuid::new_v4().to_string(),
        prompt: "task".into(),
        directory: directory.path().display().to_string(),
        thread_id: None,
        model: None,
        reasoning: None,
        fast: None,
    };
    state.lifetime.connect(&request.client_id, &token).unwrap();
    (directory, state, token, request)
}

async fn call(
    state: &AppState,
    token: &str,
    operation: &str,
    body: &impl serde::Serialize,
    peer: &str,
) -> (StatusCode, serde_json::Value) {
    let response = crate::build_router(state.clone(), None)
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/cli/{operation}"))
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .extension(ConnectInfo(peer.parse::<SocketAddr>().unwrap()))
                .body(Body::from(serde_json::to_vec(body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let body = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .unwrap();
    (status, serde_json::from_slice(&body).unwrap())
}

#[tokio::test]
async fn concurrent_retries_recover_the_same_submission_and_reject_argument_changes() {
    let (_directory, state, token, request) = fixture().await;
    let client = state.lifetime.client(&request.client_id, &token).unwrap();
    {
        let mut submission = client.submission.lock().await;
        submission.request = Some(request.clone());
        submission.result = Some(Ok(RunStarted {
            run_id: "run".into(),
            thread_id: "thread".into(),
        }));
    }
    let (first, second) = tokio::join!(
        call(&state, &token, "run", &request, "127.0.0.1:1000"),
        call(&state, &token, "run", &request, "127.0.0.1:1001"),
    );
    assert_eq!(first, second);
    assert_eq!(first.0, StatusCode::OK);
    assert_eq!(first.1["runId"], "run");
    let mut changed = request;
    changed.prompt = "different task".into();
    assert_eq!(
        call(&state, &token, "run", &changed, "127.0.0.1:1000")
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn cancellation_before_submission_is_cached_and_release_invalidates_pairing() {
    let (_directory, state, token, request) = fixture().await;
    let client_request = CliClientRequest {
        client_id: request.client_id.clone(),
    };
    assert_eq!(
        call(&state, &token, "cancel", &client_request, "127.0.0.1:1000")
            .await
            .0,
        StatusCode::OK
    );
    let first = call(&state, &token, "run", &request, "127.0.0.1:1000").await;
    let second = call(&state, &token, "run", &request, "127.0.0.1:1000").await;
    assert_eq!(first, second);
    assert_eq!(first.0, StatusCode::BAD_REQUEST);
    assert!(first.1["error"].as_str().unwrap().contains("cancelled"));
    assert_eq!(
        call(&state, &token, "release", &client_request, "127.0.0.1:1000")
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &state,
            &token,
            "heartbeat",
            &client_request,
            "127.0.0.1:1000"
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn cli_control_requires_the_owning_local_session_and_matching_protocol() {
    let (_directory, state, token, request) = fixture().await;
    let client_request = CliClientRequest {
        client_id: request.client_id.clone(),
    };
    assert_eq!(
        call(
            &state,
            &token,
            "cancel",
            &client_request,
            "192.168.1.10:1000"
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (_, other_token) = state
        .auth
        .bootstrap(state.auth.pairing_credential())
        .await
        .unwrap();
    assert_eq!(
        call(
            &state,
            &other_token,
            "cancel",
            &client_request,
            "127.0.0.1:1000"
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        call(
            &state,
            &token,
            "connect",
            &CliConnectRequest {
                client_id: request.client_id,
                protocol_version: CLI_PROTOCOL_VERSION + 1,
                deployment_url: state.convex_deployment_url.clone(),
            },
            "127.0.0.1:1000"
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
}
