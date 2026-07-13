use std::path::PathBuf;
use std::process::{ExitStatus, Stdio};
use std::time::Duration;

use crate::text::limit_chars;
use crate::workspace::{relative_to_root, resolve_workspace_path};
use anyhow::{Context, Result, bail};
use serde::Serialize;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::{Child, Command};
use tokio_util::sync::CancellationToken;

const DEFAULT_COMMAND_TIMEOUT_MS: u64 = 60_000;
const DEFAULT_COMMAND_MAX_OUTPUT_CHARS: usize = 20_000;
const MAX_COMMAND_MAX_OUTPUT_CHARS: usize = 80_000;

#[derive(Clone, Debug, Default)]
pub struct WorkspaceCancellation(CancellationToken);

impl WorkspaceCancellation {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.0.cancel();
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.is_cancelled()
    }

    async fn cancelled(&self) {
        self.0.cancelled().await;
    }

    fn ensure_active(&self) -> Result<()> {
        if self.is_cancelled() {
            return Err(WorkspaceOperationCancelled.into());
        }
        Ok(())
    }
}

#[derive(Debug, thiserror::Error)]
#[error("workspace operation was cancelled")]
pub struct WorkspaceOperationCancelled;

#[derive(Clone)]
pub(crate) struct WorkspaceTools {
    root: PathBuf,
    cancellation: WorkspaceCancellation,
}

impl WorkspaceTools {
    pub(crate) fn new(root: PathBuf, cancellation: WorkspaceCancellation) -> Self {
        Self { root, cancellation }
    }

    fn root(&self) -> &PathBuf {
        &self.root
    }

    async fn exec_command(
        &self,
        command: &str,
        workdir: Option<&str>,
        shell: Option<&str>,
        login: Option<bool>,
        timeout_ms: Option<u64>,
        max_output_chars: Option<usize>,
    ) -> Result<CommandExecOutput> {
        self.cancellation.ensure_active()?;
        if command.trim().is_empty() {
            bail!("command cannot be empty");
        }

        let cwd = resolve_workspace_path(self.root(), workdir.unwrap_or("."), false)?;
        let output_limit = max_output_chars
            .unwrap_or(DEFAULT_COMMAND_MAX_OUTPUT_CHARS)
            .clamp(1, MAX_COMMAND_MAX_OUTPUT_CHARS);

        let mut process = build_shell_command(command, shell, login.unwrap_or(false));
        process
            .current_dir(&cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(unix)]
        process.process_group(0);

        self.cancellation.ensure_active()?;
        let mut child = process
            .spawn()
            .with_context(|| format!("failed to start command in {}", cwd.display()))?;
        let process_id = child.id();
        let stdout_task = tokio::spawn(read_pipe(child.stdout.take()));
        let stderr_task = tokio::spawn(read_pipe(child.stderr.take()));

        let timeout =
            Duration::from_millis(timeout_ms.unwrap_or(DEFAULT_COMMAND_TIMEOUT_MS).max(1));
        let wait = tokio::time::sleep(timeout);
        tokio::pin!(wait);
        let outcome = tokio::select! {
            biased;
            _ = self.cancellation.cancelled() => CommandWaitOutcome::Cancelled,
            status = child.wait() => CommandWaitOutcome::Exited(status),
            _ = &mut wait => CommandWaitOutcome::TimedOut,
        };
        let (status, timed_out) = match outcome {
            CommandWaitOutcome::Exited(Ok(status)) => {
                if let Err(error) = stop_processes_after_shell_exit(process_id) {
                    stdout_task.abort();
                    stderr_task.abort();
                    let _ = stdout_task.await;
                    let _ = stderr_task.await;
                    return Err(error).with_context(|| {
                        format!("failed to stop command descendants in {}", cwd.display())
                    });
                }
                (status, false)
            }
            CommandWaitOutcome::Exited(Err(error)) => {
                let _ = terminate_child(&mut child, process_id).await;
                return Err(error)
                    .with_context(|| format!("failed to wait for command in {}", cwd.display()));
            }
            CommandWaitOutcome::TimedOut => (
                terminate_child(&mut child, process_id)
                    .await
                    .with_context(|| {
                        format!("failed to stop timed out command in {}", cwd.display())
                    })?,
                true,
            ),
            CommandWaitOutcome::Cancelled => {
                let termination =
                    terminate_child(&mut child, process_id)
                        .await
                        .with_context(|| {
                            format!("failed to stop cancelled command in {}", cwd.display())
                        });
                stdout_task.abort();
                stderr_task.abort();
                let _ = stdout_task.await;
                let _ = stderr_task.await;
                termination?;
                return Err(WorkspaceOperationCancelled.into());
            }
        };

        let stdout = String::from_utf8_lossy(&stdout_task.await??).to_string();
        let stderr = String::from_utf8_lossy(&stderr_task.await??).to_string();
        let combined_output = combine_command_output(&stdout, &stderr);
        let (output, truncated) = limit_chars(&combined_output, output_limit);

        Ok(CommandExecOutput {
            command: command.to_string(),
            cwd: workdir.map(str::to_owned),
            exit_code: status.code(),
            success: status.success() && !timed_out,
            timed_out,
            stdout,
            stderr,
            output,
            truncated,
        })
    }

