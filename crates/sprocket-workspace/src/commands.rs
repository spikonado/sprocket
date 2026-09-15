use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use crate::command_output::{CapturedOutput, CommandOutputLimits, OutputChannel};
use crate::paths::expand_home;
use anyhow::{Context, Result, anyhow, bail};
use serde::Serialize;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{Mutex, mpsc, oneshot, watch};
use tokio_util::sync::CancellationToken;

const MAX_COMMAND_MAX_OUTPUT_CHARS: usize = 80_000;
const MAX_COMMAND_YIELD_MS: u64 = 300_000;
const PROCESS_POLL_INTERVAL_MS: u64 = 25;
const STDIN_QUEUE_CAPACITY: usize = 8;

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

    pub async fn cancelled(&self) {
        self.0.cancelled().await;
    }

    pub(crate) fn ensure_active(&self) -> Result<()> {
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
pub struct CommandSessionManager {
    workspace_root: PathBuf,
    log_directory: PathBuf,
    output_limits: CommandOutputLimits,
    sessions: Arc<Mutex<HashMap<String, Arc<CommandSession>>>>,
    next_session_id: Arc<AtomicU64>,
}

impl CommandSessionManager {
    pub fn new(workspace_root: PathBuf, log_directory: PathBuf) -> Self {
        Self {
            workspace_root,
            log_directory,
            output_limits: CommandOutputLimits::default(),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            next_session_id: Arc::new(AtomicU64::new(1)),
        }
    }

    pub fn with_output_limits(mut self, limits: CommandOutputLimits) -> Self {
        self.output_limits = limits;
        self
    }

    pub async fn exec_command(
        &self,
        cancellation: WorkspaceCancellation,
        command: &str,
        workdir: &str,
        shell: &str,
        timeout_ms: u64,
        yield_time_ms: u64,
        max_output_chars: usize,
    ) -> Result<CommandExecOutput> {
        cancellation.ensure_active()?;
        if command.trim().is_empty() {
            bail!("command cannot be empty");
        }

        let cwd = resolve_command_workdir(&self.workspace_root, workdir)?;
        let output = Arc::new(Mutex::new(
            CapturedOutput::create_with_limits(
                &self.log_directory,
                max_output_chars.min(MAX_COMMAND_MAX_OUTPUT_CHARS),
                self.output_limits,
            )
            .await?,
        ));
        let mut process = build_shell_command(command, shell);
        process
            .current_dir(&cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(unix)]
        process.process_group(0);

        cancellation.ensure_active()?;
        let mut child = process
            .spawn()
            .with_context(|| format!("failed to start shell \"{shell}\" in {}", cwd.display()))?;
        let process_id = child.id();
        let (stdin, stdin_requests) = mpsc::channel(STDIN_QUEUE_CAPACITY);
        let stdin_task = tokio::spawn(write_command_input(child.stdin.take(), stdin_requests));
        let capture_task = tokio::spawn(capture_pipes(
            child.stdout.take().expect("stdout is piped"),
            child.stderr.take().expect("stderr is piped"),
            output.clone(),
        ));
        let (control, controls) = mpsc::unbounded_channel();
        let (completion_sender, completion) = watch::channel(None);
        tokio::spawn(supervise_command(
            child,
            process_id,
            controls,
            completion_sender,
            stdin_task,
            capture_task,
            output.clone(),
            timeout_ms.max(1),
        ));

        let session_id = self
            .next_session_id
            .fetch_add(1, Ordering::Relaxed)
            .to_string();
        let session = Arc::new(CommandSession {
            id: session_id.clone(),
            command: command.to_string(),
            cwd: cwd.to_string_lossy().to_string(),
            control,
            stdin,
            completion,
            output,
            final_output: Mutex::new(None),
        });
        self.sessions
            .lock()
            .await
            .insert(session_id, session.clone());

        self.observe_session(session, cancellation, yield_time_ms)
            .await
    }

    pub async fn write_stdin(
        &self,
        cancellation: WorkspaceCancellation,
        session_id: &str,
        chars: &str,
        terminate: bool,
        yield_time_ms: u64,
    ) -> Result<CommandExecOutput> {
        let session = self
            .sessions
            .lock()
            .await
            .get(session_id)
            .cloned()
            .ok_or_else(|| anyhow!("unknown command session: {session_id}"))?;

        if let Err(error) = cancellation.ensure_active() {
            let _ = session.terminate();
            self.sessions.lock().await.remove(session_id);
            return Err(error);
        }

        if session.completion.borrow().is_none() && !chars.is_empty() {
            if let Err(error) = session
                .write(chars.as_bytes().to_vec(), &cancellation)
                .await
            {
                return self
                    .observe_after_write_error(session, cancellation, yield_time_ms, error)
                    .await;
            }
        }
        if session.completion.borrow().is_none() && terminate {
            session.terminate()?;
        }

        self.observe_session(session, cancellation, yield_time_ms)
            .await
    }

    pub async fn stop_all(&self) {
        let sessions = self
            .sessions
            .lock()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for session in &sessions {
            let _ = session.terminate();
        }
        let _ = tokio::time::timeout(Duration::from_secs(5), async {
            for session in sessions {
                let mut completion = session.completion.clone();
                if completion.borrow().is_none() {
                    let _ = completion.changed().await;
                }
            }
        })
        .await;
        self.sessions.lock().await.clear();
    }

    /// Best-effort synchronous terminate used when async cleanup cannot run
    /// (for example during `Drop` outside a Tokio runtime).
    pub fn terminate_all(&self) {
        let Ok(mut sessions) = self.sessions.try_lock() else {
            return;
        };
        for session in sessions.values() {
            let _ = session.terminate();
        }
        sessions.clear();
    }

    async fn observe_session(
        &self,
        session: Arc<CommandSession>,
        cancellation: WorkspaceCancellation,
        yield_time_ms: u64,
    ) -> Result<CommandExecOutput> {
        let completion = match wait_for_completion(
            &session,
            &cancellation,
            yield_time_ms.min(MAX_COMMAND_YIELD_MS),
        )
        .await
        {
            Ok(completion) => completion,
            Err(error) => {
                let _ = session.terminate();
                self.sessions.lock().await.remove(&session.id);
                return Err(error);
            }
        };
        Ok(session.output(completion).await)
    }

    async fn observe_after_write_error(
        &self,
        session: Arc<CommandSession>,
        cancellation: WorkspaceCancellation,
        yield_time_ms: u64,
        write_error: anyhow::Error,
    ) -> Result<CommandExecOutput> {
        match wait_for_completion(
            &session,
            &cancellation,
            yield_time_ms.min(MAX_COMMAND_YIELD_MS),
        )
        .await
        {
            Ok(Some(completion)) => {
                let write_error = format!("failed to write command stdin: {write_error:#}");
                Ok(session
                    .output_after_write(Some(completion), Some(write_error))
                    .await)
            }
            Ok(None) => {
                let _ = session.terminate();
                self.sessions.lock().await.remove(&session.id);
                Err(write_error)
            }
            Err(error) => {
                let _ = session.terminate();
                self.sessions.lock().await.remove(&session.id);
                Err(error)
            }
        }
    }
}

struct CommandSession {
    id: String,
    command: String,
    cwd: String,
    control: mpsc::UnboundedSender<CommandControl>,
    stdin: mpsc::Sender<StdinRequest>,
    completion: watch::Receiver<Option<CommandCompletion>>,
    output: Arc<Mutex<CapturedOutput>>,
    final_output: Mutex<Option<CommandExecOutput>>,
}

impl CommandSession {
    async fn write(&self, chars: Vec<u8>, cancellation: &WorkspaceCancellation) -> Result<()> {
        let (response, result) = oneshot::channel();
        let request = StdinRequest { chars, response };
        tokio::select! {
            _ = cancellation.cancelled() => Err(WorkspaceOperationCancelled.into()),
            sent = self.stdin.send(request) => sent
                .map_err(|_| anyhow!("command session {} is no longer accepting input", self.id)),
        }?;

        tokio::select! {
            _ = cancellation.cancelled() => Err(WorkspaceOperationCancelled.into()),
            response = result => response
                .map_err(|_| anyhow!("command session {} closed while writing input", self.id))?
                .map_err(|error| anyhow!(error)),
        }
    }

    fn terminate(&self) -> Result<()> {
        self.control
            .send(CommandControl::Terminate)
            .map_err(|_| anyhow!("command session {} is no longer running", self.id))
    }

    async fn output(&self, completion: Option<CommandCompletion>) -> CommandExecOutput {
        self.output_after_write(completion, None).await
    }

    async fn output_after_write(
        &self,
        completion: Option<CommandCompletion>,
        write_error: Option<String>,
    ) -> CommandExecOutput {
        let mut final_output = self.final_output.lock().await;
        let mut output = match final_output.as_ref() {
            Some(output) => output.clone(),
            None => self.snapshot_output(completion).await,
        };
        if let Some(write_error) = write_error {
            output.success = false;
            output.error = Some(match output.error {
                Some(completion_error) => format!("{completion_error}; {write_error}"),
                None => write_error,
            });
        }
        if !output.running {
            *final_output = Some(output.clone());
        }
        output
    }

    async fn snapshot_output(&self, completion: Option<CommandCompletion>) -> CommandExecOutput {
        let mut capture = self.output.lock().await;
        // Completion can arrive while this observer waits for the capture lock.
        let completion = completion.or_else(|| self.completion.borrow().clone());
        let preview = capture.take_preview();
        let running = completion.is_none();
        let completion = completion.unwrap_or_default();

        CommandExecOutput {
            command: self.command.clone(),
            cwd: self.cwd.clone(),
            session_id: running.then(|| self.id.clone()),
            exit_code: completion.exit_code,
            success: completion.success,
            running,
            timed_out: completion.timed_out,
            output: preview.output,
            truncated: preview.truncated,
            head_chars: preview.head_chars,
            output_bytes: preview.output_bytes,
            omitted_bytes: preview.omitted_bytes,
            omitted_lines: preview.omitted_lines,
            encoding_loss_bytes: preview.encoding_loss_bytes,
            total_output_bytes: preview.total_output_bytes,
            log_path: preview.log_path,
            events_path: preview.events_path,
            error: completion.error,
        }
    }
}

enum CommandControl {
    Terminate,
}

struct StdinRequest {
    chars: Vec<u8>,
    response: oneshot::Sender<std::result::Result<(), String>>,
}

#[derive(Clone, Debug, Default)]
struct CommandCompletion {
    exit_code: Option<i32>,
    success: bool,
    timed_out: bool,
    error: Option<String>,
}

async fn wait_for_completion(
    session: &CommandSession,
    cancellation: &WorkspaceCancellation,
    yield_time_ms: u64,
) -> Result<Option<CommandCompletion>> {
    let mut completion = session.completion.clone();
    if let Some(completion) = completion.borrow().clone() {
        return Ok(Some(completion));
    }
    if yield_time_ms == 0 {
        return Ok(None);
    }

    tokio::select! {
        _ = cancellation.cancelled() => Err(WorkspaceOperationCancelled.into()),
        result = tokio::time::timeout(
            Duration::from_millis(yield_time_ms),
            completion.changed(),
        ) => {
            match result {
                Ok(Ok(())) => Ok(completion.borrow().clone()),
                Ok(Err(_)) => bail!("command session {} closed unexpectedly", session.id),
                Err(_) => Ok(None),
            }
        }
    }
}

async fn supervise_command(
    mut child: Child,
    process_id: Option<u32>,
    mut controls: mpsc::UnboundedReceiver<CommandControl>,
    completion: watch::Sender<Option<CommandCompletion>>,
    stdin_task: tokio::task::JoinHandle<()>,
    mut capture_task: tokio::task::JoinHandle<Result<()>>,
    output: Arc<Mutex<CapturedOutput>>,
    timeout_ms: u64,
) {
    let timeout = tokio::time::sleep(Duration::from_millis(timeout_ms));
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
            control = controls.recv() => match control {
                Some(CommandControl::Terminate) | None => {
                    match terminate_child(&mut child, process_id).await {
                        Ok(status) => break (Some(status), false, None),
                        Err(error) => break (None, false, Some(error.to_string())),
                    }
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
                    if let Err(stop_error) = stop_processes_after_shell_exit(process_id) {
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
    let completed = CommandCompletion {
        exit_code: status.as_ref().and_then(ExitStatus::code),
        success: status.is_some_and(|status| status.success()) && !timed_out && error.is_none(),
        timed_out,
        error,
    };
    let _ = completion.send(Some(completed));
    stdin_task.abort();
    let _ = stdin_task.await;
}

async fn write_command_input(
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

async fn capture_pipes<O, E>(
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

fn resolve_command_workdir(workspace_root: &Path, workdir: &str) -> Result<PathBuf> {
    let expanded = PathBuf::from(expand_home(workdir.trim()));
    let candidate = if expanded.is_absolute() {
        expanded
    } else {
        workspace_root.join(expanded)
    };
    let resolved = candidate
        .canonicalize()
        .with_context(|| format!("failed to resolve command workdir {}", candidate.display()))?;
    if !resolved.is_dir() {
        bail!("command workdir is not a directory: {}", resolved.display());
    }
    Ok(resolved)
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
fn stop_processes_after_shell_exit(process_id: Option<u32>) -> Result<()> {
    // Match Unix: after the shell exits, kill any leftover process tree so
    // background children from PowerShell do not outlive the session.
    stop_remaining_processes(process_id)
}

pub fn default_command_shell() -> String {
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    }
    #[cfg(windows)]
    {
        "powershell.exe".to_string()
    }
}

#[cfg(not(windows))]
fn build_shell_command(command: &str, shell: &str) -> Command {
    let mut process = Command::new(shell);
    process.arg("-c").arg(command);
    process
}

#[cfg(windows)]
fn build_shell_command(command: &str, shell: &str) -> Command {
    let mut process = Command::new(shell);
    process
        .arg("-NoLogo")
        .arg("-NoProfile")
        .arg("-Command")
        .arg(command);
    process
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandExecOutput {
    pub command: String,
    pub cwd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    pub success: bool,
    pub running: bool,
    pub timed_out: bool,
    pub output: String,
    pub truncated: bool,
    pub head_chars: usize,
    pub output_bytes: u64,
    pub omitted_bytes: u64,
    pub omitted_lines: u64,
    pub encoding_loss_bytes: u64,
    pub total_output_bytes: u64,
    pub log_path: String,
    pub events_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::time::Duration;

    use super::{CommandSessionManager, WorkspaceCancellation, default_command_shell};
    use crate::test_support::temp_workspace;

    #[tokio::test]
    async fn output_preserves_observed_stream_order() {
        let root = temp_workspace();
        let sessions = CommandSessionManager::new(root.clone(), root.join("logs"));
        let output = sessions
            .exec_command(
                WorkspaceCancellation::new(),
                "printf 'starting\n'; sleep 0.1; printf 'failed\n' >&2; sleep 0.1; printf 'cleaning up\n'",
                ".",
                &default_command_shell(),
                5_000,
                5_000,
                20_000,
            )
            .await
            .unwrap();

        assert_eq!(output.output, "starting\nfailed\ncleaning up\n");
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn output_limit_keeps_head_and_tail() {
        let root = temp_workspace();
        let sessions = CommandSessionManager::new(root.clone(), root.join("logs"));
        let output = sessions
            .exec_command(
                WorkspaceCancellation::new(),
                "printf abcdefghij",
                ".",
                &default_command_shell(),
                5_000,
                5_000,
                4,
            )
            .await
            .unwrap();

        assert_eq!(output.output, "abij");
        assert!(output.truncated);
        assert_eq!(output.output_bytes, 10);
        assert_eq!(output.omitted_bytes, 6);
        assert_eq!(fs::read(&output.log_path).unwrap(), b"abcdefghij");
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn large_output_survives_preview_limits_and_session_cleanup() {
        let root = temp_workspace();
        let sessions = CommandSessionManager::new(root.clone(), root.join("logs"));
        let output = sessions
            .exec_command(
                WorkspaceCancellation::new(),
                "printf head; head -c 2100000 /dev/zero | tr '\\0' x; printf tail",
                ".",
                &default_command_shell(),
                20_000,
                20_000,
                8,
            )
            .await
            .unwrap();

        assert!(output.success, "{output:?}");
        assert_eq!(output.output, "headtail");
        assert_eq!(output.output_bytes, 2_100_008);
        assert_eq!(output.omitted_bytes, 2_100_000);
        sessions.stop_all().await;
        drop(sessions);
        let bytes = fs::read(output.log_path).unwrap();
        assert_eq!(bytes.len(), 2_100_008);
        assert!(bytes.starts_with(b"head"));
        assert!(bytes[4..2_100_004].iter().all(|byte| *byte == b'x'));
        assert!(bytes.ends_with(b"tail"));
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn preview_truncation_does_not_discard_prior_increments() {
        let root = temp_workspace();
        let sessions = CommandSessionManager::new(root.clone(), root.join("logs"));
        let started = sessions
            .exec_command(
                WorkspaceCancellation::new(),
                "read start; printf abcdefghij; read value; printf klmnopqrst",
                ".",
                &default_command_shell(),
                5_000,
                0,
                4,
            )
            .await
            .unwrap();
        let id = started.session_id.unwrap();
        let first = tokio::time::timeout(Duration::from_secs(2), async {
            let mut output = sessions
                .write_stdin(WorkspaceCancellation::new(), &id, "start\n", false, 0)
                .await
                .unwrap();
            loop {
                if output.total_output_bytes == 10 {
                    break output;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
                output = sessions
                    .write_stdin(WorkspaceCancellation::new(), &id, "", false, 0)
                    .await
                    .unwrap();
            }
        })
        .await
        .unwrap();
        assert_eq!(first.output, "abij");
        assert_eq!(fs::read(&first.log_path).unwrap(), b"abcdefghij");
        let finished = sessions
            .write_stdin(WorkspaceCancellation::new(), &id, "go\n", false, 5_000)
            .await
            .unwrap();
        assert_eq!(finished.output, "klst");
        assert_eq!(finished.output_bytes, 10);
        assert_eq!(finished.total_output_bytes, 20);
        assert_eq!(finished.log_path, first.log_path);
        assert_eq!(
            fs::read(&finished.log_path).unwrap(),
            b"abcdefghijklmnopqrst"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn unavailable_log_directory_prevents_command_side_effects() {
        let root = temp_workspace();
        let log_directory = root.join("not-a-directory");
        fs::write(&log_directory, "file").unwrap();
        let sessions = CommandSessionManager::new(root.clone(), log_directory);
        let error = sessions
            .exec_command(
                WorkspaceCancellation::new(),
                "touch ran",
                ".",
                &default_command_shell(),
                5_000,
                5_000,
                100,
            )
            .await
            .unwrap_err();
        assert!(error.to_string().contains("log directory"));
        assert!(!root.join("ran").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn low_disk_space_prevents_command_side_effects() {
        let root = temp_workspace();
        let sessions = CommandSessionManager::new(root.clone(), root.join("logs"))
            .with_output_limits(super::CommandOutputLimits {
                min_free_disk_bytes: u64::MAX,
                ..Default::default()
            });
        let error = sessions
            .exec_command(
                WorkspaceCancellation::new(),
                "touch ran",
                ".",
                &default_command_shell(),
                5_000,
                5_000,
                100,
            )
            .await
            .unwrap_err();
        assert!(error.to_string().contains("free-space reserve"));
        assert!(!root.join("ran").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn log_quota_terminates_capture_instead_of_reporting_success() {
        let root = temp_workspace();
        let sessions = CommandSessionManager::new(root.clone(), root.join("logs"))
            .with_output_limits(super::CommandOutputLimits {
                max_log_bytes: 4,
                ..Default::default()
            });
        let output = sessions
            .exec_command(
                WorkspaceCancellation::new(),
                "printf output; read value",
                ".",
                &default_command_shell(),
                5_000,
                5_000,
                100,
            )
            .await
            .unwrap();
        assert!(!output.success);
        assert!(!output.running);
        assert!(!output.timed_out);
        assert!(output.error.unwrap().contains("log quota"));
        assert!(fs::read(output.log_path).unwrap().is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn unfinished_capture_is_an_error_not_successful_truncation() {
        let task = tokio::spawn(std::future::pending::<anyhow::Result<()>>());
        let error = super::join_capture_task(task).await.unwrap_err();
        assert!(error.to_string().contains("logs may be incomplete"));
    }

    #[tokio::test]
    async fn capture_failure_terminates_the_command_and_reports_failure() {
        let root = temp_workspace();
        let output = super::CapturedOutput::create(&root.join("logs"), 100)
            .await
            .unwrap();
        let mut process =
            super::build_shell_command("sleep 0.5; touch leaked", &default_command_shell());
        process.current_dir(&root).kill_on_drop(true);
        #[cfg(unix)]
        process.process_group(0);
        let child = process.spawn().unwrap();
        let pid = child.id();
        let (_control, controls) = tokio::sync::mpsc::unbounded_channel();
        let (completion, mut completed) = tokio::sync::watch::channel(None);
        let supervisor = tokio::spawn(super::supervise_command(
            child,
            pid,
            controls,
            completion,
            tokio::spawn(std::future::pending()),
            tokio::spawn(async { anyhow::bail!("injected log write failure") }),
            std::sync::Arc::new(tokio::sync::Mutex::new(output)),
            5_000,
        ));
        tokio::time::timeout(Duration::from_secs(2), completed.changed())
            .await
            .unwrap()
            .unwrap();
        let result = completed.borrow().clone().unwrap();
        assert!(!result.success);
        assert!(result.error.unwrap().contains("injected log write failure"));
        supervisor.await.unwrap();
        tokio::time::sleep(Duration::from_millis(600)).await;
        assert!(!root.join("leaked").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn completed_session_can_be_observed_again() {
        let root = temp_workspace();
        let sessions = CommandSessionManager::new(root.clone(), root.join("logs"));
        let started = sessions
            .exec_command(
                WorkspaceCancellation::new(),
                "read value; printf '%s' \"$value\"",
                ".",
                &default_command_shell(),
                5_000,
                0,
                20_000,
            )
            .await
            .unwrap();
        let id = started.session_id.unwrap();
        let (finished, concurrent) = tokio::join!(
            sessions.write_stdin(WorkspaceCancellation::new(), &id, "done\n", false, 5_000),
            sessions.write_stdin(WorkspaceCancellation::new(), &id, "", false, 5_000),
        );
        let finished = finished.unwrap();
        assert_eq!(concurrent.unwrap().output, finished.output);
        let repeated = sessions
            .write_stdin(WorkspaceCancellation::new(), &id, "", false, 0)
            .await
            .expect("completed results must remain available to later observers");

        assert!(!repeated.running);
        assert_eq!(repeated.output, finished.output);
        assert_eq!(repeated.exit_code, finished.exit_code);
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn exec_command_reports_the_shell_and_workdir_when_spawn_fails() {
        let root = temp_workspace();
        let shell = root.join("missing-shell");
        let sessions = CommandSessionManager::new(root.clone(), root.join("logs"));
        let error = sessions
            .exec_command(
                WorkspaceCancellation::new(),
                "echo hello",
                ".",
                shell.to_str().unwrap(),
                5_000,
                5_000,
                20_000,
            )
            .await
            .expect_err("a missing shell must not fall back to another executable");

        assert!(error.to_string().contains(shell.to_str().unwrap()));
        assert!(error.to_string().contains(root.to_str().unwrap()));
        assert_eq!(
            error.downcast_ref::<std::io::Error>().unwrap().kind(),
            std::io::ErrorKind::NotFound
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn exec_command_defaults_to_workspace_root() {
        let root = temp_workspace();
        let sessions = CommandSessionManager::new(root.clone(), root.join("logs"));
        let output = sessions
            .exec_command(
                WorkspaceCancellation::new(),
                "pwd",
                ".",
                &default_command_shell(),
                5_000,
                5_000,
                20_000,
            )
            .await
            .expect("command should succeed");

        assert!(output.success);
        assert!(output.output.contains(root.to_string_lossy().as_ref()));
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn exec_command_allows_workdir_outside_workspace() {
        let root = temp_workspace();
        let parent = root.parent().unwrap().canonicalize().unwrap();
        let sessions = CommandSessionManager::new(root.clone(), root.join("logs"));
        let output = sessions
            .exec_command(
                WorkspaceCancellation::new(),
                "pwd",
                "..",
                &default_command_shell(),
                5_000,
                5_000,
                20_000,
            )
            .await
            .expect("outside workdir should be allowed");

        assert!(output.success);
        assert_eq!(output.cwd, parent.to_string_lossy());
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn long_command_yields_and_can_be_polled() {
        let root = temp_workspace();
        let sessions = CommandSessionManager::new(root.clone(), root.join("logs"));
        let started = sessions
            .exec_command(
                WorkspaceCancellation::new(),
                "printf start; sleep 0.1; printf end",
                ".",
                &default_command_shell(),
                5_000,
                10,
                20_000,
            )
            .await
            .expect("command should start");

        assert!(started.running);
        let finished = sessions
            .write_stdin(
                WorkspaceCancellation::new(),
                started.session_id.as_deref().unwrap(),
                "",
                false,
                5_000,
            )
            .await
            .expect("command should finish");

        assert!(!finished.running);
        assert!(finished.success);
        assert_eq!(format!("{}{}", started.output, finished.output), "startend");
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn write_stdin_sends_input_to_running_command() {
        let root = temp_workspace();
        let sessions = CommandSessionManager::new(root.clone(), root.join("logs"));
        let started = sessions
            .exec_command(
                WorkspaceCancellation::new(),
                "read value; printf 'got:%s' \"$value\"",
                ".",
                &default_command_shell(),
                5_000,
                10,
                20_000,
            )
            .await
            .expect("command should start");

        let finished = sessions
            .write_stdin(
                WorkspaceCancellation::new(),
                started.session_id.as_deref().unwrap(),
                "hello\n",
                false,
                5_000,
            )
            .await
            .expect("input should be delivered");

        assert!(finished.success);
        assert_eq!(finished.output, "got:hello");
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn blocked_stdin_does_not_prevent_command_timeout() {
        let root = temp_workspace();
        let sessions = CommandSessionManager::new(root.clone(), root.join("logs"));
        let started = sessions
            .exec_command(
                WorkspaceCancellation::new(),
                "sleep 5",
                ".",
                &default_command_shell(),
                100,
                10,
                20_000,
            )
            .await
            .expect("command should start");

        let finished = tokio::time::timeout(
            Duration::from_secs(2),
            sessions.write_stdin(
                WorkspaceCancellation::new(),
                started.session_id.as_deref().unwrap(),
                &"input".repeat(500_000),
                false,
                5_000,
            ),
        )
        .await
        .expect("stdin backpressure must not block the command timeout")
        .expect("timed out command should return a result");

        assert!(finished.timed_out);
        assert!(!finished.success);
        assert!(!finished.running);
        assert!(
            finished
                .error
                .as_deref()
                .is_some_and(|error| error.contains("failed to write command stdin"))
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn reports_input_dropped_during_normal_command_completion() {
        let root = temp_workspace();
        let sessions = CommandSessionManager::new(root.clone(), root.join("logs"));
        let started = sessions
            .exec_command(
                WorkspaceCancellation::new(),
                "while [ ! -f release ]; do sleep 0.01; done",
                ".",
                &default_command_shell(),
                5_000,
                10,
                20_000,
            )
            .await
            .expect("command should start");
        fs::write(root.join("release"), "").unwrap();

        let finished = sessions
            .write_stdin(
                WorkspaceCancellation::new(),
                started.session_id.as_deref().unwrap(),
                &"input".repeat(500_000),
                false,
                5_000,
            )
            .await
            .expect("completed command should return its result");

        assert_eq!(finished.exit_code, Some(0));
        assert!(!finished.success);
        assert!(!finished.running);
        assert!(
            finished
                .error
                .as_deref()
                .is_some_and(|error| error.contains("failed to write command stdin"))
        );
        let replay = sessions
            .write_stdin(
                WorkspaceCancellation::new(),
                started.session_id.as_deref().unwrap(),
                "",
                false,
                0,
            )
            .await
            .unwrap();
        assert_eq!(
            serde_json::to_value(replay).unwrap(),
            serde_json::to_value(finished).unwrap()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn cancelled_poll_removes_and_terminates_session() {
        let root = temp_workspace();
        let sessions = CommandSessionManager::new(root.clone(), root.join("logs"));
        let started = sessions
            .exec_command(
                WorkspaceCancellation::new(),
                "sleep 5",
                ".",
                &default_command_shell(),
                5_000,
                10,
                20_000,
            )
            .await
            .expect("command should start");
        let session_id = started.session_id.as_deref().unwrap();
        let cancellation = WorkspaceCancellation::new();
        cancellation.cancel();

        sessions
            .write_stdin(cancellation, session_id, "", false, 5_000)
            .await
            .expect_err("cancelled poll should fail");

        assert!(!sessions.sessions.lock().await.contains_key(session_id));
        sessions.stop_all().await;
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn terminate_stops_running_command() {
        let root = temp_workspace();
        let sessions = CommandSessionManager::new(root.clone(), root.join("logs"));
        let started = sessions
            .exec_command(
                WorkspaceCancellation::new(),
                "sleep 0.2; touch leaked.txt",
                ".",
                &default_command_shell(),
                5_000,
                10,
                20_000,
            )
            .await
            .expect("command should start");

        let finished = sessions
            .write_stdin(
                WorkspaceCancellation::new(),
                started.session_id.as_deref().unwrap(),
                "",
                true,
                5_000,
            )
            .await
            .expect("command should terminate");

        assert!(!finished.running);
        assert!(!finished.success);
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(!root.join("leaked.txt").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn terminate_all_clears_active_sessions() {
        let root = temp_workspace();
        let sessions = CommandSessionManager::new(root.clone(), root.join("logs"));
        let started = sessions
            .exec_command(
                WorkspaceCancellation::new(),
                "sleep 5",
                ".",
                &default_command_shell(),
                5_000,
                10,
                20_000,
            )
            .await
            .expect("command should start");
        let session_id = started.session_id.expect("session id");
        assert!(sessions.sessions.lock().await.contains_key(&session_id));

        sessions.terminate_all();
        assert!(sessions.sessions.lock().await.is_empty());
        tokio::time::sleep(Duration::from_millis(300)).await;
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn timeout_stops_running_command() {
        let root = temp_workspace();
        let sessions = CommandSessionManager::new(root.clone(), root.join("logs"));
        let output = sessions
            .exec_command(
                WorkspaceCancellation::new(),
                "sleep 0.2; touch leaked.txt",
                ".",
                &default_command_shell(),
                25,
                5_000,
                20_000,
            )
            .await
            .expect("timed out command should return a result");

        assert!(!output.running);
        assert!(!output.success);
        assert!(output.timed_out);
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(!root.join("leaked.txt").exists());
        fs::remove_dir_all(root).unwrap();
    }
}
