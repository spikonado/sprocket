use std::collections::HashMap;
use std::ffi::OsString;
use std::path::PathBuf;
use std::process::{ExitStatus, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::async_tools::{YieldMode, ZeroPollCooldown};
use crate::command_history::{CommandHistory, history_path};
use crate::command_output::{CapturedOutput, CommandOutputLimits, OutputChannel};
use crate::command_shell::resolve_command_shell;
use crate::paths::resolve_directory;
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
    environment: Vec<(OsString, OsString)>,
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
            environment: Vec::new(),
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

    pub fn with_environment(
        mut self,
        environment: impl IntoIterator<Item = (OsString, OsString)>,
    ) -> Self {
        self.environment = environment.into_iter().collect();
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

        let cwd = resolve_directory(&self.workspace_root, workdir)?;
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
            .envs(self.environment.iter().map(|(key, value)| (key, value)))
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
    if crate::command_shell::is_powershell(shell) {
        process.args(["-NoLogo", "-NoProfile", "-Command"]);
    } else {
        process.arg("-c");
    }
    process.arg(command);
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
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

#[cfg(test)]
mod tests;
