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
async fn reuses_a_running_dashboard_and_reports_its_exit() {
    let directory = tempfile::tempdir().unwrap();
    let manager = BrowserManager::new(directory.path().into()).unwrap();
    let mut statuses = manager.status_events();
    assert_eq!(statuses.next().await.unwrap().state, "installing");
    manager.use_test_dashboard(1234);
    assert_eq!(manager.start().state, "ready");
    assert_eq!(manager.port().unwrap(), 1234);
    assert_eq!(statuses.next().await.unwrap().state, "ready");

    let exiting = Command::new("true").kill_on_drop(true).spawn().unwrap();
    manager.supervise(Dashboard {
        child: exiting,
        port: 1235,
    });
    let status = loop {
        let status = statuses.next().await.unwrap();
        if status.state == "error" {
            break status;
        }
    };
    assert_eq!(status.error.as_deref(), Some(DASHBOARD_STOPPED));
    assert!(manager.port().is_err());
    manager.shutdown().await;
    assert_eq!(statuses.next().await.unwrap().state, "installing");
}
