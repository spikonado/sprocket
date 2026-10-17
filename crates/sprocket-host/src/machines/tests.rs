use super::*;

#[tokio::test(start_paused = true)]
async fn registration_recovers_after_a_crashed_process_lease_expires() {
    let started = tokio::time::Instant::now();
    let mut attempts = 0;
    let registered = register_when_available(&CancellationToken::new(), || {
        attempts += 1;
        let result = if attempts == 1 {
            serde_json::from_value::<RegistrationResult>(serde_json::json!({
                "status": "busy",
                "retryAfterMs": 90001.0,
            }))
            .unwrap()
        } else {
            serde_json::from_value(serde_json::json!({
                "status": "registered",
                "machineId": "machine-a",
                "userId": "user-a",
            }))
            .unwrap()
        };
        std::future::ready(Ok(result))
    })
    .await
    .unwrap();

    assert_eq!(attempts, 2);
    assert_eq!(started.elapsed(), Duration::from_millis(90_001));
    assert_eq!(registered.machine_id, "machine-a");
    assert_eq!(registered.user_id, "user-a");
}

#[tokio::test(start_paused = true)]
async fn registration_does_not_wait_forever_for_a_live_process() {
    let started = tokio::time::Instant::now();
    let mut attempts = 0;
    let result = register_when_available(&CancellationToken::new(), || {
        attempts += 1;
        std::future::ready(Ok(RegistrationResult::Busy {
            retry_after_ms: 90_001,
        }))
    })
    .await;

    assert!(
        result
            .err()
            .unwrap()
            .to_string()
            .contains("Close that process")
    );
    assert_eq!(attempts, 2);
    assert_eq!(started.elapsed(), REGISTRATION_TIMEOUT);
}

#[tokio::test(start_paused = true)]
async fn registration_does_not_retry_other_errors() {
    let started = tokio::time::Instant::now();
    let mut attempts = 0;
    let result = register_when_available(&CancellationToken::new(), || {
        attempts += 1;
        std::future::ready(Err(anyhow::anyhow!("authentication failed")))
    })
    .await;

    assert_eq!(result.err().unwrap().to_string(), "authentication failed");
    assert_eq!(attempts, 1);
    assert_eq!(started.elapsed(), Duration::ZERO);
}

#[tokio::test(start_paused = true)]
async fn shutdown_interrupts_registration_waiting_for_a_stale_lease() {
    let shutdown = CancellationToken::new();
    let task_shutdown = shutdown.clone();
    let started = tokio::time::Instant::now();
    let (attempted, attempt_received) = tokio::sync::oneshot::channel();
    let registration = tokio::spawn(async move {
        let mut attempted = Some(attempted);
        register_when_available(&task_shutdown, || {
            attempted.take().unwrap().send(()).unwrap();
            std::future::ready(Ok(RegistrationResult::Busy {
                retry_after_ms: 90_001,
            }))
        })
        .await
    });

    attempt_received.await.unwrap();
    shutdown.cancel();
    let error = registration.await.unwrap().err().unwrap();
    assert!(error.to_string().contains("shutting down"));
    assert_eq!(started.elapsed(), Duration::ZERO);
}

fn manager_for_test() -> (std::path::PathBuf, Arc<MachineManager>) {
    let dir = std::env::temp_dir().join(format!("sprocket-machine-{}", uuid::Uuid::new_v4()));
    let identity = Arc::new(MachineIdentity::load(&dir).expect("identity"));
    let native_auth = NativeAuthManager::configured_for_test(
        crate::native_auth::NativeAuthConfig {
            workos_client_id: "client_test".to_string(),
        },
        "http://127.0.0.1/callback".to_string(),
    );
    (
        dir,
        MachineManager::new("not a valid URL".into(), native_auth, identity),
    )
}

#[tokio::test]
async fn shutdown_rejects_late_registration_before_network_io() {
    let (dir, manager) = manager_for_test();

    manager.shutdown(false).await;
    let error = manager
        .register("user-a")
        .await
        .expect_err("registration after shutdown must fail");
    assert!(error.to_string().contains("shutting down"));

    let _ = tokio::fs::remove_dir_all(dir).await;
}

#[tokio::test(start_paused = true)]
async fn registration_for_one_account_does_not_block_other_accounts() {
    let (dir, manager) = manager_for_test();
    let account = manager.account_lock("user-a", false).await.unwrap();
    let guard = account.lock().await;
    let mut waiting = Box::pin(manager.register("user-a"));
    assert!(futures::poll!(&mut waiting).is_pending());

    let result = timeout(Duration::from_secs(1), manager.register("user-b"))
        .await
        .expect("another account must not wait for user-a's registration");
    assert!(result.is_err(), "invalid deployment must fail registration");

    drop(waiting);
    drop(guard);
    let _ = tokio::fs::remove_dir_all(dir).await;
}

#[tokio::test]
async fn failed_registration_keeps_an_existing_presence() {
    let (dir, manager) = manager_for_test();
    {
        let mut accounts = manager.accounts.lock().await;
        accounts.insert(
            "user-a".into(),
            AccountPresence {
                heartbeat: tokio::spawn(std::future::pending()),
            },
        );
    }

    manager
        .register("user-a")
        .await
        .expect_err("registration still authenticates with Convex");
    {
        let accounts = manager.accounts.lock().await;
        let presence = accounts.get("user-a").expect("presence");
        assert!(
            !presence.heartbeat.is_finished(),
            "reuse must keep the existing heartbeat"
        );
        presence.heartbeat.abort();
    }

    let _ = tokio::fs::remove_dir_all(dir).await;
}

#[tokio::test]
async fn failed_heartbeat_drops_cached_presence() {
    let (dir, manager) = manager_for_test();
    {
        let mut accounts = manager.accounts.lock().await;
        accounts.insert(
            "user-a".into(),
            AccountPresence {
                heartbeat: tokio::spawn(std::future::pending()),
            },
        );
    }

    manager
        .heartbeat("user-a")
        .await
        .expect_err("invalid deployment must fail heartbeat");
    assert!(manager.accounts.lock().await.get("user-a").is_none());
    manager
        .register("user-a")
        .await
        .expect_err("cleared presence must register with Convex");

    let _ = tokio::fs::remove_dir_all(dir).await;
}
