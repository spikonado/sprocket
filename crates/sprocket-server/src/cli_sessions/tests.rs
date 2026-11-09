use super::*;

fn cli_sessions(
    host: &Arc<HostLifetime>,
    temporary: bool,
) -> (tempfile::TempDir, Arc<AuthState>, CliSessions) {
    let directory = tempfile::tempdir().unwrap();
    let auth = AuthState::load(directory.path()).unwrap();
    let native_auth = NativeAuthManager::configured_for_test(
        sprocket_host::native_auth::NativeAuthConfig {
            workos_client_id: "client_test".into(),
        },
        "http://127.0.0.1/callback".into(),
    );
    let sessions = CliSessions::new(Arc::clone(host), native_auth, Arc::clone(&auth), temporary);
    (directory, auth, sessions)
}

#[tokio::test]
async fn temporary_server_waits_for_all_clients_and_runs() {
    let host = HostLifetime::new();
    let (_directory, _auth, lifetime) = cli_sessions(&host, true);
    let first = uuid::Uuid::new_v4().to_string();
    let second = uuid::Uuid::new_v4().to_string();
    lifetime.connect(&first, "a").await.unwrap();
    lifetime.connect(&second, "b").await.unwrap();
    let run = host.run_guard().unwrap();
    lifetime.release(&first, "a").await.unwrap();
    lifetime.tick(Instant::now()).await;
    assert!(!host.is_stopping());
    lifetime.release(&second, "b").await.unwrap();
    lifetime.tick(Instant::now()).await;
    assert!(!host.is_stopping());
    drop(run);
    lifetime.tick(Instant::now()).await;
    assert!(host.is_stopping());
    assert!(lifetime.connect(&first, "a").await.is_err());
}

#[tokio::test]
async fn running_commands_keep_temporary_server_alive_until_exit_or_termination() {
    use sprocket_workspace::{CommandSessionManager, default_command_shell};

    for terminate in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().to_path_buf();
        let host = HostLifetime::new();
        let (_auth_directory, _auth, lifetime) = cli_sessions(&host, true);
        let client_id = uuid::Uuid::new_v4().to_string();
        lifetime.connect(&client_id, "client").await.unwrap();
        let run_guard = host.run_guard().unwrap();
        let command_lifetime = Arc::clone(&host);
        let sessions = CommandSessionManager::new(root.clone(), root.join("logs"))
            .with_lifetime_guard_factory(move || command_lifetime.run_guard());
        let started = sessions
            .exec_command(
                WorkspaceCancellation::new(),
                "while [ ! -f release ]; do sleep 0.01; done",
                ".",
                &default_command_shell(),
                Some(5_000),
                0,
            )
            .await
            .unwrap();
        let session_id = started.session_id.unwrap();
        lifetime.release(&client_id, "client").await.unwrap();
        drop(run_guard);
        lifetime.tick(Instant::now()).await;
        assert!(!host.is_stopping());
        if terminate {
            assert!(sessions.terminate_command(&session_id).await);
        } else {
            std::fs::write(root.join("release"), "").unwrap();
        }
        let finished = sessions
            .poll_command(WorkspaceCancellation::new(), &session_id, 5_000, 0)
            .await
            .unwrap();
        assert!(!finished.result.running);
        assert_eq!(finished.result.success, !terminate);
        lifetime.tick(Instant::now()).await;
        assert!(host.is_stopping());
        sessions.stop_all().await;
    }
}

#[tokio::test]
async fn failed_command_spawn_releases_temporary_server_guard() {
    use sprocket_workspace::CommandSessionManager;

    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().to_path_buf();
    let host = HostLifetime::new();
    let (_auth_directory, _auth, lifetime) = cli_sessions(&host, true);
    let client_id = uuid::Uuid::new_v4().to_string();
    lifetime.connect(&client_id, "client").await.unwrap();
    let command_lifetime = Arc::clone(&host);
    let sessions = CommandSessionManager::new(root.clone(), root.join("logs"))
        .with_lifetime_guard_factory(move || command_lifetime.run_guard());

    let missing_shell = root.join("missing-shell");
    let error = sessions
        .exec_command(
            WorkspaceCancellation::new(),
            "unused",
            ".",
            missing_shell.to_str().unwrap(),
            None,
            0,
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("failed to start shell"));
    assert!(sessions.running_commands().await.is_empty());
    lifetime.release(&client_id, "client").await.unwrap();
    lifetime.tick(Instant::now()).await;
    assert!(host.is_stopping());
}

#[tokio::test]
async fn lost_clients_end_their_run_and_auth_session_but_not_the_shared_server() {
    let host = HostLifetime::new();
    let (_directory, auth, lifetime) = cli_sessions(&host, false);
    let id = uuid::Uuid::new_v4().to_string();
    lifetime.connect(&id, "a").await.unwrap();
    assert!(auth.session_state(Some("a")).await.authenticated);
    let client = lifetime.client(&id, "a").unwrap();
    assert!(lifetime.client(&id, "b").is_err());
    lifetime.tick(Instant::now() + CLIENT_GRACE).await;
    assert!(!host.is_stopping());
    assert!(client.cancellation.is_cancelled());
    assert!(!auth.session_state(Some("a")).await.authenticated);
    assert!(lifetime.client(&id, "a").is_err());
}
