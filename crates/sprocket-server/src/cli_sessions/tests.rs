use super::*;

#[test]
fn temporary_server_waits_for_all_clients_and_runs() {
    let lifetime = ServerLifetime::new(true);
    let first = uuid::Uuid::new_v4().to_string();
    let second = uuid::Uuid::new_v4().to_string();
    lifetime.connect(&first, "a").unwrap();
    lifetime.connect(&second, "b").unwrap();
    let run = lifetime.run_guard().unwrap();
    lifetime.release(&first, "a").unwrap();
    assert!(!lifetime.tick(Instant::now()).0);
    lifetime.release(&second, "b").unwrap();
    assert!(!lifetime.tick(Instant::now()).0);
    drop(run);
    assert!(lifetime.tick(Instant::now()).0);
    assert!(lifetime.connect(&first, "a").is_err());
}

#[tokio::test]
async fn running_commands_keep_temporary_server_alive_until_exit_or_termination() {
    use sprocket_workspace::{CommandSessionManager, default_command_shell};

    for terminate in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().to_path_buf();
        let lifetime = ServerLifetime::new(true);
        let client_id = uuid::Uuid::new_v4().to_string();
        lifetime.connect(&client_id, "client").unwrap();
        let run_guard = lifetime.run_guard().unwrap();
        let command_lifetime = Arc::clone(&lifetime);
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
                20_000,
            )
            .await
            .unwrap();
        let session_id = started.session_id.unwrap();
        // Even an immediate CLI disconnect and run completion cannot leave
        // a gap between the run guard and process ownership.
        lifetime.release(&client_id, "client").unwrap();
        drop(run_guard);
        assert!(!lifetime.tick(Instant::now()).0);
        assert!(!lifetime.shutdown.is_cancelled());
        if terminate {
            assert!(sessions.terminate_command(&session_id).await);
        } else {
            std::fs::write(root.join("release"), "").unwrap();
        }
        let finished = sessions
            .poll_command(WorkspaceCancellation::new(), &session_id, 5_000)
            .await
            .unwrap();
        assert!(!finished.result.running);
        assert_eq!(finished.result.success, !terminate);
        assert!(lifetime.tick(Instant::now()).0);
        assert!(lifetime.shutdown.is_cancelled());
        sessions.stop_all().await;
    }
}

#[test]
fn shutdown_rejects_new_process_lifetime_guards() {
    let lifetime = ServerLifetime::new(false);
    lifetime.shutdown.cancel();
    assert!(lifetime.run_guard().is_err());
}

#[tokio::test]
async fn failed_command_spawn_releases_temporary_server_guard() {
    use sprocket_workspace::CommandSessionManager;

    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().to_path_buf();
    let lifetime = ServerLifetime::new(true);
    let client_id = uuid::Uuid::new_v4().to_string();
    lifetime.connect(&client_id, "client").unwrap();
    let command_lifetime = Arc::clone(&lifetime);
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
            20_000,
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("failed to start shell"));
    assert!(sessions.running_commands().await.is_empty());
    lifetime.release(&client_id, "client").unwrap();
    assert!(lifetime.tick(Instant::now()).0);
}

#[test]
fn lost_clients_cancel_their_run_but_not_the_shared_server() {
    let lifetime = ServerLifetime::new(false);
    let id = uuid::Uuid::new_v4().to_string();
    lifetime.connect(&id, "a").unwrap();
    let client = lifetime.client(&id, "a").unwrap();
    assert!(lifetime.client(&id, "b").is_err());
    let (stop, expired) = lifetime.tick(Instant::now() + CLIENT_GRACE);
    assert!(!stop);
    assert_eq!(expired, ["a"]);
    assert!(client.cancellation.is_cancelled());
    assert!(lifetime.client(&id, "a").is_err());
}
