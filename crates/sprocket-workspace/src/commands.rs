use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::async_tools::{YieldMode, ZeroPollCooldown};
use crate::command_history::{CommandHistory, history_path};
use crate::command_output::{CapturedOutput, CommandOutputLimits, OutputChannel};
use crate::command_shell::resolve_command_shell;
use crate::paths::expand_home;
use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{Mutex, mpsc, oneshot, watch};
use tokio_util::sync::CancellationToken;

const MAX_COMMAND_MAX_OUTPUT_CHARS: usize = 80_000;
pub use crate::async_tools::{
    MAX_YIELD_MS as MAX_COMMAND_YIELD_MS, MIN_POLL_YIELD_MS as MIN_COMMAND_POLL_YIELD_MS,
};
const PROCESS_POLL_INTERVAL_MS: u64 = 25;
const STDIN_QUEUE_CAPACITY: usize = 8;

#[derive(Clone, Copy, Debug)]
pub enum CommandAction {
    Write,
    Terminate,
}

impl CommandAction {
    pub fn validate(self, chars: &str) -> Result<()> {
        match self {
            Self::Write if chars.is_empty() => bail!("a write action requires nonempty chars"),
            Self::Terminate if !chars.is_empty() => {
                bail!("a terminate action requires empty chars")
            }
            _ => Ok(()),
        }
    }
}

#[derive(Clone, Copy)]
enum ObservationMode {
    Metadata,
    Output,
    ZeroPoll,
}

impl ObservationMode {
    fn after_action(yield_time_ms: u64) -> Self {
        if yield_time_ms == 0 {
            Self::Metadata
        } else {
            Self::Output
        }
    }
}

#[derive(Default)]
struct CommandObservation {
    final_output: Option<CommandOutput>,
    zero_poll_cooldown: ZeroPollCooldown,
}

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

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningCommand {
    pub session_id: String,
    pub command: String,
    pub workdir: String,
    pub started_at: u64,
}

type CommandLifetimeGuard = Box<dyn Send + Sync>;
type CommandLifetimeGuardFactory = Arc<dyn Fn() -> Result<CommandLifetimeGuard> + Send + Sync>;
type HistoryFuture =
    std::pin::Pin<Box<dyn std::future::Future<Output = Result<Option<CommandHistory>>> + Send>>;
type HistoryResolver = Arc<dyn Fn(String, PathBuf) -> HistoryFuture + Send + Sync>;

#[derive(Clone)]
pub struct CommandSessionManager {
    workspace_root: PathBuf,
    log_directory: PathBuf,
    output_limits: CommandOutputLimits,
    sessions: Arc<Mutex<HashMap<String, Arc<CommandSession>>>>,
    stopped: Arc<AtomicBool>,
    lifetime_guard_factory: Option<CommandLifetimeGuardFactory>,
    history_scope: (String, String, String),
    history_resolver: Option<HistoryResolver>,
    history_fetch_lock: Arc<Mutex<()>>,
}

impl CommandSessionManager {
    pub fn new(workspace_root: PathBuf, log_directory: PathBuf) -> Self {
        Self {
            workspace_root,
            log_directory,
            output_limits: CommandOutputLimits::default(),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            stopped: Arc::new(AtomicBool::new(false)),
            lifetime_guard_factory: None,
            history_scope: Default::default(),
            history_resolver: None,
            history_fetch_lock: Arc::new(Mutex::new(())),
        }
    }

    pub fn with_workspace_root(mut self, workspace_root: PathBuf) -> Self {
        self.workspace_root = workspace_root;
        self
    }

    pub fn with_history_scope(
        mut self,
        user_id: String,
        thread_id: String,
        machine_id: String,
    ) -> Self {
        self.history_scope = (user_id, thread_id, machine_id);
        self
    }

    pub async fn history_snapshot(
        &self,
        session_id: &str,
        history: &mut CommandHistory,
    ) -> Result<()> {
        if let Some(session) = self.session(session_id).await {
            let capture = session.output.lock().await;
            let completion = session.completion.borrow().clone();
            let preview = capture.full_preview();
            match completion {
                Some(completion) => history.result = completion_output(&completion, preview),
                None => history.result.output = preview.output,
            }
        } else {
            history
                .recover_if_running(&self.log_directory, session_id)
                .await?;
        }
        Ok(())
    }

    pub fn with_history_resolver<F, Fut>(mut self, resolver: F) -> Self
    where
        F: Fn(String, PathBuf) -> Fut + Send + Sync + 'static,
        Fut: std::future::Future<Output = Result<Option<CommandHistory>>> + Send + 'static,
    {
        self.history_resolver = Some(Arc::new(move |id, directory| {
            Box::pin(resolver(id, directory))
        }));
        self
    }

    async fn saved_result(&self, session_id: &str) -> Result<CommandStdinOutput> {
        let path = history_path(&self.log_directory, session_id)?;
        let local = match tokio::fs::read(path).await {
            Ok(bytes) => Some(serde_json::from_slice::<CommandHistory>(&bytes)?),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        if local.as_ref().is_none_or(|history| {
            history.machine_id != self.history_scope.2 && history.result.running
        }) {
            if let Some(resolver) = &self.history_resolver {
                let fetched = tokio::time::timeout(Duration::from_secs(10), async {
                    let _fetch = self.history_fetch_lock.lock().await;
                    resolver(session_id.to_string(), self.log_directory.clone()).await
                })
                .await
                .context("remote command history fetch timed out")
                .and_then(|result| result);
                match fetched {
                    Ok(Some(history)) => {
                        return Ok(CommandStdinOutput {
                            command: history.command,
                            workdir: history.workdir,
                            result: history.result,
                        });
                    }
                    Err(error) if local.is_none() => return Err(error),
                    _ => {}
                }
            }
        }
        let Some(history) = local else {
            bail!("unknown command session: {session_id}");
        };
        if history.machine_id == self.history_scope.2 && history.result.running {
            // The supervisor may have archived this session since the initial read.
            return CommandHistory::load(&self.log_directory, session_id).await;
        }
        Ok(CommandStdinOutput {
            command: history.command,
            workdir: history.workdir,
            result: history.result,
        })
    }

    /// Keeps the process's host alive independently of the initiating run.
    /// The guard is acquired before spawning and released by the supervisor.
    pub fn with_lifetime_guard_factory<F, G>(mut self, factory: F) -> Self
    where
        F: Fn() -> Result<G> + Send + Sync + 'static,
        G: Send + Sync + 'static,
    {
        self.lifetime_guard_factory = Some(Arc::new(move || {
            factory().map(|guard| Box::new(guard) as CommandLifetimeGuard)
        }));
        self
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
        timeout_ms: Option<u64>,
        yield_time_ms: u64,
        max_output_chars: usize,
    ) -> Result<CommandExecOutput> {
        cancellation.ensure_active()?;
        self.prune_completed().await;
        if command.trim().is_empty() {
            bail!("command cannot be empty");
        }

        let cwd = resolve_command_workdir(&self.workspace_root, workdir)?;
        let shell = resolve_command_shell(shell, &cwd)?;
        let output = Arc::new(Mutex::new(
            CapturedOutput::create_with_limits(
                &self.log_directory,
                max_output_chars.min(MAX_COMMAND_MAX_OUTPUT_CHARS),
                self.output_limits,
            )
            .await?,
        ));
        let mut process = build_shell_command(command, &shell);
        process
            .current_dir(&cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(unix)]
        process.process_group(0);

        let mut sessions = self.sessions.lock().await;
        cancellation.ensure_active()?;
        if self.stopped.load(Ordering::Acquire) {
            bail!("command sessions are shutting down");
        }
        let session_id = uuid::Uuid::new_v4().to_string();
        let history_path = history_path(&self.log_directory, &session_id)?;
        let preview = output.lock().await.preview_metadata();
        let history = CommandHistory {
            user_id: self.history_scope.0.clone(),
            thread_id: self.history_scope.1.clone(),
            machine_id: self.history_scope.2.clone(),
            command: command.to_string(),
            workdir: cwd.to_string_lossy().to_string(),
            max_output_chars: max_output_chars.min(MAX_COMMAND_MAX_OUTPUT_CHARS),
            result: CommandOutput {
                exit_code: None,
                success: false,
                running: true,
                timed_out: false,
                output: String::new(),
                complete_log_path: preview.complete_log_path,
                events_path: preview.events_path,
                error: None,
            },
        };
        history.save(&history_path).await?;
        let launch: Result<_> = (|| {
            cancellation.ensure_active()?;
            if self.stopped.load(Ordering::Acquire) {
                bail!("command sessions are shutting down");
            }
            let lifetime_guard = self
                .lifetime_guard_factory
                .as_ref()
                .map(|factory| factory())
                .transpose()?;
            let child = process.spawn().with_context(|| {
                format!("failed to start shell \"{shell}\" in {}", cwd.display())
            })?;
            Ok((child, lifetime_guard))
        })();
        let (mut child, lifetime_guard) = match launch {
            Ok(launched) => launched,
            Err(error) => {
                let history_cleanup = tokio::fs::remove_file(&history_path).await;
                let log_cleanup = output.lock().await.discard().await;
                if let Err(cleanup_error) = history_cleanup {
                    return Err(error.context(format!(
                        "failed to remove unstarted command history: {cleanup_error}"
                    )));
                }
                if let Err(cleanup_error) = log_cleanup {
                    return Err(error.context(cleanup_error));
                }
                return Err(error);
            }
        };
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
            timeout_ms.map(|timeout_ms| Duration::from_millis(timeout_ms.max(1))),
            lifetime_guard,
            (history_path, history),
        ));