    async fn create_file(&self, relative_path: &str, content: &str) -> Result<FileWriteOutput> {
        self.cancellation.ensure_active()?;
        let path = resolve_workspace_path(self.root(), relative_path, true)?;
        if tokio::fs::try_exists(&path)
            .await
            .with_context(|| format!("failed to inspect {}", path.display()))?
        {
            bail!("file already exists: {}", path.display());
        }

        if let Some(parent) = path.parent() {
            self.cancellation.ensure_active()?;
            tokio::fs::create_dir_all(parent)
                .await
                .with_context(|| format!("failed to create {}", parent.display()))?;
        }

        self.cancellation.ensure_active()?;
        tokio::fs::write(&path, content.as_bytes())
            .await
            .with_context(|| format!("failed to write {}", path.display()))?;

        Ok(FileWriteOutput {
            path: relative_to_root(self.root(), &path),
            bytes_written: content.len(),
        })
    }

    async fn replace_in_file(
        &self,
        relative_path: &str,
        old_text: &str,
        new_text: &str,
        replace_all: bool,
    ) -> Result<FileEditOutput> {
        self.cancellation.ensure_active()?;
        if old_text.is_empty() {
            bail!("old_text cannot be empty");
        }

        let path = resolve_workspace_path(self.root(), relative_path, false)?;
        let contents = tokio::fs::read_to_string(&path)
            .await
            .with_context(|| format!("failed to read {}", path.display()))?;
        let occurrences = contents.matches(old_text).count();

        if occurrences == 0 {
            bail!("target text was not found in {}", path.display());
        }

        if occurrences > 1 && !replace_all {
            bail!(
                "target text matched {} times in {}; retry with replace_all=true or use a more specific old_text",
                occurrences,
                path.display()
            );
        }

        let next_contents = if replace_all {
            contents.replace(old_text, new_text)
        } else {
            contents.replacen(old_text, new_text, 1)
        };

        self.cancellation.ensure_active()?;
        tokio::fs::write(&path, next_contents.as_bytes())
            .await
            .with_context(|| format!("failed to write {}", path.display()))?;

        Ok(FileEditOutput {
            path: relative_to_root(self.root(), &path),
            replacements: if replace_all { occurrences } else { 1 },
            bytes_written: next_contents.len(),
        })
    }
}

enum CommandWaitOutcome {
    Exited(std::io::Result<ExitStatus>),
    TimedOut,
    Cancelled,
}

