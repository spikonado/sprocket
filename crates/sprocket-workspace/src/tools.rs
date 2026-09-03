use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use crate::paths::expand_home;
use crate::text::limit_chars;
use anyhow::{Context, Result, anyhow, bail};
use serde::Serialize;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{Mutex, mpsc, oneshot, watch};
use tokio_util::sync::CancellationToken;

const MAX_COMMAND_MAX_OUTPUT_CHARS: usize = 80_000;
const MAX_COMMAND_CAPTURE_BYTES: usize = 1_000_000;
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
    sessions: Arc<Mutex<HashMap<String, Arc<CommandSession>>>>,
    next_session_id: Arc<AtomicU64>,
}

impl CommandSessionManager {
    pub fn new(workspace_root: PathBuf) -> Self {
        Self {
            workspace_root,
            sessions: Arc::new(Mutex::new(HashMap::new())),
            next_session_id: Arc::new(AtomicU64::new(1)),
        }
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
            .with_context(|| format!("failed to start command in {}", cwd.display()))?;
        let process_id = child.id();
        let (stdin, stdin_requests) = mpsc::channel(STDIN_QUEUE_CAPACITY);
        let stdin_task = tokio::spawn(write_command_input(child.stdin.take(), stdin_requests));
        let stdout = Arc::new(Mutex::new(CapturedOutput::default()));
        let stderr = Arc::new(Mutex::new(CapturedOutput::default()));
        let stdout_task = tokio::spawn(capture_pipe(child.stdout.take(), stdout.clone()));
        let stderr_task = tokio::spawn(capture_pipe(child.stderr.take(), stderr.clone()));
        let (control, controls) = mpsc::unbounded_channel();
        let (completion_sender, completion) = watch::channel(None);
        tokio::spawn(supervise_command(
            child,
            process_id,
            controls,
            completion_sender,
            stdin_task,
            stdout_task,
            stderr_task,
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
            output_limit: max_output_chars.clamp(1, MAX_COMMAND_MAX_OUTPUT_CHARS),
            control,
            stdin,
            completion,
            stdout,
            stderr,
            cursor: Mutex::new(OutputCursor::default()),
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
            .ok_or_else(|| anyhow!("unknown or completed command session: {session_id}"))?;

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
        let output = session.output(completion.clone()).await;
        if completion.is_some() {
            self.sessions.lock().await.remove(&session.id);
        }
        Ok(output)
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
                let mut output = session.output(Some(completion)).await;
                output.success = false;
                let write_error = format!("failed to write command stdin: {write_error:#}");
                output.error = Some(match output.error {
                    Some(completion_error) => format!("{completion_error}; {write_error}"),
                    None => write_error,
                });
                self.sessions.lock().await.remove(&session.id);
                Ok(output)
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
    output_limit: usize,
    control: mpsc::UnboundedSender<CommandControl>,
    stdin: mpsc::Sender<StdinRequest>,
    completion: watch::Receiver<Option<CommandCompletion>>,
    stdout: Arc<Mutex<CapturedOutput>>,
    stderr: Arc<Mutex<CapturedOutput>>,
    cursor: Mutex<OutputCursor>,
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
        let mut cursor = self.cursor.lock().await;
        let (stdout, stdout_truncated) = self.stdout.lock().await.read_from(&mut cursor.stdout);
        let (stderr, stderr_truncated) = self.stderr.lock().await.read_from(&mut cursor.stderr);
        let stdout = String::from_utf8_lossy(&stdout).to_string();
        let stderr = String::from_utf8_lossy(&stderr).to_string();
        let combined = combine_command_output(&stdout, &stderr);
        let (output, limit_truncated) = limit_chars(&combined, self.output_limit);
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
            output,
            truncated: stdout_truncated || stderr_truncated || limit_truncated,
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

#[derive(Default)]
struct OutputCursor {
    stdout: usize,
    stderr: usize,
}

#[derive(Default)]
struct CapturedOutput {
    bytes: Vec<u8>,
    dropped: usize,
}

impl CapturedOutput {
    fn append(&mut self, chunk: &[u8]) {
        self.bytes.extend_from_slice(chunk);
        if self.bytes.len() > MAX_COMMAND_CAPTURE_BYTES {
            let excess = self.bytes.len() - MAX_COMMAND_CAPTURE_BYTES;
            self.bytes.drain(..excess);
            self.dropped += excess;
        }
    }

    fn read_from(&self, cursor: &mut usize) -> (Vec<u8>, bool) {
        let truncated = *cursor < self.dropped;
        let absolute_start = (*cursor).max(self.dropped);
        let relative_start = absolute_start - self.dropped;
        let output = self.bytes[relative_start..].to_vec();
        *cursor = self.dropped + self.bytes.len();
        (output, truncated)
    }
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
    stdout_task: tokio::task::JoinHandle<Result<()>>,
    stderr_task: tokio::task::JoinHandle<Result<()>>,
    timeout_ms: u64,
) {
    let timeout = tokio::time::sleep(Duration::from_millis(timeout_ms));
    tokio::pin!(timeout);
    let mut poll = tokio::time::interval(Duration::from_millis(PROCESS_POLL_INTERVAL_MS));
    poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    let (status, timed_out, mut error) = loop {
        tokio::select! {
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

    if let Err(capture_error) = join_capture_task(stdout_task).await {
        error.get_or_insert_with(|| capture_error.to_string());
    }
    if let Err(capture_error) = join_capture_task(stderr_task).await {
        error.get_or_insert_with(|| capture_error.to_string());
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

async fn capture_pipe<T>(pipe: Option<T>, output: Arc<Mutex<CapturedOutput>>) -> Result<()>
where
    T: AsyncRead + Unpin,
{
    let Some(mut pipe) = pipe else {
        return Ok(());
    };
    let mut buffer = [0_u8; 8_192];
    loop {
        let read = pipe.read(&mut buffer).await?;
        if read == 0 {
            return Ok(());
        }
        output.lock().await.append(&buffer[..read]);
    }
}

async fn join_capture_task(mut task: tokio::task::JoinHandle<Result<()>>) -> Result<()> {
    match tokio::time::timeout(Duration::from_secs(1), &mut task).await {
        Ok(result) => result.context("command output task failed")?,
        Err(_) => {
            task.abort();
            let _ = task.await;
            Ok(())
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
    async fn exec_command_defaults_to_workspace_root() {
        let root = temp_workspace();
        let sessions = CommandSessionManager::new(root.clone());
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
        let sessions = CommandSessionManager::new(root.clone());
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
        let sessions = CommandSessionManager::new(root.clone());
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
        let sessions = CommandSessionManager::new(root.clone());
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
        let sessions = CommandSessionManager::new(root.clone());
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
        let sessions = CommandSessionManager::new(root.clone());
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
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn cancelled_poll_removes_and_terminates_session() {
        let root = temp_workspace();
        let sessions = CommandSessionManager::new(root.clone());
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
        let sessions = CommandSessionManager::new(root.clone());
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
        let sessions = CommandSessionManager::new(root.clone());
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
        let sessions = CommandSessionManager::new(root.clone());
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
