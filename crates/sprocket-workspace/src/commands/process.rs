#[cfg(unix)]
mod spool;

use std::path::{Path, PathBuf};
#[cfg(windows)]
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use tokio::io::AsyncWriteExt;
#[cfg(windows)]
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{Mutex, mpsc, oneshot, watch};

use super::CommandOutput;
use crate::command_history::CommandHistory;
use crate::command_output::CapturedOutput;
#[cfg(windows)]
use crate::command_output::{MAX_EVENT_OUTPUT_BYTES, OutputChannel};

#[cfg(unix)]
pub(super) use self::spool::{AdoptedProcess, Spools, start_token};

const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(25);

pub(super) struct StdinRequest {
    pub chars: Vec<u8>,
    pub response: oneshot::Sender<std::result::Result<(), String>>,
}

#[derive(Clone, Debug, Default)]
pub(super) struct CommandCompletion {
    pub exit_code: Option<i32>,
    pub success: bool,
    pub timed_out: bool,
    pub error: Option<String>,
    pub saved: bool,
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

pub(super) enum Control {
    Terminate,
    /// Leaves the command running for the server that replaces this one.
    #[cfg(unix)]
    Detach,
}

pub(super) enum CommandProcess {
    Spawned {
        child: Child,
        pid: Option<u32>,
    },
    #[cfg(unix)]
    Adopted(AdoptedProcess),
}

impl CommandProcess {
    pub(super) fn spawned(child: Child) -> Self {
        let pid = child.id();
        Self::Spawned { child, pid }
    }

    fn process_group(&self) -> Option<u32> {
        match self {
            Self::Spawned { pid, .. } => *pid,
            #[cfg(unix)]
            Self::Adopted(process) => process.process_group(),
        }
    }

    /// `Some` once the shell exited, holding its exit code if it had one.
    fn try_exit(&mut self) -> std::io::Result<Option<Option<i32>>> {
        match self {
            Self::Spawned { child, .. } => Ok(child.try_wait()?.map(|status| status.code())),
            #[cfg(unix)]
            Self::Adopted(process) => Ok(process.try_exit()),
        }
    }