        // Sessions appear in saved agent history and browser requests, so their
        // IDs must remain distinct when a manager or the server is recreated.
        let session = Arc::new(CommandSession {
            id: session_id.clone(),
            command: command.to_string(),
            workdir: cwd.to_string_lossy().to_string(),
            started_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
            control,
            stdin,
            completion,
            output,
            observation: Mutex::new(CommandObservation::default()),
        });
        sessions.insert(session_id.clone(), session.clone());
        drop(sessions);

        let result = self
            .observe_session(
                session,
                cancellation,
                yield_time_ms,
                ObservationMode::after_action(yield_time_ms),
            )
            .await?;
        Ok(CommandExecOutput {
            session_id: Some(session_id),
            result,
        })
    }

    pub async fn control_command(
        &self,
        cancellation: WorkspaceCancellation,
        session_id: &str,
        action: CommandAction,
        chars: &str,
        yield_time_ms: u64,
    ) -> Result<CommandStdinOutput> {
        action.validate(chars)?;
        cancellation.ensure_active()?;
        let Some(session) = self.session(session_id).await else {
            let mut output = tokio::select! {
                _ = cancellation.cancelled() => return Err(WorkspaceOperationCancelled.into()),
                result = self.saved_result(session_id) => result?,
            };
            if output.result.running {
                bail!(
                    "command is running on another machine; control it on its originating machine"
                );
            }
            if yield_time_ms == 0 {
                output.result.output.clear();
            }
            return Ok(output);
        };
        let result = self
            .write_session(session.clone(), cancellation, action, chars, yield_time_ms)
            .await?;
        Ok(CommandStdinOutput {
            command: session.command.clone(),
            workdir: session.workdir.clone(),
            result,
        })
    }

    pub async fn poll_command(
        &self,
        cancellation: WorkspaceCancellation,
        session_id: &str,
        yield_time_ms: u64,
    ) -> Result<CommandStdinOutput> {
        cancellation.ensure_active()?;
        let Some(session) = self.session(session_id).await else {
            return tokio::select! {
                _ = cancellation.cancelled() => Err(WorkspaceOperationCancelled.into()),
                result = self.saved_result(session_id) => result,
            };
        };
        let yield_time_ms = YieldMode::Poll.normalize(yield_time_ms);
        let mode = if yield_time_ms == 0 {
            ObservationMode::ZeroPoll
        } else {
            ObservationMode::Output
        };
        let result = self
            .observe_session(session.clone(), cancellation, yield_time_ms, mode)
            .await?;
        Ok(CommandStdinOutput {
            command: session.command.clone(),
            workdir: session.workdir.clone(),
            result,
        })
    }

    /// Lists live processes without consuming command output or poll cooldowns.
    pub async fn running_commands(&self) -> Vec<RunningCommand> {
        let sessions = self.sessions.lock().await;
        let mut commands = sessions
            .values()
            .filter(|session| session.completion.borrow().is_none())
            .map(|session| RunningCommand {
                session_id: session.id.clone(),
                command: session.command.clone(),
                workdir: session.workdir.clone(),
                started_at: session.started_at,
            })
            .collect::<Vec<_>>();
        commands.sort_by(|a, b| (a.started_at, &a.session_id).cmp(&(b.started_at, &b.session_id)));
        commands
    }

    pub async fn terminate_command(&self, session_id: &str) -> bool {
        let session = self.sessions.lock().await.get(session_id).cloned();
        session.is_some_and(|session| {
            session.completion.borrow().is_none() && session.terminate().is_ok()
        })
    }

    /// Release live handles only after their completed results are saved on disk.
    pub async fn prune_completed(&self) {
        let mut sessions = self.sessions.lock().await;
        sessions.retain(|_, session| {
            Arc::strong_count(session) > 1
                || session
                    .completion
                    .borrow()
                    .as_ref()
                    .is_none_or(|completion| !completion.archived)
        });
    }

    /// True when no sessions remain and no clone still holds this manager.
    /// Returns false without waiting if another task holds the session lock.
    pub fn try_is_unused(&self) -> bool {
        self.sessions
            .try_lock()
            .is_ok_and(|sessions| sessions.is_empty() && Arc::strong_count(&self.sessions) == 1)
    }

    async fn session(&self, session_id: &str) -> Option<Arc<CommandSession>> {
        self.sessions.lock().await.get(session_id).cloned()
    }

    async fn write_session(
        &self,
        session: Arc<CommandSession>,
        cancellation: WorkspaceCancellation,
        action: CommandAction,
        chars: &str,
        yield_time_ms: u64,
    ) -> Result<CommandOutput> {
        cancellation.ensure_active()?;

        if session.completion.borrow().is_none() {
            match action {
                CommandAction::Write => {
                    if let Err(error) = session
                        .write(chars.as_bytes().to_vec(), &cancellation)
                        .await
                    {
                        if error
                            .downcast_ref::<WorkspaceOperationCancelled>()
                            .is_some()
                        {
                            return Err(error);
                        }
                        return self
                            .observe_after_write_error(session, cancellation, yield_time_ms, error)
                            .await;
                    }
                }
                CommandAction::Terminate => session.terminate()?,
            }
        }

        self.observe_session(
            session,
            cancellation,
            yield_time_ms,
            ObservationMode::after_action(yield_time_ms),
        )
        .await
    }

    pub async fn stop_all(&self) {
        self.stopped.store(true, Ordering::Release);
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

    async fn observe_session(
        &self,
        session: Arc<CommandSession>,
        cancellation: WorkspaceCancellation,
        yield_time_ms: u64,
        mode: ObservationMode,
    ) -> Result<CommandOutput> {
        let completion = wait_for_completion(&session, &cancellation, yield_time_ms).await?;
        session.output_snapshot(completion, None, mode).await
    }

    async fn observe_after_write_error(
        &self,
        session: Arc<CommandSession>,
        cancellation: WorkspaceCancellation,
        yield_time_ms: u64,
        write_error: anyhow::Error,
    ) -> Result<CommandOutput> {
        match wait_for_completion(&session, &cancellation, yield_time_ms).await {
            Ok(Some(completion)) => {
                let write_error = format!("failed to write command stdin: {write_error:#}");
                session
                    .output_snapshot(
                        Some(completion),
                        Some(write_error),
                        ObservationMode::after_action(yield_time_ms),
                    )
                    .await
            }
            Ok(None) => {
                let _ = session.terminate();
                Err(write_error)
            }
            Err(error) => Err(error),
        }
    }
}

