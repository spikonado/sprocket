use std::path::PathBuf;
use std::process::ExitStatus;
#[cfg(windows)]
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{Mutex, mpsc, oneshot, watch};

use super::CommandOutput;
use crate::command_history::CommandHistory;
use crate::command_output::{CapturedOutput, OutputChannel};

const PROCESS_POLL_INTERVAL_MS: u64 = 25;

pub(super) struct StdinRequest {
    pub chars: Vec<u8>,
    pub response: oneshot::Sender<std::result::Result<(), String>>,
}

#[derive(Clone, Debug, Default)]
pub(super) struct CommandCompletion {
    pub archived: bool,
    pub exit_code: Option<i32>,
    pub success: bool,
    pub timed_out: bool,
    pub error: Option<String>,
}

pub(super) fn signal_change(changes: &Option<watch::Sender<()>>) {
    if let Some(changes) = changes {
        changes.send_replace(());
    }
}

pub(super) fn completion_output(
    completion: &CommandCompletion,
    preview: crate::command_output::OutputPreview,
) -> CommandOutput {
    CommandOutput {
        exit_code: completion.exit_code,
        success: completion.success,
        running: false,
        timed_out: completion.timed_out,
        output: preview.output,
        complete_log_path: preview.complete_log_path,
        events_path: preview.events_path,
        error: completion.error.clone(),
    }
}

pub(super) async fn supervise_command(
    mut child: Child,
    process_id: Option<u32>,
    mut controls: mpsc::UnboundedReceiver<()>,
    completion: watch::Sender<Option<CommandCompletion>>,
    stdin_task: tokio::task::JoinHandle<()>,
    mut capture_task: tokio::task::JoinHandle<Result<()>>,
    output: Arc<Mutex<CapturedOutput>>,
    timeout: Option<Duration>,
    lifetime_guard: Option<Box<dyn Send + Sync>>,
    history: (PathBuf, CommandHistory),
    changes: Option<watch::Sender<()>>,
) {
    let timeout = wait_for_timeout(timeout);
    tokio::pin!(timeout);
    let mut poll = tokio::time::interval(Duration::from_millis(PROCESS_POLL_INTERVAL_MS));
    poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut capture_finished = false;

    let (status, timed_out, mut error) = loop {
        tokio::select! {
            result = &mut capture_task, if !capture_finished => {
                capture_finished = true;
                if let Err(error) = result.context("command output task failed").and_then(|result| result) {
                    let status = terminate_child(&mut child, process_id).await.ok();
                    break (status, false, Some(format!("command output capture failed: {error:#}")));
                }
            },
            _ = controls.recv() => {
                match terminate_child(&mut child, process_id).await {
                    Ok(status) => break (Some(status), false, None),
                    Err(error) => break (None, false, Some(error.to_string())),
                }
            },
            _ = &mut timeout => {
                match terminate_child(&mut child, process_id).await {
                    Ok(status) => break (Some(status), true, None),
                    Err(error) => break (None, true, Some(error.to_string())),
                }
            },
            _ = poll.tick() => match child.try_wait() {
                Ok(Some(status)) => {
                    if let Err(stop_error) = stop_remaining_processes(process_id) {
                        break (Some(status), false, Some(stop_error.to_string()));
                    }
                    break (Some(status), false, None);
                }
                Ok(None) => {}
                Err(wait_error) => {
                    let _ = terminate_child(&mut child, process_id).await;
                    break (None, false, Some(wait_error.to_string()));
                }
            }
        }
    };

    if !capture_finished {
        if let Err(capture_error) = join_capture_task(capture_task).await {
            error
                .get_or_insert_with(|| format!("command output capture failed: {capture_error:#}"));
        }
    }
    if let Err(capture_error) = output.lock().await.finish().await {
        error.get_or_insert_with(|| format!("command output log failed: {capture_error:#}"));
    }
    let mut completed = CommandCompletion {
        archived: false,
        exit_code: status.as_ref().and_then(ExitStatus::code),
        success: status.is_some_and(|status| status.success()) && !timed_out && error.is_none(),
        timed_out,
        error,
    };
    let (path, mut history) = history;
    history.result = completion_output(&completed, output.lock().await.full_preview());
    match history.save(&path).await {
        Ok(()) => completed.archived = true,
        Err(error) => {
            completed.success = false;
            let message = format!("failed to save command result: {error:#}");
            completed.error = Some(match completed.error {
                Some(error) => format!("{error}; {message}"),
                None => message,
            });
        }
    }
    stdin_task.abort();
    let _ = stdin_task.await;
    drop(lifetime_guard);
    let _ = completion.send(Some(completed));
    signal_change(&changes);
}

