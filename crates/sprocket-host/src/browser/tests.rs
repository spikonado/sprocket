use super::*;

#[tokio::test]
async fn reuses_a_running_dashboard_and_rejects_a_stopped_one() {
    let directory = tempfile::tempdir().unwrap();
    let manager = BrowserManager::new(directory.path().into()).unwrap();
    manager.use_test_dashboard("user", 1234).await;
    assert_eq!(manager.start("user").await.state, "ready");
    assert_eq!(manager.port("user").await.unwrap(), 1234);

    {
        let mut active = manager.active.lock().await;
        let Some(DashboardState::Ready(dashboard)) = owned_by(&mut active, "user") else {
            panic!("dashboard is not running");
        };
        dashboard.child.kill().await.unwrap();
    }
    // Port lookup must detect the exit without waiting for a status poll.
    assert!(manager.port("user").await.is_err());
    let status = manager.status("user").await;
    assert_eq!(status.state, "error");
    assert!(status.error.unwrap().contains("dashboard stopped"));
    manager.shutdown().await;
}

#[tokio::test]
async fn starting_for_another_user_stops_the_previous_dashboard() {
    let directory = tempfile::tempdir().unwrap();
    let manager = BrowserManager::new(directory.path().into()).unwrap();
    manager.use_test_dashboard("first", 1234).await;
    let pid = {
        let mut active = manager.active.lock().await;
        let Some(DashboardState::Ready(dashboard)) = owned_by(&mut active, "first") else {
            panic!("dashboard is not running");
        };
        dashboard.child.id().unwrap() as libc::pid_t
    };

    assert_eq!(manager.start("second").await.state, "installing");
    assert!(manager.port("first").await.is_err());
    let stopped = tokio::time::timeout(Duration::from_secs(5), async {
        while unsafe { libc::kill(pid, 0) } == 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    assert!(stopped.is_ok(), "previous dashboard is still running");
    manager.shutdown().await;
}
