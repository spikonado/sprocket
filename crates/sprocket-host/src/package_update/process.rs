use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use serde::Deserialize;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

use super::{PackageUpdateSnapshot, UpdateMethod, UpdateStatus};

const MAX_HELPER_STREAM_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone)]
pub(super) struct UpdateCommand {
    node: PathBuf,
    script: PathBuf,
}

impl UpdateCommand {
    pub(super) fn new(node: PathBuf, script: PathBuf) -> Self {
        Self { node, script }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum HelperAction {
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

pub(super) async fn run_helper(
    command: &UpdateCommand,
    action: HelperAction,
    limit: Duration,
    previous: &PackageUpdateSnapshot,
) -> PackageUpdateSnapshot {
    let mut child = match spawn_helper(command, action) {
        Ok(child) => child,
        Err(error) => {
            return PackageUpdateSnapshot::error(
                previous.current_version.clone(),
                previous.version.clone(),
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
                    previous.current_version.clone(),
                    previous.version.clone(),
                    "update helper output exceeded the size limit",
                );
            }
            parse_helper_output(&stdout.bytes, &stderr.bytes, status.success(), previous)
        }
        Err(HelperCollectError::Wait(error)) => PackageUpdateSnapshot::error(
            previous.current_version.clone(),
            previous.version.clone(),
            format!("failed to wait for update helper: {error}"),
        ),
        Err(HelperCollectError::TimedOut) => PackageUpdateSnapshot::error(
            previous.current_version.clone(),
            previous.version.clone(),
            "update helper timed out",
        ),
    }
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
            kill_process_group(pid);
        }
    }
}

#[cfg(unix)]
fn kill_process_group(leader: u32) {
    // SAFETY: kill has no memory preconditions.
    unsafe {
        libc::kill(-(leader as i32), libc::SIGKILL);
    }
}

async fn collect_helper_output(
    child: &mut tokio::process::Child,
    stdout: Option<tokio::process::ChildStdout>,
    stderr: Option<tokio::process::ChildStderr>,
    limit: Duration,
) -> Result<(std::process::ExitStatus, LimitedOutput, LimitedOutput), HelperCollectError> {
    let mut stdout_task = tokio::spawn(read_limited(stdout, MAX_HELPER_STREAM_BYTES));
    let mut stderr_task = tokio::spawn(read_limited(stderr, MAX_HELPER_STREAM_BYTES));
    // An unreaped leader keeps its pid, and so the group id, from being reused, so the
    // group can be killed safely until `wait` returns.
    let collect = async {
        let stdout = (&mut stdout_task).await.unwrap_or_default();
        let stderr = (&mut stderr_task).await.unwrap_or_default();
        let status = child.wait().await.map_err(HelperCollectError::Wait)?;
        Ok((status, stdout, stderr))
    };
    let error = match tokio::time::timeout(limit, collect).await {
        Ok(Ok(output)) => return Ok(output),
        Ok(Err(error)) => error,
        Err(_) => HelperCollectError::TimedOut,
    };
    kill_helper(child).await;
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

async fn kill_helper(child: &mut tokio::process::Child) {
    let pid = child.id();
    #[cfg(unix)]
    if let Some(pid) = pid {
        kill_process_group(pid);
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
    #[serde(default)]
    restart_launcher: Option<String>,
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
            restart_launcher: self.restart_launcher,
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
mod tests;