async fn wait_for_timeout(timeout: Option<Duration>) {
    match timeout {
        Some(timeout) => tokio::time::sleep(timeout).await,
        None => std::future::pending::<()>().await,
    }
}

pub(super) async fn write_command_input(
    mut stdin: Option<ChildStdin>,
    mut requests: mpsc::Receiver<StdinRequest>,
) {
    while let Some(request) = requests.recv().await {
        let result = match &mut stdin {
            Some(stdin) => stdin
                .write_all(&request.chars)
                .await
                .map_err(|error| error.to_string()),
            None => Err("command stdin is closed".to_string()),
        };
        if result.is_err() {
            stdin = None;
        }
        let _ = request.response.send(result);
    }
}

pub(super) async fn capture_pipes<O, E>(
    mut stdout: O,
    mut stderr: E,
    output: Arc<Mutex<CapturedOutput>>,
) -> Result<()>
where
    O: AsyncRead + Unpin,
    E: AsyncRead + Unpin,
{
    let mut stdout_buffer = [0_u8; 8_192];
    let mut stderr_buffer = [0_u8; 8_192];
    let mut stdout_open = true;
    let mut stderr_open = true;
    while stdout_open || stderr_open {
        tokio::select! {
            read = stdout.read(&mut stdout_buffer), if stdout_open => {
                let read = read.context("failed to read command stdout")?;
                stdout_open = read != 0;
                if stdout_open {
                    output.lock().await.append(OutputChannel::Stdout, &stdout_buffer[..read]).await?;
                }
            },
            read = stderr.read(&mut stderr_buffer), if stderr_open => {
                let read = read.context("failed to read command stderr")?;
                stderr_open = read != 0;
                if stderr_open {
                    output.lock().await.append(OutputChannel::Stderr, &stderr_buffer[..read]).await?;
                }
            },
        }
    }
    Ok(())
}

async fn join_capture_task(mut task: tokio::task::JoinHandle<Result<()>>) -> Result<()> {
    match tokio::time::timeout(Duration::from_secs(1), &mut task).await {
        Ok(result) => result.context("command output task failed")?,
        Err(_) => {
            task.abort();
            let _ = task.await;
            bail!(
                "command output did not reach EOF before the drain deadline; logs may be incomplete"
            )
        }
    }
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
        let result = unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
        if result != 0 {
            let error = std::io::Error::last_os_error();
            match error.raw_os_error() {
                Some(libc::ESRCH) => {}
                // macOS answers EPERM when the group's only members are unreaped zombies.
                Some(libc::EPERM) if cfg!(target_os = "macos") => {}
                _ => return Err(error.into()),
            }
        }
    }
    Ok(())
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

#[cfg(not(windows))]
pub(super) fn build_shell_command(command: &str, shell: &str) -> Command {
    let mut process = Command::new(shell);
    process.arg("-c").arg(command);
    process
}

#[cfg(windows)]
pub(super) fn build_shell_command(command: &str, shell: &str) -> Command {
    let mut process = Command::new(shell);
    if crate::command_shell::is_powershell(shell) {
        process.args(["-NoLogo", "-NoProfile", "-Command"]);
    } else {
        process.arg("-c");
    }
    process.arg(command);
    process
}

#[cfg(test)]
mod tests;
