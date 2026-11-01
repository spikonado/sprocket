use super::*;
use futures::StreamExt;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

struct TempDir(PathBuf);

impl TempDir {
    fn new(prefix: &str) -> Self {
        let path = std::env::temp_dir().join(format!("{prefix}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn write_helper(dir: &Path, body: &str) -> (PathBuf, PathBuf) {
    let script = dir.join("update-api.sh");
    fs::write(&script, format!("#!/bin/sh\nset -eu\n{body}\n")).unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
    (PathBuf::from("/bin/sh"), script)
}

async fn wait_until_settled(manager: &Arc<PackageUpdateManager>) -> PackageUpdateSnapshot {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let snapshot = manager.status().await;
        if snapshot.status != UpdateStatus::Installing {
            return snapshot;
        }
        if tokio::time::Instant::now() >= deadline {
            return snapshot;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn disabled_manager_never_spawns() {
    let dir = TempDir::new("sprocket-update-disabled");
    let (node, script) = write_helper(
        dir.path(),
        r#"echo spawned >> "$(dirname "$0")/calls"
echo '{"status":"idle","currentVersion":"1.0.0","version":null,"error":null,"method":"package"}'"#,
    );
    let _ = (node, script);
    let manager = PackageUpdateManager::disabled();
    let snapshot = manager.status().await;
    assert_eq!(snapshot.status, UpdateStatus::Unavailable);
    assert_eq!(snapshot.method, UpdateMethod::Package);
    assert!(!dir.path().join("calls").exists());
    let snapshot = manager.install().await;
    assert_eq!(snapshot.status, UpdateStatus::Unavailable);
    assert!(!dir.path().join("calls").exists());
}

#[tokio::test]
async fn check_uses_fixed_helper_args() {
    let dir = TempDir::new("sprocket-update-check-args");
    let (node, script) = write_helper(
        dir.path(),
        r#"printf '%s\n' "$1" >> "$(dirname "$0")/calls"
echo '{"status":"available","currentVersion":"1.0.0","version":"1.1.0","error":null,"method":"package"}'"#,
    );
    let manager = PackageUpdateManager::with_helper(node, script);
    let snapshot = manager.status().await;
    assert_eq!(snapshot.status, UpdateStatus::Available);
    assert_eq!(snapshot.current_version, "1.0.0");
    assert_eq!(snapshot.version.as_deref(), Some("1.1.0"));
    assert_eq!(snapshot.method, UpdateMethod::Package);
    assert_eq!(
        fs::read_to_string(dir.path().join("calls")).unwrap(),
        "check\n"
    );
}

#[tokio::test]
async fn install_uses_fixed_helper_args_and_persists() {
    let dir = TempDir::new("sprocket-update-install-args");
    let (node, script) = write_helper(
        dir.path(),
        r#"printf '%s\n' "$1" >> "$(dirname "$0")/calls"
echo '{"status":"installed","currentVersion":"1.1.0","version":"1.1.0","error":null,"method":"package","message":"restart required"}'"#,
    );
    let manager = PackageUpdateManager::with_helper(node, script);
    let snapshot = manager.install().await;
    assert_eq!(snapshot.status, UpdateStatus::Installing);
    let snapshot = wait_until_settled(&manager).await;
    assert_eq!(snapshot.status, UpdateStatus::Installed);
    assert_eq!(snapshot.current_version, "1.1.0");
    assert_eq!(snapshot.message.as_deref(), Some("restart required"));
    let again = manager.status().await;
    assert_eq!(again.status, UpdateStatus::Installed);
    let install_again = manager.install().await;
    assert_eq!(install_again.status, UpdateStatus::Installed);
    assert_eq!(
        fs::read_to_string(dir.path().join("calls")).unwrap(),
        "install\n"
    );
}

#[tokio::test]
async fn successful_checks_are_cached() {
    let dir = TempDir::new("sprocket-update-cache-ok");
    let (node, script) = write_helper(
        dir.path(),
        r#"printf x >> "$(dirname "$0")/calls"
echo '{"status":"idle","currentVersion":"1.0.0","version":null,"error":null,"method":"package"}'"#,
    );
    let manager = PackageUpdateManager::with_helper_and_timeouts(
        node,
        script,
        Duration::from_millis(250),
        Duration::from_millis(250),
        Duration::from_secs(5),
        Duration::from_secs(5),
    );
    assert_eq!(manager.status().await.status, UpdateStatus::Idle);
    assert_eq!(manager.status().await.status, UpdateStatus::Idle);
    assert_eq!(fs::read_to_string(dir.path().join("calls")).unwrap(), "x");
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(manager.status().await.status, UpdateStatus::Idle);
    assert_eq!(fs::read_to_string(dir.path().join("calls")).unwrap(), "xx");
}

#[tokio::test]
async fn watch_checks_on_subscribe_and_pushes_install_progress() {
    let dir = TempDir::new("sprocket-update-watch");
    let (node, script) = write_helper(
        dir.path(),
        r#"printf '%s\n' "$1" >> "$(dirname "$0")/calls"
if [ "$1" = check ]; then
  echo '{"status":"available","currentVersion":"1.0.0","version":"1.1.0","error":null,"method":"package"}'
else
  echo '{"status":"installed","currentVersion":"1.1.0","version":"1.1.0","error":null,"method":"package"}'
fi"#,
    );
    let manager = PackageUpdateManager::with_helper(node, script);
    let mut updates = manager.watch();
    assert_eq!(next_status(&mut updates).await, UpdateStatus::Idle);
    assert_eq!(next_status(&mut updates).await, UpdateStatus::Available);
    manager.install().await;
    assert_eq!(next_status(&mut updates).await, UpdateStatus::Installing);
    assert_eq!(next_status(&mut updates).await, UpdateStatus::Installed);
    assert_eq!(
        fs::read_to_string(dir.path().join("calls")).unwrap(),
        "check\ninstall\n"
    );
}

async fn next_status(updates: &mut BoxStream<'static, PackageUpdateSnapshot>) -> UpdateStatus {
    tokio::time::timeout(Duration::from_secs(5), updates.next())
        .await
        .unwrap()
        .unwrap()
        .status
}

#[tokio::test]
async fn failed_checks_are_cached_briefly() {
    let dir = TempDir::new("sprocket-update-cache-err");
    let (node, script) = write_helper(
        dir.path(),
        r#"printf x >> "$(dirname "$0")/calls"
echo '{"status":"error","currentVersion":"1.0.0","version":null,"error":"registry down","method":"package"}'
exit 1"#,
    );
    let manager = PackageUpdateManager::with_helper_and_timeouts(
        node,
        script,
        Duration::from_secs(60),
        Duration::from_millis(250),
        Duration::from_secs(5),
        Duration::from_secs(5),
    );
    let first = manager.status().await;
    assert_eq!(first.status, UpdateStatus::Error);
    assert_eq!(first.error.as_deref(), Some("registry down"));
    assert_eq!(manager.status().await.status, UpdateStatus::Error);
    assert_eq!(fs::read_to_string(dir.path().join("calls")).unwrap(), "x");
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(manager.status().await.status, UpdateStatus::Error);
    assert_eq!(fs::read_to_string(dir.path().join("calls")).unwrap(), "xx");
}

#[tokio::test]
async fn concurrent_checks_share_one_helper() {
    let dir = TempDir::new("sprocket-update-concurrent");
    let (node, script) = write_helper(
        dir.path(),
        r#"printf x >> "$(dirname "$0")/calls"
sleep 0.3
echo '{"status":"available","currentVersion":"1.0.0","version":"1.2.0","error":null,"method":"package"}'"#,
    );
    let manager = PackageUpdateManager::with_helper(node, script);
    let a = {
        let manager = Arc::clone(&manager);
        tokio::spawn(async move { manager.status().await })
    };
    let b = {
        let manager = Arc::clone(&manager);
        tokio::spawn(async move { manager.status().await })
    };
    let a = a.await.unwrap();
    let b = b.await.unwrap();
    assert_eq!(a.status, UpdateStatus::Available);
    assert_eq!(b.status, UpdateStatus::Available);
    assert_eq!(fs::read_to_string(dir.path().join("calls")).unwrap(), "x");
}

#[tokio::test]
async fn dropped_status_waiter_does_not_start_another_helper() {
    let dir = TempDir::new("sprocket-update-disconnect");
    let (node, script) = write_helper(
        dir.path(),
        r#"printf x >> "$(dirname "$0")/calls"
sleep 0.4
echo '{"status":"idle","currentVersion":"1.0.0","version":null,"error":null,"method":"package"}'"#,
    );
    let manager = PackageUpdateManager::with_helper(node, script);
    let dropped = {
        let manager = Arc::clone(&manager);
        tokio::spawn(async move { manager.status().await })
    };
    tokio::time::sleep(Duration::from_millis(80)).await;
    dropped.abort();
    let snapshot = manager.status().await;
    assert_eq!(snapshot.status, UpdateStatus::Idle);
    assert_eq!(fs::read_to_string(dir.path().join("calls")).unwrap(), "x");
}

#[tokio::test]
async fn status_during_install_returns_installing_without_a_second_spawn() {
    let dir = TempDir::new("sprocket-update-installing");
    let (node, script) = write_helper(
        dir.path(),
        r#"printf '%s\n' "$1" >> "$(dirname "$0")/calls"
sleep 0.4
echo '{"status":"installed","currentVersion":"1.1.0","version":"1.1.0","error":null,"method":"package"}'"#,
    );
    let manager = PackageUpdateManager::with_helper(node, script);
    let snapshot = manager.install().await;
    assert_eq!(snapshot.status, UpdateStatus::Installing);
    assert_eq!(manager.status().await.status, UpdateStatus::Installing);
    let installed = wait_until_settled(&manager).await;
    assert_eq!(installed.status, UpdateStatus::Installed);
    assert_eq!(
        fs::read_to_string(dir.path().join("calls")).unwrap(),
        "install\n"
    );
}

#[tokio::test]
async fn concurrent_installs_coalesce_instead_of_rerunning() {
    let dir = TempDir::new("sprocket-update-coalesce");
    let (node, script) = write_helper(
        dir.path(),
        r#"printf '%s\n' "$1" >> "$(dirname "$0")/calls"
sleep 0.3
echo '{"status":"error","currentVersion":"1.0.0","version":null,"error":"failed","method":"package"}'
exit 1"#,
    );
    let manager = PackageUpdateManager::with_helper(node, script);
    let first = manager.install().await;
    let second = manager.install().await;
    assert_eq!(first.status, UpdateStatus::Installing);
    assert_eq!(second.status, UpdateStatus::Installing);
    let settled = wait_until_settled(&manager).await;
    assert_eq!(settled.status, UpdateStatus::Error);
    assert_eq!(
        fs::read_to_string(dir.path().join("calls")).unwrap(),
        "install\n"
    );
    let retry = manager.install().await;
    assert_eq!(retry.status, UpdateStatus::Installing);
    let _ = wait_until_settled(&manager).await;
    assert_eq!(
        fs::read_to_string(dir.path().join("calls")).unwrap(),
        "install\ninstall\n"
    );
}

#[tokio::test]
async fn install_error_preserves_available_version() {
    let dir = TempDir::new("sprocket-update-keep-version");
    let (node, script) = write_helper(
        dir.path(),
        r#"if [ "$1" = check ]; then
  echo '{"status":"available","currentVersion":"1.0.0","version":"1.1.0","error":null,"method":"package"}'
else
  echo '{"status":"error","currentVersion":"1.0.0","version":null,"error":"npm failed","method":"package"}'
  exit 1
fi"#,
    );
    let manager = PackageUpdateManager::with_helper(node, script);
    let checked = manager.status().await;
    assert_eq!(checked.status, UpdateStatus::Available);
    assert_eq!(checked.version.as_deref(), Some("1.1.0"));
    let installing = manager.install().await;
    assert_eq!(installing.status, UpdateStatus::Installing);
    assert_eq!(installing.version.as_deref(), Some("1.1.0"));
    let failed = wait_until_settled(&manager).await;
    assert_eq!(failed.status, UpdateStatus::Error);
    assert_eq!(failed.version.as_deref(), Some("1.1.0"));
    assert_eq!(failed.current_version, "1.0.0");
}

#[tokio::test]
async fn timeout_covers_orphans_holding_stdout() {
    let dir = TempDir::new("sprocket-update-orphan-pipe");
    let (node, script) = write_helper(
        dir.path(),
        r#"(sleep 5) >&1 &
echo '{"status":"idle","currentVersion":"1.0.0","version":null,"error":null,"method":"package"}'
exit 0"#,
    );
    let manager = PackageUpdateManager::with_helper_and_timeouts(
        node,
        script,
        SUCCESS_CHECK_TTL,
        FAILED_CHECK_TTL,
        Duration::from_millis(200),
        Duration::from_millis(200),
    );
    let snapshot = manager.status().await;
    assert_eq!(snapshot.status, UpdateStatus::Error);
    assert_eq!(snapshot.error.as_deref(), Some("update helper timed out"));
}

#[tokio::test]
async fn nonzero_exit_without_json_becomes_error() {
    let dir = TempDir::new("sprocket-update-bad-exit");
    let (node, script) = write_helper(
        dir.path(),
        r#"echo boom >&2
exit 2"#,
    );
    let manager = PackageUpdateManager::with_helper(node, script);
    let snapshot = manager.status().await;
    assert_eq!(snapshot.status, UpdateStatus::Error);
    assert!(
        snapshot
            .error
            .as_deref()
            .unwrap_or("")
            .contains("update helper exited with an error")
    );
}

#[tokio::test]
async fn helper_timeout_becomes_error() {
    let dir = TempDir::new("sprocket-update-timeout");
    let (node, script) = write_helper(
        dir.path(),
        r#"sleep 5
echo '{"status":"idle","currentVersion":"1.0.0","version":null,"error":null,"method":"package"}'"#,
    );
    let manager = PackageUpdateManager::with_helper_and_timeouts(
        node,
        script,
        SUCCESS_CHECK_TTL,
        FAILED_CHECK_TTL,
        Duration::from_millis(100),
        Duration::from_millis(100),
    );
    let snapshot = manager.status().await;
    assert_eq!(snapshot.status, UpdateStatus::Error);
    assert_eq!(snapshot.error.as_deref(), Some("update helper timed out"));
}

#[tokio::test]
async fn oversized_helper_output_becomes_error() {
    let dir = TempDir::new("sprocket-update-overflow");
    let (node, script) = write_helper(
        dir.path(),
        r#"dd if=/dev/zero bs=1024 count=8192 2>/dev/null"#,
    );
    let manager = PackageUpdateManager::with_helper_and_timeouts(
        node,
        script,
        SUCCESS_CHECK_TTL,
        FAILED_CHECK_TTL,
        Duration::from_secs(2),
        Duration::from_secs(2),
    );
    let snapshot = manager.status().await;
    assert_eq!(snapshot.status, UpdateStatus::Error);
    assert_eq!(
        snapshot.error.as_deref(),
        Some("update helper output exceeded the size limit")
    );
}
