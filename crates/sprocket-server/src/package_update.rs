use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::{Mutex, watch};

const SUCCESS_CHECK_TTL: Duration = Duration::from_secs(60 * 60);
const FAILED_CHECK_TTL: Duration = Duration::from_secs(5 * 60);
const CHECK_TIMEOUT: Duration = Duration::from_secs(60);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const MAX_HELPER_STREAM_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdateStatus {
    Unavailable,
    Idle,
    Available,
    Installing,
    Installed,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdateMethod {
    Package,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageUpdateSnapshot {
    pub status: UpdateStatus,
    pub current_version: String,
    pub version: Option<String>,
    pub error: Option<String>,
    pub method: UpdateMethod,
    pub message: Option<String>,
}

impl PackageUpdateSnapshot {
    fn unavailable() -> Self {
        Self {
            status: UpdateStatus::Unavailable,
            current_version: String::new(),
            version: None,
            error: None,
            method: UpdateMethod::Package,
            message: None,
        }
    }

    fn error(current_version: String, version: Option<String>, message: impl Into<String>) -> Self {
        let error = message.into();
        Self {
            status: UpdateStatus::Error,
            current_version,
            version,
            error: Some(error.clone()),
            method: UpdateMethod::Package,
            message: Some(error),
        }
    }
}

#[derive(Debug, Clone)]
struct UpdateCommand {
    node: PathBuf,
    script: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HelperAction {
    Check,
    Install,
}

impl HelperAction {
    fn as_str(self) -> &'static str {
        match self {
            Self::Check => "check",
            Self::Install => "install",
        }
    }
}

struct RunningOp {
    action: HelperAction,
    wait: watch::Receiver<Option<PackageUpdateSnapshot>>,
}

struct Inner {
    snapshot: PackageUpdateSnapshot,
    last_check_at: Option<Instant>,
    last_check_failed: bool,
    installed: bool,
    pending_install: bool,
    running: Option<RunningOp>,
}

pub struct PackageUpdateManager {
    command: Option<UpdateCommand>,
    success_ttl: Duration,
    failure_ttl: Duration,
    check_timeout: Duration,
    install_timeout: Duration,
    inner: Mutex<Inner>,
}

impl PackageUpdateManager {
    pub fn from_env() -> Arc<Self> {
        Arc::new(Self::new(
            parse_update_command_from_env(),
            SUCCESS_CHECK_TTL,
            FAILED_CHECK_TTL,
            CHECK_TIMEOUT,
            INSTALL_TIMEOUT,
        ))
    }

    pub fn disabled() -> Arc<Self> {
        Arc::new(Self::new(
            None,
            SUCCESS_CHECK_TTL,
            FAILED_CHECK_TTL,
            CHECK_TIMEOUT,
            INSTALL_TIMEOUT,
        ))
    }

    fn new(
        command: Option<UpdateCommand>,
        success_ttl: Duration,
        failure_ttl: Duration,
        check_timeout: Duration,
        install_timeout: Duration,
    ) -> Self {
        let snapshot = if command.is_some() {
            PackageUpdateSnapshot {
                status: UpdateStatus::Idle,
                current_version: String::new(),
                version: None,
                error: None,
                method: UpdateMethod::Package,
                message: None,
            }
        } else {
            PackageUpdateSnapshot::unavailable()
        };
        Self {
            command,
            success_ttl,
            failure_ttl,
            check_timeout,
            install_timeout,
            inner: Mutex::new(Inner {
                snapshot,
                last_check_at: None,
                last_check_failed: false,
                installed: false,
                pending_install: false,
                running: None,
            }),
        }
    }

    pub async fn status(self: &Arc<Self>) -> PackageUpdateSnapshot {
        let mut inner = self.inner.lock().await;
        if self.command.is_none() {
            return PackageUpdateSnapshot::unavailable();
        }
        if inner.installed {
            return inner.snapshot.clone();
        }
        if let Some(running) = &inner.running {
            if running.action == HelperAction::Install || inner.pending_install {
                return inner.snapshot.clone();
            }
            let mut wait = running.wait.clone();
            drop(inner);
            return wait_for_snapshot(&mut wait).await;
        }
        if cache_is_fresh(&inner, self.success_ttl, self.failure_ttl) {
            return inner.snapshot.clone();
        }
        let wait = self.start_locked(&mut inner, HelperAction::Check);
        drop(inner);
        wait_for_snapshot(&mut wait.clone()).await
    }

    pub async fn install(self: &Arc<Self>) -> PackageUpdateSnapshot {
        let mut inner = self.inner.lock().await;
        if self.command.is_none() {
            return PackageUpdateSnapshot::unavailable();
        }
        if inner.installed {
            return inner.snapshot.clone();
        }
        if let Some(running) = &inner.running {
            if running.action == HelperAction::Install || inner.pending_install {
                return inner.snapshot.clone();
            }
            inner.pending_install = true;
            mark_installing(&mut inner.snapshot);
            return inner.snapshot.clone();
        }
        self.start_locked(&mut inner, HelperAction::Install);
        inner.snapshot.clone()
    }

    fn start_locked(
        self: &Arc<Self>,
        inner: &mut Inner,
        action: HelperAction,
    ) -> watch::Receiver<Option<PackageUpdateSnapshot>> {
        let (tx, rx) = watch::channel(None);
        if action == HelperAction::Install {
            mark_installing(&mut inner.snapshot);
        }
        inner.running = Some(RunningOp {
            action,
            wait: rx.clone(),
        });
        let manager = Arc::clone(self);
        tokio::spawn(async move {
            let snapshot = manager.run_helper(action).await;
            let mut inner = manager.inner.lock().await;
            inner.apply_result(action, snapshot);
            inner.running = None;
            let follow_with_install = action == HelperAction::Check
                && inner.pending_install
                && !inner.installed
                && inner.snapshot.status != UpdateStatus::Unavailable;
            inner.pending_install = false;
            if follow_with_install {
                manager.start_locked(&mut inner, HelperAction::Install);
            }
            let completed = inner.snapshot.clone();
            drop(inner);
            let _ = tx.send(Some(completed));
        });
        rx
    }

    async fn run_helper(&self, action: HelperAction) -> PackageUpdateSnapshot {
        let Some(command) = &self.command else {
            return PackageUpdateSnapshot::unavailable();
        };
        let previous = self.inner.lock().await.snapshot.clone();
        let limit = match action {
            HelperAction::Check => self.check_timeout,
            HelperAction::Install => self.install_timeout,
        };
        let mut child = match spawn_helper(command, action) {
            Ok(child) => child,
            Err(error) => {
                return PackageUpdateSnapshot::error(
                    previous.current_version,
                    previous.version,
                    format!("failed to start update helper: {error}"),
                );
            }
        };
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        #[cfg(unix)]
        let mut process_group = UpdateProcessGroup(child.id());
        let output = collect_helper_output(&mut child, stdout, stderr, limit).await;
        #[cfg(unix)]
        {
            process_group.0 = None;
        }
        match output {
            Ok((status, stdout, stderr)) => {
                if stdout.truncated || stderr.truncated {
                    return PackageUpdateSnapshot::error(
                        previous.current_version,
                        previous.version,
                        "update helper output exceeded the size limit",
                    );
                }
                parse_helper_output(&stdout.bytes, &stderr.bytes, status.success(), &previous)
            }
            Err(HelperCollectError::Wait(error)) => PackageUpdateSnapshot::error(
                previous.current_version,
                previous.version,
                format!("failed to wait for update helper: {error}"),
            ),
            Err(HelperCollectError::TimedOut) => PackageUpdateSnapshot::error(
                previous.current_version,
                previous.version,
                "update helper timed out",
            ),
        }
    }
}

impl Inner {
    fn apply_result(&mut self, action: HelperAction, snapshot: PackageUpdateSnapshot) {
        let mut snapshot = snapshot;
        if snapshot.current_version.is_empty() && !self.snapshot.current_version.is_empty() {
            snapshot.current_version = self.snapshot.current_version.clone();
        }
        if snapshot.status == UpdateStatus::Error && snapshot.version.is_none() {
            snapshot.version = self.snapshot.version.clone();
        }
        if snapshot.status == UpdateStatus::Installed {
            self.installed = true;
        }
        if action == HelperAction::Check || snapshot.status == UpdateStatus::Error {
            self.last_check_at = Some(Instant::now());
            self.last_check_failed = snapshot.status == UpdateStatus::Error;
        } else if snapshot.status == UpdateStatus::Installed {
            self.last_check_at = Some(Instant::now());
            self.last_check_failed = false;
        }
        self.snapshot = snapshot;
    }
}

fn cache_is_fresh(inner: &Inner, success_ttl: Duration, failure_ttl: Duration) -> bool {
    let Some(last_check_at) = inner.last_check_at else {
        return false;
    };
    let ttl = if inner.last_check_failed {
        failure_ttl
    } else {
        success_ttl
    };
    last_check_at.elapsed() < ttl
}

async fn wait_for_snapshot(
    wait: &mut watch::Receiver<Option<PackageUpdateSnapshot>>,
) -> PackageUpdateSnapshot {
    loop {
        if let Some(snapshot) = wait.borrow().clone() {
            return snapshot;
        }
        if wait.changed().await.is_err() {
            return PackageUpdateSnapshot::error(String::new(), None, "update helper task ended");
        }
    }
}

fn parse_update_command_from_env() -> Option<UpdateCommand> {
    parse_update_command(
        std::env::var("SPROCKET_UPDATE_NODE").ok().as_deref(),
        std::env::var("SPROCKET_UPDATE_SCRIPT").ok().as_deref(),
    )
}

fn parse_update_command(node: Option<&str>, script: Option<&str>) -> Option<UpdateCommand> {
    let node = node.map(str::trim).filter(|value| !value.is_empty())?;
    let script = script.map(str::trim).filter(|value| !value.is_empty())?;
    let node = PathBuf::from(node);
    let script = PathBuf::from(script);
    if !node.is_absolute() || !script.is_absolute() {
        tracing::warn!(
            "SPROCKET_UPDATE_NODE and SPROCKET_UPDATE_SCRIPT must be absolute paths; package updates disabled"
        );
        return None;
    }
    Some(UpdateCommand { node, script })
}

fn mark_installing(snapshot: &mut PackageUpdateSnapshot) {
    snapshot.status = UpdateStatus::Installing;
    snapshot.error = None;
    snapshot.message = None;
}

enum HelperCollectError {
    TimedOut,
    Wait(std::io::Error),
}

#[cfg(unix)]
struct UpdateProcessGroup(Option<u32>);

#[cfg(unix)]
impl Drop for UpdateProcessGroup {
    fn drop(&mut self) {
        if let Some(pid) = self.0 {
            // SAFETY: the update helper owns this group; canceling its task must also stop its children.
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
        }
    }
}

async fn collect_helper_output(
    child: &mut tokio::process::Child,
    stdout: Option<tokio::process::ChildStdout>,
    stderr: Option<tokio::process::ChildStderr>,
    limit: Duration,
) -> Result<(std::process::ExitStatus, LimitedOutput, LimitedOutput), HelperCollectError> {
    let pid = child.id();
    let mut stdout_task = tokio::spawn(read_limited(stdout, MAX_HELPER_STREAM_BYTES));
    let mut stderr_task = tokio::spawn(read_limited(stderr, MAX_HELPER_STREAM_BYTES));
    let collect = async {
        let status = child.wait().await.map_err(HelperCollectError::Wait)?;
        let stdout = (&mut stdout_task).await.unwrap_or_default();
        let stderr = (&mut stderr_task).await.unwrap_or_default();
        Ok((status, stdout, stderr))
    };
    let error = match tokio::time::timeout(limit, collect).await {
        Ok(Ok(output)) => return Ok(output),
        Ok(Err(error)) => error,
        Err(_) => HelperCollectError::TimedOut,
    };
    kill_helper(child, pid).await;
    stdout_task.abort();
    stderr_task.abort();
    let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
    Err(error)
}

fn spawn_helper(
    command: &UpdateCommand,
    action: HelperAction,
) -> std::io::Result<tokio::process::Child> {
    let mut process = Command::new(&command.node);
    process
        .arg(&command.script)
        .arg(action.as_str())
        .env("SPROCKET_UPDATE_MANAGED", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    process.process_group(0);
    process.spawn()
}

async fn kill_helper(child: &mut tokio::process::Child, pid: Option<u32>) {
    #[cfg(unix)]
    if let Some(pid) = pid {
        // SAFETY: spawn_helper makes the child the leader of its own process group.
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }
    #[cfg(windows)]
    if let (Some(pid), Some(system_root)) = (pid, std::env::var_os("SystemRoot")) {
        let mut killer = Command::new(PathBuf::from(system_root).join("System32/taskkill.exe"));
        killer
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let _ = tokio::time::timeout(Duration::from_secs(5), killer.status()).await;
    }
    let _ = child.start_kill();
}

#[derive(Default)]
struct LimitedOutput {
    bytes: Vec<u8>,
    truncated: bool,
}

async fn read_limited<R>(pipe: Option<R>, max_bytes: usize) -> LimitedOutput
where
    R: tokio::io::AsyncRead + Unpin,
{
    let Some(mut pipe) = pipe else {
        return LimitedOutput::default();
    };
    let mut bytes = Vec::new();
    let mut buf = [0u8; 8192];
    loop {
        match pipe.read(&mut buf).await {
            Ok(0) => break,
            Ok(n) => {
                if bytes.len() + n > max_bytes {
                    bytes.extend_from_slice(&buf[..max_bytes.saturating_sub(bytes.len())]);
                    return LimitedOutput {
                        bytes,
                        truncated: true,
                    };
                }
                bytes.extend_from_slice(&buf[..n]);
            }
            Err(_) => break,
        }
    }
    LimitedOutput {
        bytes,
        truncated: false,
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HelperJson {
    status: String,
    current_version: String,
    version: Option<String>,
    error: Option<String>,
    #[serde(default)]
    message: Option<String>,
}

fn parse_helper_output(
    stdout: &[u8],
    stderr: &[u8],
    exit_ok: bool,
    previous: &PackageUpdateSnapshot,
) -> PackageUpdateSnapshot {
    let stdout = String::from_utf8_lossy(stdout);
    let trimmed = stdout.trim();
    match serde_json::from_str::<HelperJson>(trimmed) {
        Ok(json) => {
            let snapshot = json.into_snapshot();
            if !exit_ok && snapshot.status != UpdateStatus::Error {
                PackageUpdateSnapshot::error(
                    snapshot.current_version,
                    snapshot.version,
                    "update helper exited with an error",
                )
            } else {
                snapshot
            }
        }
        Err(_) => {
            let stderr = String::from_utf8_lossy(stderr);
            let detail = if !exit_ok {
                if stderr.trim().is_empty() {
                    "update helper exited with an error".to_string()
                } else {
                    format!(
                        "update helper exited with an error: {}",
                        truncate_chars(stderr.trim(), 500)
                    )
                }
            } else {
                "update helper returned invalid JSON".to_string()
            };
            PackageUpdateSnapshot::error(
                previous.current_version.clone(),
                previous.version.clone(),
                detail,
            )
        }
    }
}

impl HelperJson {
    fn into_snapshot(self) -> PackageUpdateSnapshot {
        let version = self
            .version
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let status = match self.status.trim() {
            "unavailable" => UpdateStatus::Unavailable,
            "idle" => UpdateStatus::Idle,
            "available" => UpdateStatus::Available,
            "installed" => UpdateStatus::Installed,
            "error" => UpdateStatus::Error,
            "downloading" | "installing" => {
                return PackageUpdateSnapshot::error(
                    self.current_version,
                    version,
                    "update helper exited before the install finished",
                );
            }
            _ => {
                return PackageUpdateSnapshot::error(
                    self.current_version,
                    version,
                    format!("update helper returned unknown status '{}'", self.status),
                );
            }
        };
        if matches!(status, UpdateStatus::Available | UpdateStatus::Installed) && version.is_none()
        {
            return PackageUpdateSnapshot::error(
                self.current_version,
                None,
                "update helper omitted the update version",
            );
        }
        let error = self.error.filter(|value| !value.is_empty()).or_else(|| {
            (status == UpdateStatus::Error).then(|| "The package update failed.".to_string())
        });
        PackageUpdateSnapshot {
            status,
            current_version: self.current_version,
            version,
            error,
            method: UpdateMethod::Package,
            message: self.message.filter(|value| !value.is_empty()),
        }
    }
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    let mut chars = value.chars();
    let truncated: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        format!("{truncated}…")
    } else {
        truncated
    }
}

#[cfg(test)]
impl PackageUpdateManager {
    fn with_helper(node: PathBuf, script: PathBuf) -> Arc<Self> {
        Self::with_helper_and_timeouts(
            node,
            script,
            SUCCESS_CHECK_TTL,
            FAILED_CHECK_TTL,
            CHECK_TIMEOUT,
            INSTALL_TIMEOUT,
        )
    }

    pub(crate) fn with_helper_and_timeouts(
        node: PathBuf,
        script: PathBuf,
        success_ttl: Duration,
        failure_ttl: Duration,
        check_timeout: Duration,
        install_timeout: Duration,
    ) -> Arc<Self> {
        Arc::new(Self::new(
            Some(UpdateCommand { node, script }),
            success_ttl,
            failure_ttl,
            check_timeout,
            install_timeout,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helper_success_requires_a_version_and_successful_exit() {
        let previous = PackageUpdateSnapshot::unavailable();
        for (json, exit_ok) in [
            (
                r#"{"status":"installed","currentVersion":"1.0.0","version":"1.1.0"}"#,
                false,
            ),
            (r#"{"status":"installed","currentVersion":"1.0.0"}"#, true),
            (r#"{"status":"available","currentVersion":"1.0.0"}"#, true),
        ] {
            let snapshot = parse_helper_output(json.as_bytes(), b"", exit_ok, &previous);
            assert_eq!(snapshot.status, UpdateStatus::Error);
            assert!(snapshot.error.is_some());
        }
    }

    #[test]
    fn missing_or_relative_env_disables_updates() {
        let root = std::env::current_dir().unwrap();
        let node = root.join("node").display().to_string();
        let script = root.join("update-api.js").display().to_string();
        assert!(parse_update_command(None, None).is_none());
        assert!(parse_update_command(Some(&node), None).is_none());
        assert!(parse_update_command(Some(""), Some(&script)).is_none());
        assert!(parse_update_command(Some("node"), Some(&script)).is_none());
        assert!(parse_update_command(Some(&node), Some("update-api.js")).is_none());
        assert!(parse_update_command(Some(&node), Some(&script)).is_some());
        assert!(
            parse_update_command(Some(&format!("  {node}  ")), Some(&format!("  {script}  ")))
                .is_some()
        );
    }

    #[test]
    fn helper_json_maps_known_statuses() {
        let previous = PackageUpdateSnapshot::unavailable();
        let snapshot = parse_helper_output(
            br#"{"status":"idle","currentVersion":"1.0.0","version":null,"error":null,"method":"package"}"#,
            b"",
            true,
            &previous,
        );
        assert_eq!(snapshot.status, UpdateStatus::Idle);
        let snapshot = parse_helper_output(
            br#"{"status":"available","currentVersion":"1.0.0","version":"1.1.0","error":null,"method":"package"}"#,
            b"",
            true,
            &previous,
        );
        assert_eq!(snapshot.status, UpdateStatus::Available);
        let snapshot = parse_helper_output(
            br#"{"status":"installed","currentVersion":"1.1.0","version":"1.1.0","error":null,"method":"package"}"#,
            b"",
            true,
            &previous,
        );
        assert_eq!(snapshot.status, UpdateStatus::Installed);
        let snapshot = parse_helper_output(
            br#"{"status":"downloading","currentVersion":"1.0.0","version":"1.1.0","error":null,"method":"package"}"#,
            b"",
            true,
            &previous,
        );
        assert_eq!(snapshot.status, UpdateStatus::Error);
        assert_eq!(snapshot.version.as_deref(), Some("1.1.0"));
    }

    #[test]
    fn helper_parse_error_keeps_previous_version() {
        let previous = PackageUpdateSnapshot {
            status: UpdateStatus::Available,
            current_version: "1.0.0".to_string(),
            version: Some("1.1.0".to_string()),
            error: None,
            method: UpdateMethod::Package,
            message: None,
        };
        let snapshot = parse_helper_output(b"not-json", b"boom", false, &previous);
        assert_eq!(snapshot.status, UpdateStatus::Error);
        assert_eq!(snapshot.current_version, "1.0.0");
        assert_eq!(snapshot.version.as_deref(), Some("1.1.0"));
    }
}

#[cfg(all(test, unix))]
mod process_tests {
    use super::*;
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
            r#"dd if=/dev/zero bs=1024 count=128 2>/dev/null"#,
        );
        let manager = PackageUpdateManager::with_helper(node, script);
        let snapshot = manager.status().await;
        assert_eq!(snapshot.status, UpdateStatus::Error);
        assert_eq!(
            snapshot.error.as_deref(),
            Some("update helper output exceeded the size limit")
        );
    }
}