    async fn terminate(&mut self) -> Result<Option<i32>> {
        match self {
            Self::Spawned { child, pid } => {
                let tree_result = stop_remaining_processes(*pid);
                let _ = child.start_kill();
                let wait_result = child.wait().await;
                tree_result?;
                Ok(wait_result?.code())
            }
            #[cfg(unix)]
            Self::Adopted(process) => process.terminate().await,
        }
    }
}

pub(super) struct Capture {
    pub task: tokio::task::JoinHandle<Result<()>>,
    /// Asks a spool capture to read what's left and stop. Pipe captures end at EOF instead.
    pub stop: watch::Sender<bool>,
}

pub(super) struct Supervision {
    pub process: CommandProcess,
    pub capture: Capture,
    pub output: Arc<Mutex<CapturedOutput>>,
    pub timeout: Option<Duration>,
    pub lifetime_guard: Option<Box<dyn Send + Sync>>,
    pub history: (PathBuf, CommandHistory),
}

pub(super) async fn supervise_command(
    supervision: Supervision,
    stdin_task: tokio::task::JoinHandle<()>,
    mut controls: mpsc::UnboundedReceiver<Control>,
    completion: watch::Sender<Option<CommandCompletion>>,
    changes: Option<watch::Sender<()>>,
) {
    let Supervision {
        mut process,
        capture:
            Capture {
                task: mut capture_task,
                stop: capture_stop,
            },
        output,
        timeout,
        lifetime_guard,
        history,
    } = supervision;
    let timeout = wait_for_timeout(timeout);
    tokio::pin!(timeout);
    let mut poll = tokio::time::interval(PROCESS_POLL_INTERVAL);
    poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut capture_finished = false;

    let ending = loop {
        tokio::select! {
            result = &mut capture_task, if !capture_finished => {
                capture_finished = true;
                if let Err(error) = result.context("command output task failed").and_then(|result| result) {
                    let exit_code = process.terminate().await.ok().flatten();
                    break Some((exit_code, false, Some(format!("command was stopped because its output could not be captured: {error:#}"))));
                }
            },
            control = controls.recv() => match control {
                // Without a saved record, the next server couldn't find the command to adopt it.
                #[cfg(unix)]
                Some(Control::Detach) if history.1.process.is_some() => break None,
                Some(_) | None => match process.terminate().await {
                    Ok(exit_code) => break Some((exit_code, false, None)),
                    Err(error) => break Some((None, false, Some(error.to_string()))),
                },
            },
            _ = &mut timeout => {
                match process.terminate().await {
                    Ok(exit_code) => break Some((exit_code, true, None)),
                    Err(error) => break Some((None, true, Some(error.to_string()))),
                }
            },
            _ = poll.tick() => match process.try_exit() {
                Ok(Some(exit_code)) => {
                    if let Err(stop_error) = stop_remaining_processes(process.process_group()) {
                        break Some((exit_code, false, Some(stop_error.to_string())));
                    }
                    break Some((exit_code, false, None));
                }
                Ok(None) => {}
                Err(wait_error) => {
                    let _ = process.terminate().await;
                    break Some((None, false, Some(wait_error.to_string())));
                }
            }
        }
    };

    let _ = capture_stop.send(true);
    let capture_result = if capture_finished {
        Ok(())
    } else {
        join_capture_task(capture_task).await
    };
    let finish_result = output.lock().await.finish().await;
    let Some((exit_code, timed_out, mut error)) = ending else {
        // The next server resumes from what reached the logs, so their errors don't matter here.
        stdin_task.abort();
        let _ = stdin_task.await;
        return;
    };
    if let Err(capture_error) = capture_result {
        error.get_or_insert_with(|| format!("command output capture failed: {capture_error:#}"));
    }
    if let Err(capture_error) = finish_result {
        error.get_or_insert_with(|| format!("command output log failed: {capture_error:#}"));
    }
    let mut completed = CommandCompletion {
        exit_code,
        success: exit_code == Some(0) && !timed_out && error.is_none(),
        timed_out,
        error,
        saved: false,
    };
    let (path, mut history) = history;
    history.result = completion_output(&completed, output.lock().await.full_preview());
    match history.save(&path).await {
        Ok(()) => {
            completed.saved = true;
            #[cfg(unix)]
            if let Ok(log_directory) = history.result.log_directory() {
                spool::remove_files(log_directory);
            }
        }
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

/// Where a launched command's output is read from.
#[cfg(unix)]
pub(super) type OutputSource = Spools;
#[cfg(windows)]
pub(super) struct OutputSource;

#[cfg(unix)]
pub(super) fn start_capture(
    source: OutputSource,
    _child: &mut Child,
    output: Arc<Mutex<CapturedOutput>>,
) -> Capture {
    source.capture(output)
}

#[cfg(windows)]
pub(super) fn start_capture(
    _source: OutputSource,
    child: &mut Child,
    output: Arc<Mutex<CapturedOutput>>,
) -> Capture {
    let (stop, _) = watch::channel(false);
    Capture {
        task: tokio::spawn(capture_pipes(
            child.stdout.take().expect("stdout is piped"),
            child.stderr.take().expect("stderr is piped"),
            output,
        )),
        stop,
    }
}

#[cfg(windows)]
async fn capture_pipes<O, E>(
    mut stdout: O,
    mut stderr: E,
    output: Arc<Mutex<CapturedOutput>>,
) -> Result<()>
where
    O: AsyncRead + Unpin,
    E: AsyncRead + Unpin,
{
    let mut stdout_buffer = [0_u8; MAX_EVENT_OUTPUT_BYTES];
    let mut stderr_buffer = [0_u8; MAX_EVENT_OUTPUT_BYTES];
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

/// Spool reads stop at the length the spools had when the command ended, so they always finish.
#[cfg(unix)]
async fn join_capture_task(task: tokio::task::JoinHandle<Result<()>>) -> Result<()> {
    task.await.context("command output task failed")?
}

/// A pipe stays open while any process that escaped the command's tree still holds it.
#[cfg(windows)]
async fn join_capture_task(mut task: tokio::task::JoinHandle<Result<()>>) -> Result<()> {
    match tokio::time::timeout(Duration::from_secs(1), &mut task).await {
        Ok(result) => result.context("command output task failed")?,
        Err(_) => {
            task.abort();
            let _ = task.await;
            anyhow::bail!(
                "command output did not reach EOF before the drain deadline; logs may be incomplete"
            )
        }
    }
}

#[cfg(unix)]
fn stop_remaining_processes(process_id: Option<u32>) -> Result<()> {
    if let Some(pid) = process_id {
        // SAFETY: `kill` takes no pointers, and a group that is already gone yields ESRCH.
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

#[cfg(unix)]
pub(super) fn build_shell_command(
    command: &str,
    shell: &str,
    log_directory: &Path,
) -> std::io::Result<(Command, OutputSource)> {
    spool::shell_command(command, shell, log_directory)
}

#[cfg(windows)]
pub(super) fn build_shell_command(
    command: &str,
    shell: &str,
    _log_directory: &Path,
) -> std::io::Result<(Command, OutputSource)> {
    let mut process = Command::new(shell);
    if crate::command_shell::is_powershell(shell) {
        process.args(["-NoLogo", "-NoProfile", "-Command"]);
    } else {
        process.arg("-c");
    }
    process
        .arg(command)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    Ok((process, OutputSource))
}

#[cfg(test)]
mod tests;
