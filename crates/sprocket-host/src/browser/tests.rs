use super::*;

#[test]
fn environment_trusts_the_os_certificate_store() {
    let directory = tempfile::tempdir().unwrap();
    let manager = BrowserManager::new(directory.path().into()).unwrap();
    let environment = manager.environment();
    assert!(
        environment
            .iter()
            .any(|(key, value)| key == "AGENT_BROWSER_USE_SYSTEM_CA" && value == "1")
    );
}

#[tokio::test]
async fn reuses_a_running_dashboard_and_rejects_a_stopped_one() {
    let directory = tempfile::tempdir().unwrap();
    let manager = BrowserManager::new(directory.path().into()).unwrap();
    manager.use_test_dashboard(1234).await;
    assert_eq!(manager.start().await.state, "ready");
    assert_eq!(manager.port().await.unwrap(), 1234);

    if let DashboardState::Ready(dashboard) = &mut *manager.dashboard.lock().await {
        dashboard.child.kill().await.unwrap();
    } else {
        panic!("dashboard is not running");
    }
    // Port lookup must detect the exit without waiting for a status poll.
    assert!(manager.port().await.is_err());
    let status = manager.status().await;
    assert_eq!(status.state, "error");
    assert!(status.error.unwrap().contains("dashboard stopped"));
    manager.shutdown().await;
}