struct CommandSession {
    id: String,
    command: String,
    workdir: String,
    started_at: u64,
    control: mpsc::UnboundedSender<CommandControl>,
    stdin: mpsc::Sender<StdinRequest>,
    completion: watch::Receiver<Option<CommandCompletion>>,
    output: Arc<Mutex<CapturedOutput>>,
    observation: Mutex<CommandObservation>,
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

    async fn output_snapshot(
        &self,
        completion: Option<CommandCompletion>,
        write_error: Option<String>,
        mode: ObservationMode,
    ) -> Result<CommandOutput> {
        let mut observation = self.observation.lock().await;
        let mut output = match observation.final_output.as_ref() {
            Some(output) => output.clone(),
            None => {
                self.snapshot_output(completion, mode, &mut observation)
                    .await?
            }
        };
        if let Some(write_error) = write_error {
            output.success = false;
            output.error = Some(match output.error {
                Some(completion_error) => format!("{completion_error}; {write_error}"),
                None => write_error,
            });
        }
        if !output.running {
            observation.final_output = Some(output.clone());
        }
        if matches!(mode, ObservationMode::Metadata) {
            output.output.clear();
        }
        Ok(output)
    }

    async fn snapshot_output(
        &self,
        completion: Option<CommandCompletion>,
        mode: ObservationMode,
        observation: &mut CommandObservation,
    ) -> Result<CommandOutput> {
        let mut capture = self.output.lock().await;
        // Completion can arrive while this observer waits for the capture lock.
        let completion = completion.or_else(|| self.completion.borrow().clone());
        let pending_zero_poll = completion.is_none() && matches!(mode, ObservationMode::ZeroPoll);
        if pending_zero_poll {
            observation
                .zero_poll_cooldown
                .check()
                .map_err(|error| anyhow!(error.message("Command is still running.")))?;
        }
        let preview = if completion.is_some() {
            capture.full_preview()
        } else if !matches!(mode, ObservationMode::Metadata) {
            capture.take_preview()
        } else {
            capture.preview_metadata()
        };
        if pending_zero_poll {
            observation.zero_poll_cooldown.record_success();
        }
        let running = completion.is_none();
        let completion = completion.unwrap_or_default();

        Ok(CommandOutput {
            exit_code: completion.exit_code,
            success: completion.success,
            running,
            timed_out: completion.timed_out,
            output: preview.output,
            complete_log_path: preview.complete_log_path,
            events_path: preview.events_path,
            error: completion.error,
        })
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
    archived: bool,
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
    cancellation.ensure_active()?;
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
            Duration::from_millis(YieldMode::Action.normalize(yield_time_ms)),
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
    timeout: Option<Duration>,
    lifetime_guard: Option<CommandLifetimeGuard>,
    history: (PathBuf, CommandHistory),
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
}

fn completion_output(
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

async fn wait_for_timeout(timeout: Option<Duration>) {
    match timeout {
        Some(timeout) => tokio::time::sleep(timeout).await,
        None => std::future::pending::<()>().await,
    }
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(flatten)]
    pub result: CommandOutput,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandStdinOutput {
    pub command: String,
    pub workdir: String,
    #[serde(flatten)]
    pub result: CommandOutput,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandOutput {
    #[serde(
        default,
        deserialize_with = "deserialize_exit_code",
        skip_serializing_if = "Option::is_none"
    )]
    pub exit_code: Option<i32>,
    pub success: bool,
    pub running: bool,
    pub timed_out: bool,
    pub output: String,
    #[serde(default)]
    pub complete_log_path: String,
    #[serde(default)]
    pub events_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn deserialize_exit_code<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<i32>, D::Error> {
    Option::<f64>::deserialize(deserializer)?
        .map(|value| {
            if !value.is_finite()
                || value.fract() != 0.0
                || value < i32::MIN as f64
                || value > i32::MAX as f64
            {
                return Err(serde::de::Error::custom("invalid command exit code"));
            }
            Ok(value as i32)
        })
        .transpose()
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;
    use std::sync::Arc;
    use std::time::Duration;

    use super::{
        CapturedOutput, CommandAction, CommandCompletion, CommandObservation, CommandOutput,
        CommandSession, CommandSessionManager, ObservationMode, OutputChannel,
        WorkspaceCancellation,
    };
    use crate::default_command_shell;
    use crate::test_support::temp_workspace;
    use tokio::sync::{Mutex, mpsc, watch};

    async fn wait_for_log(path: &str, expected: &[u8]) {
        tokio::time::timeout(Duration::from_secs(2), async {
            while fs::read(path).unwrap() != expected {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
    }

    struct StubSession {
        session: Arc<CommandSession>,
        completion: watch::Sender<Option<CommandCompletion>>,
        output: Arc<Mutex<CapturedOutput>>,
    }

    impl StubSession {
        async fn append(&self, bytes: &[u8]) {
            self.output
                .lock()
                .await
                .append(OutputChannel::Stdout, bytes)
                .await
                .unwrap();
        }

        fn complete(&self) {
            self.completion.send(Some(completed_ok())).unwrap();
        }

        async fn observe(&self, mode: ObservationMode) -> anyhow::Result<CommandOutput> {
            self.session.output_snapshot(None, None, mode).await
        }

        async fn last_zero_poll(&self) -> Option<tokio::time::Instant> {
            self.session
                .observation
                .lock()
                .await
                .zero_poll_cooldown
                .last_success()
        }
    }

    fn completed_ok() -> CommandCompletion {
        CommandCompletion {
            archived: true,
            exit_code: Some(0),
            success: true,
            timed_out: false,
            error: None,
        }
    }

    fn assert_cooldown_rejected(result: anyhow::Result<CommandOutput>, remaining_seconds: u64) {
        assert_eq!(
            result
                .expect_err("zero poll inside the cooldown must be rejected")
                .to_string(),
            format!(
                "Command is still running. Check again after {remaining_seconds}s or use a higher `yieldTimeMs`."
            )
        );
    }

    async fn stub_session(root: &Path) -> StubSession {
        let output = CapturedOutput::create(&root.join("logs"), 20_000)
            .await
            .unwrap();
        let (completion, completion_rx) = watch::channel(None);
        let (control, _controls) = mpsc::unbounded_channel();
        let (stdin, _requests) = mpsc::channel(1);
        let output = Arc::new(Mutex::new(output));
        StubSession {
            session: Arc::new(CommandSession {
                id: "test".into(),
                command: "test".into(),
                workdir: root.to_string_lossy().into_owned(),
                started_at: 0,
                control,
                stdin,
                completion: completion_rx,
                output: output.clone(),
                observation: Mutex::new(CommandObservation::default()),
            }),
            completion,
            output,
        }
    }

    async fn exec_running_with_timeout(
        sessions: &CommandSessionManager,
        command: &str,
        timeout_ms: Option<u64>,
    ) -> (String, CommandOutput) {
        let started = sessions
            .exec_command(
                WorkspaceCancellation::new(),
                command,
                ".",
                &default_command_shell(),
                timeout_ms,
                0,
                20_000,
            )
            .await
            .expect("command should start");
        (started.session_id.unwrap(), started.result)
    }

    async fn exec_running(
        sessions: &CommandSessionManager,
        command: &str,
    ) -> (String, CommandOutput) {
        exec_running_with_timeout(sessions, command, Some(10_000)).await
    }

    async fn write(
        sessions: &CommandSessionManager,
        id: &str,
        chars: &str,
        yield_time_ms: u64,
    ) -> CommandOutput {
        sessions
            .control_command(
                WorkspaceCancellation::new(),
                id,
                CommandAction::Write,
                chars,
                yield_time_ms,
            )
            .await
            .unwrap()
            .result
    }

    async fn terminate(
        sessions: &CommandSessionManager,
        id: &str,
        yield_time_ms: u64,
    ) -> CommandOutput {
        sessions
            .control_command(
                WorkspaceCancellation::new(),
                id,
                CommandAction::Terminate,
                "",
                yield_time_ms,
            )
            .await
            .unwrap()
            .result
    }

    async fn poll(sessions: &CommandSessionManager, id: &str, yield_time_ms: u64) -> CommandOutput {
        sessions
            .poll_command(WorkspaceCancellation::new(), id, yield_time_ms)
            .await
            .unwrap()
            .result
    }

    #[tokio::test]
    async fn waiting_poll_returns_incremental_output_while_command_is_running() {
        let root = temp_workspace();
        let sessions = CommandSessionManager::new(root.clone(), root.join("logs"));
        let stub = stub_session(&root).await;
        sessions
            .sessions
            .lock()
            .await
            .insert(stub.session.id.clone(), stub.session.clone());
        stub.append(b"ready").await;
        tokio::time::pause();
        let running = poll(&sessions, &stub.session.id, 10_000).await;
        assert!(running.running);
        assert_eq!(running.output, "ready");
        tokio::time::resume();
        stub.append(b":done").await;
        stub.complete();
        let finished = poll(&sessions, &stub.session.id, 10_000).await;
        assert!(finished.success);
        assert_eq!(finished.output, "ready:done");
        fs::remove_dir_all(root).unwrap();
    }

    async fn await_completion(sessions: &CommandSessionManager, id: &str) {
        let mut completion = sessions.sessions.lock().await[id].completion.clone();
        tokio::time::timeout(Duration::from_secs(2), async {
            while completion.borrow().is_none() {
                completion.changed().await.unwrap();
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn zero_yield_poll_reveals_output_zero_yield_controls_hide_it() {
        let root = temp_workspace();
        let sessions = CommandSessionManager::new(root.clone(), root.join("logs"));
        let (id, started) = exec_running(
            &sessions,
            "printf ready; read value; printf ':%s' \"$value\" >&2",
        )
        .await;
        assert!(
            started.output.is_empty(),
            "exec with zero yieldTimeMs hides output"
        );
        wait_for_log(&started.complete_log_path, b"ready").await;
        let running = poll(&sessions, &id, 0).await;
        assert!(running.running);
        assert_eq!(
            running.output, "ready",
            "poll with zero yieldTimeMs shows output"
        );

        let sent = write(&sessions, &id, "done\n", 0).await;
        assert!(
            sent.output.is_empty(),
            "control with zero yieldTimeMs hides output"
        );
        await_completion(&sessions, &id).await;

        let finished = poll(&sessions, &id, 0).await;
        assert!(finished.success);
        assert!(!finished.running);
        assert_eq!(
            finished.output, "ready:done",
            "completed output includes bytes already observed by earlier runs"
        );
        assert_eq!(
            fs::read(&finished.complete_log_path).unwrap(),
            b"ready:done"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn completed_session_replays_cached_output_and_skips_yield_waits() {
        let root = temp_workspace();
        let sessions = CommandSessionManager::new(root.clone(), root.join("logs"));
        let (id, _started) = exec_running_with_timeout(&sessions, "printf done", None).await;

        let finished = poll(&sessions, &id, 10_000).await;
        assert!(finished.success);
        assert_eq!(finished.output, "done");

        for _ in 0..2 {
            let replay = poll(&sessions, &id, 0).await;
            assert!(!replay.running);
            assert_eq!(replay.output, "done");
            assert_eq!(replay.exit_code, Some(0));
        }
        let replay = poll(&sessions, &id, 270_000).await;
        assert_eq!(
            replay.output, "done",
            "a waiting poll on a completed session must return immediately, not wait for new output"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn zero_yield_controls_hide_output_even_after_completion_is_cached() {
        let root = temp_workspace();
        let sessions = CommandSessionManager::new(root.clone(), root.join("logs"));
        let (id, _started) = exec_running(&sessions, "read value; printf done").await;
        write(&sessions, &id, "go\n", 0).await;
        await_completion(&sessions, &id).await;

        let terminated = terminate(&sessions, &id, 0).await;
        assert!(
            terminated.output.is_empty(),
            "zero-yield controls must hide output even when the completion is already cached"
        );
        assert!(!terminated.running);
        let revealed = poll(&sessions, &id, 10_000).await;
        assert_eq!(revealed.output, "done");
        fs::remove_dir_all(root).unwrap();
    }

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
                Some(5_000),
                5_000,
                20_000,
            )
            .await
            .unwrap();

        assert_eq!(output.result.output, "starting\nfailed\ncleaning up\n");
        assert_eq!(
            serde_json::to_value(&output).unwrap(),
            serde_json::json!({
                "sessionId": output.session_id,
                "exitCode": 0,
                "success": true,
                "running": false,
                "timedOut": false,
                "output": "starting\nfailed\ncleaning up\n",
                "completeLogPath": output.result.complete_log_path,
                "eventsPath": output.result.events_path,
            })
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn exec_and_control_have_distinct_flat_output_contracts() {
        let root = temp_workspace();
        let sessions = CommandSessionManager::new(root.clone(), root.join("logs"));
        let command = "read value; printf '%s' \"$value\"";
        let started = sessions
            .exec_command(
                WorkspaceCancellation::new(),
                command,
                ".",
                &default_command_shell(),
                Some(5_000),
                0,
                20_000,
            )
            .await
            .unwrap();
        let id = started.session_id.as_deref().unwrap();
        let log_path = &started.result.complete_log_path;
        let events_path = &started.result.events_path;
        assert_eq!(
            serde_json::to_value(&started).unwrap(),
            serde_json::json!({
                "sessionId": id,
                "success": false,
                "running": true,
                "timedOut": false,
                "output": "",
                "completeLogPath": log_path,
                "eventsPath": events_path,
            })
        );
        let running = sessions
            .poll_command(WorkspaceCancellation::new(), id, 0)
            .await
            .unwrap();
        assert_eq!(
            serde_json::to_value(running).unwrap(),
            serde_json::json!({
                "command": command,
                "workdir": root.to_string_lossy(),
                "success": false,
                "running": true,
                "timedOut": false,
                "output": "",
                "completeLogPath": log_path,
                "eventsPath": events_path,
            })
        );
        let finished = sessions
            .control_command(
                WorkspaceCancellation::new(),
                id,
                CommandAction::Write,
                "done\n",
                5_000,
            )
            .await
            .unwrap();
        assert_eq!(
            serde_json::to_value(finished).unwrap(),
            serde_json::json!({
                "command": command,
                "workdir": root.to_string_lossy(),
                "exitCode": 0,
                "success": true,
                "running": false,
                "timedOut": false,
                "output": "done",
                "completeLogPath": log_path,
                "eventsPath": events_path,
            })
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn output_limit_keeps_head_and_tail() {
        let root = temp_workspace();
        let sessions = CommandSessionManager::new(root.clone(), root.join("logs"));
        let output = sessions
            .exec_command(
                WorkspaceCancellation::new(),
                "printf abcdefghijklmnopqrstuvwxyz",
                ".",
                &default_command_shell(),
                Some(5_000),
                5_000,
                22,
            )
            .await
            .unwrap();

        assert_eq!(output.result.output, "ab\n<1 line omitted>\nyz");
        assert_eq!(
            fs::read(&output.result.complete_log_path).unwrap(),
            b"abcdefghijklmnopqrstuvwxyz"
        );
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
                Some(20_000),
                20_000,
                26,
            )
            .await
            .unwrap();

        assert!(output.result.success, "{output:?}");
        assert_eq!(output.result.output, "head\n<1 line omitted>\ntail");
        sessions.stop_all().await;
        drop(sessions);
        let bytes = fs::read(output.result.complete_log_path).unwrap();
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
                Some(5_000),
                0,
                4,
            )
            .await
            .unwrap();
        let id = started.session_id.unwrap();
        write(&sessions, &id, "start\n", 0).await;
        wait_for_log(&started.result.complete_log_path, b"abcdefghij").await;
        let first = poll(&sessions, &id, 0).await;
        assert!(first.running);
        assert_eq!(first.output, "\n<1 line omitted>\n");
        let finished = write(&sessions, &id, "go\n", 5_000).await;
        assert_eq!(finished.output, "\n<1 line omitted>\n");
        assert_eq!(finished.complete_log_path, first.complete_log_path);
        assert_eq!(
            fs::read(&finished.complete_log_path).unwrap(),
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
                Some(5_000),
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
                Some(5_000),
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
                Some(5_000),
                5_000,
                100,
            )
            .await
            .unwrap();
        assert!(!output.result.success);
        assert!(!output.result.running);
        assert!(!output.result.timed_out);
        assert!(output.result.error.unwrap().contains("log quota"));
        assert!(
            fs::read(output.result.complete_log_path)
                .unwrap()
                .is_empty()
        );
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
        let command = "sleep 0.5; touch leaked";
        let output = super::CapturedOutput::create(&root.join("logs"), 100)
            .await
            .unwrap();
        let history_path =
            super::history_path(&root.join("logs"), &uuid::Uuid::new_v4().to_string()).unwrap();
        let history = super::CommandHistory {
            user_id: String::new(),
            thread_id: String::new(),
            machine_id: String::new(),
            command: command.into(),
            workdir: root.to_string_lossy().into_owned(),
            max_output_chars: 100,
            result: super::completion_output(
                &CommandCompletion::default(),
                output.preview_metadata(),
            ),
        };
        let mut process = super::build_shell_command(command, &default_command_shell());
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
            Some(Duration::from_secs(5)),
            None,
            (history_path, history),
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
                Some(5_000),
                0,
                20_000,
            )
            .await
            .unwrap();
        let id = started.session_id.unwrap();
        let (finished, concurrent) = tokio::join!(
            sessions.control_command(
                WorkspaceCancellation::new(),
                &id,
                CommandAction::Write,
                "done\n",
                5_000,
            ),
            sessions.poll_command(WorkspaceCancellation::new(), &id, 5_000),
        );
        let finished = finished.unwrap();
        assert_eq!(concurrent.unwrap().result.output, finished.result.output);
        let repeated = poll(&sessions, &id, 10_000).await;

        assert!(!repeated.running);
        assert_eq!(repeated.output, finished.result.output);
        assert_eq!(repeated.exit_code, finished.result.exit_code);
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
                Some(5_000),
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
        let next = sessions
            .exec_command(
                WorkspaceCancellation::new(),
                "echo started",
                ".",
                &default_command_shell(),
                Some(5_000),
                5_000,
                20_000,
            )
            .await
            .unwrap();
        let records = fs::read_dir(root.join("logs/sessions"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<Vec<_>>();
        assert_eq!(
            records,
            vec![std::ffi::OsString::from(format!(
                "{}.json",
                next.session_id.unwrap()
            ))]
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn failed_process_launch_removes_unstarted_logs_and_history() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().to_path_buf();
        let logs = root.join("logs");
        let sessions = CommandSessionManager::new(root, logs.clone()).with_lifetime_guard_factory(
            || -> anyhow::Result<()> { anyhow::bail!("host unavailable") },
        );
        let error = sessions
            .exec_command(
                WorkspaceCancellation::new(),
                "echo ready",
                ".",
                &default_command_shell(),
                Some(5_000),
                5_000,
                20_000,
            )
            .await
            .unwrap_err();
        assert!(error.to_string().contains("host unavailable"));
        assert_eq!(fs::read_dir(logs).unwrap().count(), 0);
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
                Some(5_000),
                5_000,
                20_000,
            )
            .await
            .expect("command should succeed");

        assert!(output.result.success);
        assert!(
            output
                .result
                .output
                .contains(root.to_string_lossy().as_ref())
        );
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
                Some(5_000),
                5_000,
                20_000,
            )
            .await
            .expect("outside workdir should be allowed");

        assert!(output.result.success);
        assert_eq!(output.result.output.trim(), parent.to_string_lossy());
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn action_waits_honor_short_budgets_and_cap_long_budgets() {
        let root = temp_workspace();
        let stub = stub_session(&root).await;
        stub.append(b"new").await;
        tokio::time::pause();
        for (requested_ms, expected_ms) in [
            (1, 1),
            (5_000, 5_000),
            (29_999, 29_999),
            (30_000, 30_000),
            (90_000, 90_000),
            (270_000, 270_000),
            (u64::MAX, 270_000),
        ] {
            let session = stub.session.clone();
            let waiting = tokio::spawn(async move {
                super::wait_for_completion(&session, &WorkspaceCancellation::new(), requested_ms)
                    .await
                    .unwrap()
            });
            tokio::task::yield_now().await;
            tokio::time::advance(Duration::from_millis(expected_ms - 1)).await;
            assert!(!waiting.is_finished(), "yieldTimeMs: {requested_ms}");
            tokio::time::advance(Duration::from_millis(1)).await;
            assert!(waiting.await.unwrap().is_none());
        }
        let boundary = stub.observe(ObservationMode::Output).await.unwrap();
        assert!(boundary.running);
        assert_eq!(boundary.output, "new");
        stub.append(b"hidden").await;
        let zero = stub.observe(ObservationMode::Metadata).await.unwrap();
        assert!(zero.running);
        assert!(zero.output.is_empty());
        tokio::time::resume();
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn polling_keeps_its_minimum_and_maximum_wait_budgets() {
        let root = temp_workspace();
        let sessions = CommandSessionManager::new(root.clone(), root.join("logs"));
        let stub = stub_session(&root).await;
        sessions
            .sessions
            .lock()
            .await
            .insert(stub.session.id.clone(), stub.session.clone());
        tokio::time::pause();
        for (requested_ms, expected_ms) in [
            (1, 10_000),
            (9_999, 10_000),
            (10_000, 10_000),
            (u64::MAX, 270_000),
        ] {
            let manager = sessions.clone();
            let id = stub.session.id.clone();
            let waiting = tokio::spawn(async move {
                manager
                    .poll_command(WorkspaceCancellation::new(), &id, requested_ms)
                    .await
                    .unwrap()
            });
            tokio::task::yield_now().await;
            tokio::time::advance(Duration::from_millis(expected_ms - 1)).await;
            assert!(!waiting.is_finished(), "yieldTimeMs: {requested_ms}");
            tokio::time::advance(Duration::from_millis(1)).await;
            assert!(waiting.await.unwrap().result.running);
        }
        tokio::time::resume();
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn exec_and_control_return_running_snapshots_after_short_waits() {
        let root = temp_workspace();
        let sessions = CommandSessionManager::new(root.clone(), root.join("logs"));
        let started = sessions
            .exec_command(
                WorkspaceCancellation::new(),
                "read first; printf ready; read last",
                ".",
                &default_command_shell(),
                Some(5_000),
                1,
                20_000,
            )
            .await
            .unwrap();
        assert!(started.result.running);
        let id = started.session_id.unwrap();
        let controlled = write(&sessions, &id, "go\n", 10).await;
        assert!(controlled.running);
        wait_for_log(&controlled.complete_log_path, b"ready").await;
        let finished = write(&sessions, &id, "done\n", 5_000).await;
        assert!(finished.success);
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn command_without_timeout_continues_after_yield() {
        let root = temp_workspace();
        let sessions = CommandSessionManager::new(root.clone(), root.join("logs"));
        let started = sessions
            .exec_command(
                WorkspaceCancellation::new(),
                "sleep 0.1; printf finished",
                ".",
                &default_command_shell(),
                None,
                0,
                20_000,
            )
            .await
            .expect("command should start");

        assert!(started.result.running);
        let finished = poll(&sessions, started.session_id.as_deref().unwrap(), 2_000).await;

        assert!(finished.success);
        assert!(!finished.running);
        assert!(!finished.timed_out);
        assert_eq!(finished.output, "finished");
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn write_sends_input_to_running_command() {
        let root = temp_workspace();
        let sessions = CommandSessionManager::new(root.clone(), root.join("logs"));
        let (id, _started) =
            exec_running(&sessions, "read value; printf 'got:%s' \"$value\"").await;

        let finished = write(&sessions, &id, "hello\n", 5_000).await;

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
                Some(100),
                0,
                20_000,
            )
            .await
            .expect("command should start");

        let finished = tokio::time::timeout(
            Duration::from_secs(2),
            sessions.control_command(
                WorkspaceCancellation::new(),
                started.session_id.as_deref().unwrap(),
                CommandAction::Write,
                &"input".repeat(500_000),
                5_000,
            ),
        )
        .await
        .expect("stdin backpressure must not block the command timeout")
        .expect("timed out command should return a result");

        assert!(finished.result.timed_out);
        assert!(!finished.result.success);
        assert!(!finished.result.running);
        assert!(
            finished
                .result
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
                Some(5_000),
                0,
                20_000,
            )
            .await
            .expect("command should start");
        fs::write(root.join("release"), "").unwrap();

        let finished = sessions
            .control_command(
                WorkspaceCancellation::new(),
                started.session_id.as_deref().unwrap(),
                CommandAction::Write,
                &"input".repeat(500_000),
                5_000,
            )
            .await
            .expect("completed command should return its result");

        assert_eq!(finished.result.exit_code, Some(0));
        assert!(!finished.result.success);
        assert!(!finished.result.running);
        assert!(
            finished
                .result
                .error
                .as_deref()
                .is_some_and(|error| error.contains("failed to write command stdin"))
        );
        let replay = sessions
            .poll_command(
                WorkspaceCancellation::new(),
                started.session_id.as_deref().unwrap(),
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
    async fn cancelled_observation_preserves_command_for_a_later_run() {
        let root = temp_workspace();
        let sessions = CommandSessionManager::new(root.clone(), root.join("logs"));
        let started = sessions
            .exec_command(
                WorkspaceCancellation::new(),
                "while [ ! -f release ]; do sleep 0.01; done; printf survived",
                ".",
                &default_command_shell(),
                Some(5_000),
                0,
                20_000,
            )
            .await
            .expect("command should start");
        let session_id = started.session_id.as_deref().unwrap();
        let cancellation = WorkspaceCancellation::new();
        let observer = sessions.poll_command(cancellation.clone(), session_id, 5_000);
        let cancel = async {
            tokio::task::yield_now().await;
            cancellation.cancel();
        };
        let (result, _) = tokio::join!(observer, cancel);
        assert!(
            result
                .unwrap_err()
                .downcast_ref::<super::WorkspaceOperationCancelled>()
                .is_some()
        );
        let cancelled_write = sessions
            .control_command(cancellation, session_id, CommandAction::Write, "x", 5_000)
            .await;
        assert!(
            cancelled_write
                .unwrap_err()
                .downcast_ref::<super::WorkspaceOperationCancelled>()
                .is_some()
        );
        let running = sessions.running_commands().await;
        assert_eq!(running.len(), 1);
        assert_eq!(running[0].session_id, session_id);
        assert_eq!(running[0].workdir, root.to_string_lossy());
        assert!(running[0].started_at > 0);

        // A fresh run cancellation token can still observe the command's result.
        fs::write(root.join("release"), "").unwrap();
        let finished = poll(&sessions, session_id, 5_000).await;
        assert!(finished.success);
        assert_eq!(finished.output, "survived");
        assert!(sessions.running_commands().await.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn cancelled_exec_keeps_the_started_command_discoverable() {
        let root = temp_workspace();
        let sessions = CommandSessionManager::new(root.clone(), root.join("logs"));
        let cancellation = WorkspaceCancellation::new();
        let cancel = async {
            // Observe registration instead of relying on process startup timing.
            tokio::time::timeout(Duration::from_secs(2), async {
                while sessions.running_commands().await.is_empty() {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("command must register before cancellation");
            cancellation.cancel();
        };
        let shell = default_command_shell();
        let exec = sessions.exec_command(
            cancellation.clone(),
            "sleep 5",
            ".",
            &shell,
            Some(5_000),
            5_000,
            20_000,
        );
        let (result, _) = tokio::join!(exec, cancel);
        assert!(
            result
                .unwrap_err()
                .downcast_ref::<super::WorkspaceOperationCancelled>()
                .is_some()
        );
        let running = sessions.running_commands().await;
        assert_eq!(running.len(), 1);
        assert!(sessions.terminate_command(&running[0].session_id).await);
        let finished = poll(&sessions, &running[0].session_id, 5_000).await;
        assert!(!finished.running);
        assert!(!sessions.terminate_command(&running[0].session_id).await);
        assert!(!sessions.terminate_command("missing").await);
        sessions.stop_all().await;
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn cleanup_releases_archived_handles_and_preserves_live_observations() {
        let root = temp_workspace();
        let sessions = CommandSessionManager::new(root.clone(), root.join("logs"));
        let running = stub_session(&root).await;
        sessions
            .sessions
            .lock()
            .await
            .insert("running".into(), running.session.clone());
        let observed = stub_session(&root).await;
        observed.complete();
        sessions
            .sessions
            .lock()
            .await
            .insert("observed".into(), observed.session.clone());
        let completed = stub_session(&root).await;
        completed.complete();
        sessions
            .sessions
            .lock()
            .await
            .insert("completed".into(), completed.session);
        sessions.prune_completed().await;
        let retained = sessions.sessions.lock().await;
        assert_eq!(retained.len(), 2);
        assert!(retained.contains_key("running"));
        assert!(retained.contains_key("observed"));
        drop(retained);
        drop(observed);
        sessions.prune_completed().await;
        assert!(!sessions.sessions.lock().await.contains_key("observed"));
        sessions.stop_all().await;
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn later_runs_replay_full_output_after_cleanup_and_server_restart() {
        let root = temp_workspace();
        let sessions = CommandSessionManager::new(root.clone(), root.join("logs"));
        let (id, started) =
            exec_running(&sessions, "printf ready; read value; printf ':done'").await;
        wait_for_log(&started.complete_log_path, b"ready").await;
        assert_eq!(poll(&sessions, &id, 0).await.output, "ready");
        write(&sessions, &id, "go\n", 0).await;
        let finished = poll(&sessions, &id, 5_000).await;
        assert_eq!(finished.output, "ready:done");
        sessions.prune_completed().await;
        assert!(sessions.sessions.lock().await.is_empty());
        let replay = sessions
            .poll_command(WorkspaceCancellation::new(), &id, 270_000)
            .await
            .unwrap();
        assert_eq!(replay.command, "printf ready; read value; printf ':done'");
        assert_eq!(replay.result.output, "ready:done");
        assert_eq!(replay.result.exit_code, Some(0));
        assert!(replay.result.success);
        assert_eq!(replay.result.complete_log_path, finished.complete_log_path);
        sessions.stop_all().await;
        drop(sessions);
        let restarted = CommandSessionManager::new(root.clone(), root.join("logs"));
        assert_eq!(poll(&restarted, &id, 0).await.output, "ready:done");
        assert!(terminate(&restarted, &id, 0).await.output.is_empty());
        assert_eq!(poll(&restarted, &id, 0).await.output, "ready:done");
        let other = CommandSessionManager::new(root.clone(), root.join("other-thread"));
        assert!(
            other
                .poll_command(WorkspaceCancellation::new(), &id, 0)
                .await
                .is_err()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn history_snapshot_recovers_the_archive_after_a_running_session_is_pruned() {
        let root = temp_workspace();
        let sessions = CommandSessionManager::new(root.clone(), root.join("logs"));
        let (id, _) = exec_running(&sessions, "read value; printf '%s' \"$value\"").await;
        let mut history = serde_json::from_slice(
            &tokio::fs::read(super::history_path(&root.join("logs"), &id).unwrap())
                .await
                .unwrap(),
        )
        .unwrap();
        sessions.history_snapshot(&id, &mut history).await.unwrap();
        assert!(history.result.running);

        write(&sessions, &id, "done\n", 0).await;
        await_completion(&sessions, &id).await;
        sessions.prune_completed().await;
        sessions.history_snapshot(&id, &mut history).await.unwrap();
        assert!(history.result.success);
        assert!(!history.result.running);
        assert_eq!(history.result.exit_code, Some(0));
        assert_eq!(history.result.output, "done");
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn another_machine_resolves_the_same_session_and_keeps_a_local_replica() {
        let origin = temp_workspace();
        let sessions = CommandSessionManager::new(origin.clone(), origin.join("logs"))
            .with_history_scope("user".into(), "thread".into(), "origin".into());
        let result = sessions
            .exec_command(
                WorkspaceCancellation::new(),
                "printf shared",
                ".",
                &default_command_shell(),
                None,
                5_000,
                20_000,
            )
            .await
            .unwrap();
        let id = result.session_id.unwrap();
        let mut history = serde_json::from_slice(
            &tokio::fs::read(super::history_path(&origin.join("logs"), &id).unwrap())
                .await
                .unwrap(),
        )
        .unwrap();
        sessions.history_snapshot(&id, &mut history).await.unwrap();
        let destination = temp_workspace();
        let expected_id = id.clone();
        let remote = CommandSessionManager::new(destination.clone(), destination.join("logs"))
            .with_history_scope("user".into(), "thread".into(), "destination".into())
            .with_history_resolver(move |id, directory| {
                let expected_id = expected_id.clone();
                let mut history = history.clone();
                async move {
                    assert_eq!(id, expected_id);
                    tokio::fs::create_dir_all(&directory).await?;
                    let log = directory.join("output.log");
                    let events = directory.join("events.jsonl");
                    tokio::fs::copy(&history.result.complete_log_path, &log).await?;
                    tokio::fs::copy(&history.result.events_path, &events).await?;
                    history.result.complete_log_path = log.to_string_lossy().into_owned();
                    history.result.events_path = events.to_string_lossy().into_owned();
                    history.save(&super::history_path(&directory, &id)?).await?;
                    Ok(Some(history))
                }
            });
        let replay = poll(&remote, &id, 0).await;
        assert_eq!(replay.output, "shared");
        assert!(std::path::Path::new(&replay.complete_log_path).starts_with(&destination));
        drop(remote);
        let offline = CommandSessionManager::new(destination.clone(), destination.join("logs"));
        assert_eq!(poll(&offline, &id, 0).await.output, "shared");
        fs::remove_dir_all(origin).unwrap();
        fs::remove_dir_all(destination).unwrap();
    }

    #[tokio::test]
    async fn cached_history_stays_available_during_failed_or_stalled_remote_fetches() {
        let root = temp_workspace();
        let sessions = CommandSessionManager::new(root.clone(), root.join("logs"))
            .with_history_scope("user".into(), "thread".into(), "destination".into());
        let completed = sessions
            .exec_command(
                WorkspaceCancellation::new(),
                "printf cached",
                ".",
                &default_command_shell(),
                None,
                5_000,
                20_000,
            )
            .await
            .unwrap();
        assert!(completed.result.success);
        let completed_id = completed.session_id.unwrap();
        sessions.prune_completed().await;
        let mut remote: super::CommandHistory = serde_json::from_slice(
            &tokio::fs::read(super::history_path(&root.join("logs"), &completed_id).unwrap())
                .await
                .unwrap(),
        )
        .unwrap();
        remote.machine_id = "origin".into();
        remote.result.running = true;
        remote.result.success = false;
        remote.result.exit_code = None;
        remote.result.error = Some("last synced output, not a live process observation".into());
        let remote_id = uuid::Uuid::new_v4().to_string();
        remote
            .save(&super::history_path(&root.join("logs"), &remote_id).unwrap())
            .await
            .unwrap();

        let sessions = sessions.with_history_resolver(|_, _| std::future::pending());
        let manager = sessions.clone();
        let id = remote_id.clone();
        tokio::time::pause();
        let fetching = tokio::spawn(async move { poll(&manager, &id, 0).await });
        while sessions.history_fetch_lock.try_lock().is_ok() {
            tokio::task::yield_now().await;
        }
        assert_eq!(poll(&sessions, &completed_id, 0).await.output, "cached");
        tokio::time::advance(Duration::from_secs(10)).await;
        let cached = fetching.await.unwrap();
        assert!(cached.running);
        assert_eq!(cached.output, "cached");
        assert!(cached.error.unwrap().contains("last synced"));
        let unknown = uuid::Uuid::new_v4().to_string();
        let timed_out = sessions
            .poll_command(WorkspaceCancellation::new(), &unknown, 0)
            .await
            .unwrap_err();
        assert!(timed_out.to_string().contains("timed out"));
        tokio::time::resume();

        let sessions = sessions.with_history_resolver(|_, _| async { anyhow::bail!("offline") });
        let cached = poll(&sessions, &remote_id, 0).await;
        assert!(cached.running);
        assert_eq!(cached.output, "cached");
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn recreated_manager_cannot_retarget_stale_session_ids() {
        let root = temp_workspace();
        let old_sessions = CommandSessionManager::new(root.clone(), root.join("logs"));
        let (old_id, _) = exec_running_with_timeout(&old_sessions, "sleep 5", Some(5_000)).await;
        old_sessions.stop_all().await;
        drop(old_sessions);

        let sessions = CommandSessionManager::new(root.clone(), root.join("logs"));
        let (new_id, _) = exec_running_with_timeout(&sessions, "sleep 5", Some(5_000)).await;
        assert_ne!(old_id, new_id);
        assert!(!sessions.terminate_command(&old_id).await);
        let old_result = sessions
            .control_command(
                WorkspaceCancellation::new(),
                &old_id,
                CommandAction::Terminate,
                "",
                0,
            )
            .await
            .unwrap();
        assert!(!old_result.result.running);
        assert_eq!(sessions.running_commands().await[0].session_id, new_id);
        sessions.stop_all().await;
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn shutdown_rejects_commands_from_existing_manager_clones() {
        let root = temp_workspace();
        let sessions = CommandSessionManager::new(root.clone(), root.join("logs"));
        let run_sessions = sessions.clone();
        sessions.stop_all().await;
        let error = run_sessions
            .exec_command(
                WorkspaceCancellation::new(),
                "touch leaked",
                ".",
                &default_command_shell(),
                None,
                0,
                20_000,
            )
            .await
            .unwrap_err();
        assert!(error.to_string().contains("shutting down"));
        assert!(!root.join("leaked").exists());
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
                Some(5_000),
                0,
                20_000,
            )
            .await
            .expect("command should start");

        let finished = terminate(&sessions, started.session_id.as_deref().unwrap(), 5_000).await;

        assert!(!finished.running);
        assert!(!finished.success);
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(!root.join("leaked.txt").exists());
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
                Some(25),
                5_000,
                20_000,
            )
            .await
            .expect("timed out command should return a result");

        assert!(!output.result.running);
        assert!(!output.result.success);
        assert!(output.result.timed_out);
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(!root.join("leaked.txt").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn zero_poll_cooldown_rejects_until_exactly_10s_and_restarts_on_acceptance() {
        let root = temp_workspace();
        let stub = stub_session(&root).await;

        let first = stub.observe(ObservationMode::ZeroPoll).await.unwrap();
        assert!(first.running);
        let first_poll = stub.last_zero_poll().await;
        assert_cooldown_rejected(stub.observe(ObservationMode::ZeroPoll).await, 10);
        assert_eq!(
            stub.last_zero_poll().await,
            first_poll,
            "a rejected zero poll must not move the cooldown"
        );

        tokio::time::advance(Duration::from_millis(9_001)).await;
        assert_cooldown_rejected(stub.observe(ObservationMode::ZeroPoll).await, 1);

        tokio::time::advance(Duration::from_millis(999)).await;
        stub.observe(ObservationMode::ZeroPoll)
            .await
            .expect("the cooldown expires exactly 10s after the accepted poll");
        assert_ne!(
            stub.last_zero_poll().await,
            first_poll,
            "an accepted zero poll restarts the cooldown"
        );
        assert_cooldown_rejected(stub.observe(ObservationMode::ZeroPoll).await, 10);
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn rejected_zero_poll_keeps_pending_output_and_cooldown() {
        let root = temp_workspace();
        let stub = stub_session(&root).await;
        stub.append(b"ready").await;
        assert_eq!(
            stub.observe(ObservationMode::ZeroPoll)
                .await
                .unwrap()
                .output,
            "ready"
        );

        stub.append(b"more").await;
        tokio::time::advance(Duration::from_secs(5)).await;
        assert_cooldown_rejected(stub.observe(ObservationMode::ZeroPoll).await, 5);

        tokio::time::advance(Duration::from_secs(5)).await;
        let allowed = stub.observe(ObservationMode::ZeroPoll).await.unwrap();
        assert!(allowed.running);
        assert_eq!(
            allowed.output, "more",
            "the rejected poll must not consume output that arrived during the cooldown"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn nonzero_and_metadata_reads_do_not_touch_zero_poll_cooldown() {
        let root = temp_workspace();
        let stub = stub_session(&root).await;
        stub.observe(ObservationMode::ZeroPoll).await.unwrap();
        let last_poll = stub.last_zero_poll().await;

        stub.append(b"waiting").await;
        tokio::time::advance(Duration::from_secs(5)).await;
        let waiting = stub.observe(ObservationMode::Output).await.unwrap();
        assert!(waiting.running);
        assert_eq!(waiting.output, "waiting");
        let metadata = stub.observe(ObservationMode::Metadata).await.unwrap();
        assert!(metadata.output.is_empty());
        assert_eq!(
            stub.last_zero_poll().await,
            last_poll,
            "nonzero and metadata reads must not move the cooldown"
        );

        tokio::time::advance(Duration::from_secs(5)).await;
        stub.observe(ObservationMode::ZeroPoll)
            .await
            .expect("the original cooldown must still expire on schedule");
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn concurrent_zero_polls_admit_exactly_one_running_caller() {
        let root = temp_workspace();
        let stub = stub_session(&root).await;
        stub.append(b"ready").await;

        let mut calls = tokio::task::JoinSet::new();
        for _ in 0..5 {
            let session = stub.session.clone();
            calls.spawn(async move {
                session
                    .output_snapshot(None, None, ObservationMode::ZeroPoll)
                    .await
            });
        }
        let mut admitted = Vec::new();
        while let Some(result) = calls.join_next().await {
            match result.unwrap() {
                Ok(output) => admitted.push(output),
                Err(error) => assert_cooldown_rejected(Err(error), 10),
            }
        }
        assert_eq!(
            admitted.len(),
            1,
            "only one concurrent zero poll may be admitted"
        );
        assert!(admitted[0].running);
        assert_eq!(admitted[0].output, "ready");
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn completion_seen_after_capture_lock_bypasses_zero_poll_cooldown() {
        let root = temp_workspace();
        let stub = stub_session(&root).await;
        stub.observe(ObservationMode::ZeroPoll).await.unwrap();
        let last_poll = stub.last_zero_poll().await;

        stub.append(b"late").await;
        let observation = stub.session.observation.lock().await;
        let capture = stub.output.lock().await;
        let session = stub.session.clone();
        let blocked = tokio::spawn(async move {
            session
                .output_snapshot(None, None, ObservationMode::ZeroPoll)
                .await
        });
        tokio::task::yield_now().await;
        drop(observation);
        tokio::task::yield_now().await;
        assert!(stub.session.observation.try_lock().is_err());
        stub.complete();
        drop(capture);

        let raced = blocked
            .await
            .unwrap()
            .expect("a completion observed after the capture lock must bypass the cooldown");
        assert!(!raced.running);
        assert!(raced.success);
        assert_eq!(raced.output, "late");

        let metadata = stub.observe(ObservationMode::Metadata).await.unwrap();
        assert!(
            metadata.output.is_empty(),
            "metadata mode clears output even from the cached completion"
        );
        assert_eq!(metadata.exit_code, Some(0));
        let replay = stub
            .observe(ObservationMode::ZeroPoll)
            .await
            .expect("cached completions bypass the cooldown");
        assert_eq!(replay.output, "late");
        assert_eq!(replay.exit_code, Some(0));
        assert_eq!(stub.last_zero_poll().await, last_poll);
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn completed_reads_do_not_touch_zero_poll_cooldown() {
        let root = temp_workspace();
        let stub = stub_session(&root).await;
        stub.append(b"done").await;
        stub.complete();

        let finished = stub.observe(ObservationMode::ZeroPoll).await.unwrap();
        assert!(!finished.running);
        assert_eq!(finished.output, "done");
        assert_eq!(
            stub.last_zero_poll().await,
            None,
            "completed reads bypass the cooldown instead of starting it"
        );

        let waiting = stub.observe(ObservationMode::Output).await.unwrap();
        assert_eq!(waiting.output, "done");
        let metadata = stub.observe(ObservationMode::Metadata).await.unwrap();
        assert!(metadata.output.is_empty());
        assert_eq!(metadata.exit_code, Some(0));
        assert_eq!(stub.last_zero_poll().await, None);
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn waiting_poll_finishes_on_completion_not_new_output() {
        let root = temp_workspace();
        let sessions = CommandSessionManager::new(root.clone(), root.join("logs"));
        let stub = stub_session(&root).await;
        sessions
            .sessions
            .lock()
            .await
            .insert(stub.session.id.clone(), stub.session.clone());
        let manager = sessions.clone();
        let id = stub.session.id.clone();
        let waiting = tokio::spawn(async move {
            manager
                .poll_command(WorkspaceCancellation::new(), &id, 270_000)
                .await
                .unwrap()
        });
        tokio::task::yield_now().await;
        stub.append(b"progress").await;
        tokio::time::pause();
        tokio::time::advance(Duration::from_secs(1)).await;
        assert!(!waiting.is_finished());
        let completed_at = tokio::time::Instant::now();
        stub.complete();
        let finished = waiting.await.unwrap();
        assert_eq!(tokio::time::Instant::now(), completed_at);
        assert!(finished.result.success);
        assert_eq!(finished.result.output, "progress");
        tokio::time::resume();
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn command_action_validation_rejects_mismatched_chars() {
        assert!(
            super::CommandAction::Write
                .validate("")
                .unwrap_err()
                .to_string()
                .contains("nonempty chars")
        );
        assert!(
            super::CommandAction::Terminate
                .validate("x")
                .unwrap_err()
                .to_string()
                .contains("empty chars")
        );
        super::CommandAction::Write.validate("x").unwrap();
        super::CommandAction::Terminate.validate("").unwrap();

        let root = temp_workspace();
        let sessions = CommandSessionManager::new(root.clone(), root.join("logs"));
        let (id, _started) = exec_running_with_timeout(&sessions, "sleep 30", None).await;
        let error = sessions
            .control_command(
                WorkspaceCancellation::new(),
                &id,
                CommandAction::Terminate,
                "x",
                0,
            )
            .await
            .expect_err("validation must fail before the action runs");
        assert!(error.to_string().contains("empty chars"));
        assert!(
            poll(&sessions, &id, 0).await.running,
            "a rejected terminate must not stop the command"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn terminate_kills_the_whole_process_tree() {
        let root = temp_workspace();
        let sessions = CommandSessionManager::new(root.clone(), root.join("logs"));
        let (id, _started) =
            exec_running_with_timeout(&sessions, "(sleep 30; touch leaked.txt) & sleep 30", None)
                .await;

        let finished = terminate(&sessions, &id, 5_000).await;
        assert!(!finished.running);
        assert!(!finished.success);
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(
            !root.join("leaked.txt").exists(),
            "background children must not outlive a terminated session"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn unknown_session_ids_are_rejected() {
        let root = temp_workspace();
        let sessions = CommandSessionManager::new(root.clone(), root.join("logs"));
        let error = sessions
            .poll_command(WorkspaceCancellation::new(), "missing", 0)
            .await
            .expect_err("unknown sessions must be rejected");
        assert!(error.to_string().contains("unknown command session"));
        let error = sessions
            .control_command(
                WorkspaceCancellation::new(),
                "missing",
                CommandAction::Write,
                "x",
                0,
            )
            .await
            .expect_err("unknown sessions must be rejected");
        assert!(error.to_string().contains("unknown command session"));
        fs::remove_dir_all(root).unwrap();
    }
}
