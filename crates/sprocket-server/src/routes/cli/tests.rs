use super::*;
use axum::body::Body;
use axum::http::Request;
use tower::ServiceExt;

#[tokio::test]
async fn signed_bootstrap_and_cli_sessions_cannot_be_replayed_after_server_restart() {
    let (directory, mut state, _, existing) = fixture().await;
    let challenge = "fresh-challenge";
    let (status, discovered) = call(
        &state,
        "",
        "discovery",
        &crate::PairingProofRequest {
            challenge: challenge.into(),
        },
        "127.0.0.1:1000",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let discovered: CliDiscovery = serde_json::from_value(discovered).unwrap();
    assert!(crate::verify_pairing_proof(
        state.auth.pairing_credential(),
        &cli_discovery_message(
            challenge,
            &discovered.instance_id,
            &discovered.http_base_url
        ),
        &discovered.proof
    ));
    let mut request = CliBootstrapRequest {
        client: CliConnectRequest {
            client_id: uuid::Uuid::new_v4().to_string(),
            client_version: sprocket_workspace::SPROCKET_VERSION.to_string(),
            deployment_url: state.convex_deployment_url.clone(),
        },
        session_token: uuid::Uuid::new_v4().to_string(),
        proof: Vec::new(),
    };
    request.proof = state
        .auth
        .pairing_proof(&cli_bootstrap_message(
            &discovered.instance_id,
            &discovered.http_base_url,
            &request,
        ))
        .unwrap();
    let (status, accepted) = call(&state, "", "bootstrap", &request, "127.0.0.1:1000").await;
    assert_eq!(status, StatusCode::OK);
    let accepted: CliBootstrapResponse = serde_json::from_value(accepted).unwrap();
    assert!(crate::verify_pairing_proof(
        state.auth.pairing_credential(),
        &cli_bootstrap_response_message(
            &discovered.instance_id,
            &discovered.http_base_url,
            &request
        ),
        &accepted.proof
    ));
    assert!(
        state
            .auth
            .session_state(Some(&request.session_token))
            .await
            .authenticated
    );
    let mut incompatible = CliBootstrapRequest {
        client: CliConnectRequest {
            client_id: uuid::Uuid::new_v4().to_string(),
            client_version: "999.0.0".into(),
            deployment_url: state.convex_deployment_url.clone(),
        },
        session_token: uuid::Uuid::new_v4().to_string(),
        proof: Vec::new(),
    };
    incompatible.proof = state
        .auth
        .pairing_proof(&cli_bootstrap_message(
            &discovered.instance_id,
            &discovered.http_base_url,
            &incompatible,
        ))
        .unwrap();
    assert_eq!(
        call(&state, "", "bootstrap", &incompatible, "127.0.0.1:1000")
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    state.auth.bind_all_sessions(Some("user")).await.unwrap();
    assert!(
        !std::fs::read_to_string(directory.path().join("sessions.json"))
            .unwrap()
            .contains(&request.session_token)
    );
    request.client.client_id = existing.client_id;
    assert_eq!(
        call(&state, "", "bootstrap", &request, "127.0.0.1:1000")
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    state.auth = crate::auth::AuthState::load(directory.path()).unwrap();
    assert_ne!(state.auth.instance_id, discovered.instance_id);
    assert!(
        !state
            .auth
            .session_state(Some(&request.session_token))
            .await
            .authenticated
    );
    assert_eq!(
        call(&state, "", "bootstrap", &request, "127.0.0.1:1000")
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
}

async fn fixture() -> (tempfile::TempDir, AppState, String, CliClientRequest) {
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
    let request = CliClientRequest {
        client_id: uuid::Uuid::new_v4().to_string(),
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
async fn cli_control_requires_the_owning_local_session_and_matching_version() {
    let (_directory, state, token, request) = fixture().await;
    assert_eq!(
        call(&state, &token, "heartbeat", &request, "192.168.1.10:1000")
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
            "heartbeat",
            &request,
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
                client_version: "999.0.0".into(),
                deployment_url: state.convex_deployment_url.clone(),
            },
            "127.0.0.1:1000"
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
}