async fn terminate_child(child: &mut Child, process_id: Option<u32>) -> Result<ExitStatus> {
    let tree_result = stop_remaining_processes(process_id);
    let _ = child.start_kill();
    let wait_result = child.wait().await;
    tree_result?;
    wait_result.map_err(Into::into)
}

#[cfg(unix)]
fn stop_remaining_processes(process_id: Option<u32>) -> Result<()> {
    if let Some(pid) = process_id {
        // The shell is started as the leader of a new process group, so signalling the
        // negative pid also stops commands spawned by that shell.
        let result = unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
        if result != 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                return Err(error.into());
            }
        }
    }

    Ok(())
}

#[cfg(unix)]
fn stop_processes_after_shell_exit(process_id: Option<u32>) -> Result<()> {
    stop_remaining_processes(process_id)
}

#[cfg(windows)]
fn stop_remaining_processes(process_id: Option<u32>) -> Result<()> {
    if let Some(pid) = process_id {
        std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .context("failed to start taskkill")?;
    }

    Ok(())
}

#[cfg(windows)]
fn stop_processes_after_shell_exit(_process_id: Option<u32>) -> Result<()> {
    Ok(())
}

#[cfg(not(windows))]
fn build_shell_command(command: &str, shell: Option<&str>, login: bool) -> Command {
    let shell = shell
        .map(ToOwned::to_owned)
        .or_else(|| std::env::var("SHELL").ok())
        .unwrap_or_else(|| "/bin/bash".to_string());
    let mut process = Command::new(shell);
    process.arg(if login { "-lc" } else { "-c" }).arg(command);
    process
}

#[cfg(windows)]
fn build_shell_command(command: &str, shell: Option<&str>, login: bool) -> Command {
    let shell = shell.unwrap_or("powershell.exe");
    let mut process = Command::new(shell);
    process.arg("-NoLogo").arg("-NoProfile");
    if login {
        process.arg("-Login");
    }
    process.arg("-Command").arg(command);
    process
}

async fn read_pipe<T>(pipe: Option<T>) -> Result<Vec<u8>>
where
    T: AsyncRead + Unpin,
{
    let mut buffer = Vec::new();
    if let Some(mut pipe) = pipe {
        pipe.read_to_end(&mut buffer).await?;
    }
    Ok(buffer)
}

