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
    let mut truncated = false;
    let mut buf = [0u8; 8192];
    loop {
        match pipe.read(&mut buf).await {
            Ok(0) => break,
            Ok(n) => {
                let remaining = max_bytes.saturating_sub(bytes.len());
                if n > remaining {
                    bytes.extend_from_slice(&buf[..remaining]);
                    truncated = true;
                } else if !truncated {
                    bytes.extend_from_slice(&buf[..n]);
                }
            }
            Err(_) => break,
        }
    }
    LimitedOutput { bytes, truncated }
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

#[cfg(any(test, feature = "test-support"))]
mod test_support;
#[cfg(test)]
mod tests;

#[cfg(all(test, unix))]
mod process_tests;