fn combine_command_output(stdout: &str, stderr: &str) -> String {
    if stdout.is_empty() {
        return stderr.to_string();
    }
    if stderr.is_empty() {
        return stdout.to_string();
    }
    format!("{stdout}\n{stderr}")
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandExecOutput {
    pub command: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    pub success: bool,
    pub timed_out: bool,
    pub stdout: String,
    pub stderr: String,
    pub output: String,
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileWriteOutput {
    pub path: String,
    pub bytes_written: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEditOutput {
    pub path: String,
    pub replacements: usize,
    pub bytes_written: usize,
}

pub async fn exec_workspace_command(
    workspace_root: PathBuf,
    cancellation: WorkspaceCancellation,
    command: &str,
    workdir: Option<&str>,
    shell: Option<&str>,
    login: Option<bool>,
    timeout_ms: Option<u64>,
    max_output_chars: Option<usize>,
) -> Result<CommandExecOutput> {
    WorkspaceTools::new(workspace_root, cancellation)
        .exec_command(command, workdir, shell, login, timeout_ms, max_output_chars)
        .await
}

pub async fn create_workspace_file(
    workspace_root: PathBuf,
    cancellation: WorkspaceCancellation,
    path: &str,
    content: &str,
) -> Result<FileWriteOutput> {
    WorkspaceTools::new(workspace_root, cancellation)
        .create_file(path, content)
        .await
}

pub async fn replace_workspace_file(
    workspace_root: PathBuf,
    cancellation: WorkspaceCancellation,
    path: &str,
    old_text: &str,
    new_text: &str,
    replace_all: bool,
) -> Result<FileEditOutput> {
    WorkspaceTools::new(workspace_root, cancellation)
        .replace_in_file(path, old_text, new_text, replace_all)
        .await
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use super::{WorkspaceCancellation, WorkspaceOperationCancelled, WorkspaceTools};

    static TEMP_WORKSPACE_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_workspace() -> PathBuf {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after unix epoch")
            .as_nanos();
        let counter = TEMP_WORKSPACE_COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "sprocket-workspace-tests-{timestamp}-{}-{counter}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("temp dir should be created");
        path
    }

    #[tokio::test]
    async fn exec_command_runs_inside_workspace_root() {
        let root = temp_workspace();
        let tools = WorkspaceTools::new(root.clone(), WorkspaceCancellation::new());

        let output = tools
            .exec_command("pwd", None, None, Some(false), Some(5_000), None)
            .await
            .expect("command should succeed");

        assert!(output.success);
        assert!(
            output.stdout.contains(root.to_string_lossy().as_ref()),
            "unexpected output: {output:?}"
        );

        fs::remove_dir_all(root).expect("temp dir should be removed");
    }

    #[tokio::test]
    async fn exec_command_rejects_workdir_outside_workspace() {
        let root = temp_workspace();
        let tools = WorkspaceTools::new(root.clone(), WorkspaceCancellation::new());

        let result = tools
            .exec_command("pwd", Some("../"), None, Some(false), Some(5_000), None)
            .await;

        assert!(result.is_err());

        fs::remove_dir_all(root).expect("temp dir should be removed");
    }

    #[tokio::test]
    async fn replace_in_file_requires_unique_match_without_replace_all() {
        let root = temp_workspace();
        let path = root.join("src.txt");
        fs::write(&path, "alpha\nalpha\n").expect("fixture should be written");

        let tools = WorkspaceTools::new(root.clone(), WorkspaceCancellation::new());
        let result = tools
            .replace_in_file("src.txt", "alpha", "beta", false)
            .await;

        assert!(result.is_err());

        fs::remove_dir_all(root).expect("temp dir should be removed");
    }

    #[tokio::test]
    async fn cancelled_create_and_replace_do_not_mutate_files() {
        let root = temp_workspace();
        let existing = root.join("existing.txt");
        fs::write(&existing, "before").expect("fixture should be written");
        let cancellation = WorkspaceCancellation::new();
        cancellation.cancel();
        let tools = WorkspaceTools::new(root.clone(), cancellation);

        let create_error = tools
            .create_file("created.txt", "content")
            .await
            .expect_err("cancelled create should fail");
        let replace_error = tools
            .replace_in_file("existing.txt", "before", "after", false)
            .await
            .expect_err("cancelled replace should fail");

        assert!(create_error.is::<WorkspaceOperationCancelled>());
        assert!(replace_error.is::<WorkspaceOperationCancelled>());
        assert!(!root.join("created.txt").exists());
        assert_eq!(fs::read_to_string(existing).unwrap(), "before");

        fs::remove_dir_all(root).expect("temp dir should be removed");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancelling_command_stops_spawned_descendants() {
        let root = temp_workspace();
        let cancellation = WorkspaceCancellation::new();
        let tools = WorkspaceTools::new(root.clone(), cancellation.clone());
        let command = tools.exec_command(
            "sh -c 'sleep 0.2; touch leaked.txt' & wait",
            None,
            None,
            Some(false),
            Some(5_000),
            None,
        );
        tokio::pin!(command);

        tokio::select! {
            result = &mut command => panic!("command exited before cancellation: {result:?}"),
            _ = tokio::time::sleep(Duration::from_millis(25)) => cancellation.cancel(),
        }
        let error = command.await.expect_err("cancelled command should fail");
        assert!(error.is::<WorkspaceOperationCancelled>());
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(!root.join("leaked.txt").exists());

        fs::remove_dir_all(root).expect("temp dir should be removed");
    }
}
