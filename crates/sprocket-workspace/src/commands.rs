mod process;

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::async_tools::ZeroPollCooldown;
use crate::cancellation::{WorkspaceCancellation, WorkspaceOperationCancelled};
use crate::command_history::{CommandHistory, history_path};
use crate::command_output::{CapturedOutput, CommandOutputLimits, UnreturnedOutput, read_log_from};
use crate::command_shell::{default_shell_for, resolve_command_shell};
use crate::paths::resolve_directory;
use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, mpsc, oneshot, watch};

use self::process::{
    CommandCompletion, StdinRequest, build_shell_command, capture_pipes, completion_output,
    signal_change, supervise_command, write_command_input,
};

const MAX_COMMAND_MAX_OUTPUT_CHARS: usize = 80_000;
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

#[derive(Clone, Debug, PartialEq, Serialize)]
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
    github_user_id: Option<String>,
    output_limits: CommandOutputLimits,
    sessions: Arc<Mutex<HashMap<String, Arc<CommandSession>>>>,
    stopped: Arc<AtomicBool>,
    lifetime_guard_factory: Option<CommandLifetimeGuardFactory>,
    history_scope: (String, String, String),
    history_resolver: Option<HistoryResolver>,
    history_fetch_lock: Arc<Mutex<()>>,
    changes: Option<watch::Sender<()>>,
}

impl CommandSessionManager {
    pub fn new(workspace_root: PathBuf, log_directory: PathBuf) -> Self {
        Self {
            workspace_root,
            log_directory,
            environment: Vec::new(),
            github_user_id: None,
            output_limits: CommandOutputLimits::default(),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            stopped: Arc::new(AtomicBool::new(false)),
            lifetime_guard_factory: None,
            history_scope: Default::default(),
            history_resolver: None,
            history_fetch_lock: Arc::new(Mutex::new(())),
            changes: None,
        }
    }

    pub fn with_workspace_root(mut self, workspace_root: PathBuf) -> Self {
        self.workspace_root = workspace_root;
        self
    }

    pub fn with_change_signal(mut self, changes: watch::Sender<()>) -> Self {
        self.changes = Some(changes);
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

    async fn saved_result(
        &self,
        session_id: &str,
        reveal_output: bool,
        from_offset: u64,
    ) -> Result<CommandStdinOutput> {
        let path = history_path(&self.log_directory, session_id)?;
        let local = CommandHistory::read(&path).await?;
        let fetched = match &self.history_resolver {
            Some(resolver)
                if local.as_ref().is_none_or(|history| {
                    history.machine_id != self.history_scope.2 && history.result.running
                }) =>
            {
                let fetched = tokio::time::timeout(Duration::from_secs(10), async {
                    let _fetch = self.history_fetch_lock.lock().await;
                    resolver(session_id.to_string(), self.log_directory.clone()).await
                })
                .await
                .context("remote command history fetch timed out")
                .and_then(|result| result);
                match fetched {
                    Ok(fetched) => fetched,
                    Err(error) if local.is_none() => return Err(error),
                    Err(_) => None,
                }
            }
            _ => None,
        };
        let Some(mut history) = fetched.or(local) else {
            bail!("unknown command session: {session_id}");
        };
        if history.machine_id == self.history_scope.2 && history.result.running {
            // Outside the live map, this machine's sessions only stay running
            // after the server exited before their final status was saved.
            history.mark_interrupted().await?;
        }
        let unreturned = if reveal_output {
            history.read_output(from_offset).await?
        } else {
            UnreturnedOutput::none(from_offset)
        };
        Ok(CommandStdinOutput {
            command: history.command,
            workdir: history.workdir,
            next_offset: unreturned.next_offset,
            result: CommandOutput {
                output: unreturned.output,
                ..history.result
            },
        })
    }

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

    pub fn environment(&self) -> &[(OsString, OsString)] {
        &self.environment
    }

    /// The shell commands get when they name none, found on their own `PATH`, which
    /// includes pinned tools such as Windows' Git Bash.
    pub fn default_shell(&self) -> String {
        default_shell_for(self.command_path().as_deref())
    }

    fn command_path(&self) -> Option<OsString> {
        self.environment
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case("PATH"))
            .map(|(_, path)| path.clone())
            .or_else(|| std::env::var_os("PATH"))
    }

    /// Gives each command git and `gh` access with this user's GitHub credentials.
    pub fn with_github_credentials(mut self, user_id: String) -> Self {
        self.github_user_id = Some(user_id);
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
        let max_output_chars = max_output_chars.min(MAX_COMMAND_MAX_OUTPUT_CHARS);

        let cwd = resolve_directory(&self.workspace_root, workdir)?;
        let shell = resolve_command_shell(shell, &cwd, self.command_path().as_deref())?;
        let github_environment = match &self.github_user_id {
            Some(user_id) => crate::github::agent_environment(user_id).await,
            None => Vec::new(),
        };
        cancellation.ensure_active()?;
        let output = Arc::new(Mutex::new(
            CapturedOutput::create_with_limits(
                &self.log_directory,
                max_output_chars,
                self.output_limits,
            )
            .await?,
        ));
        let mut process = build_shell_command(command, &shell);
        process
            .current_dir(&cwd)
            .envs(self.environment.iter().map(|(key, value)| (key, value)))
            .envs(github_environment)
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
            max_output_chars,
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
            self.changes.clone(),
        ));

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
            max_output_chars,
            observation: Mutex::new(CommandObservation::default()),
        });
        sessions.insert(session_id.clone(), session.clone());
        drop(sessions);
        signal_change(&self.changes);

        let (result, next_offset) = self
            .observe_session(
                session,
                cancellation,
                yield_time_ms,
                ObservationMode::after_action(yield_time_ms),
                0,
            )
            .await?;
        Ok(CommandExecOutput {
            session_id: Some(session_id),
            next_offset,
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
        from_offset: u64,
    ) -> Result<CommandStdinOutput> {
        action.validate(chars)?;
        cancellation.ensure_active()?;
        let Some(session) = self.session(session_id).await else {
            let output = tokio::select! {
                _ = cancellation.cancelled() => return Err(WorkspaceOperationCancelled.into()),
                result = self.saved_result(session_id, yield_time_ms != 0, from_offset) => result?,
            };
            if output.result.running {
                bail!(
                    "command is running on another machine; control it on its originating machine"
                );
            }
            return Ok(output);
        };
        let (result, next_offset) = self
            .write_session(
                session.clone(),
                cancellation,
                action,
                chars,
                yield_time_ms,
                from_offset,
            )
            .await?;
        Ok(CommandStdinOutput {
            command: session.command.clone(),
            workdir: session.workdir.clone(),
            next_offset,
            result,
        })
    }

    pub async fn poll_command(
        &self,
        cancellation: WorkspaceCancellation,
        session_id: &str,
        yield_time_ms: u64,
        from_offset: u64,
    ) -> Result<CommandStdinOutput> {
        cancellation.ensure_active()?;
        let Some(session) = self.session(session_id).await else {
            return tokio::select! {
                _ = cancellation.cancelled() => Err(WorkspaceOperationCancelled.into()),
                result = self.saved_result(session_id, true, from_offset) => result,
            };
        };
        let mode = if yield_time_ms == 0 {
            ObservationMode::ZeroPoll
        } else {
            ObservationMode::Output
        };
        let (result, next_offset) = self
            .observe_session(
                session.clone(),
                cancellation,
                yield_time_ms,
                mode,
                from_offset,
            )
            .await?;
        Ok(CommandStdinOutput {
            command: session.command.clone(),
            workdir: session.workdir.clone(),
            next_offset,
            result,
        })
    }

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
        self.sessions.lock().await.retain(|_, session| {
            Arc::strong_count(session) > 1
                || !session
                    .completion
                    .borrow()
                    .as_ref()
                    .is_some_and(|completion| completion.archived)
        });
    }

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
        from_offset: u64,
    ) -> Result<(CommandOutput, u64)> {
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
                            .observe_after_write_error(
                                session,
                                cancellation,
                                yield_time_ms,
                                error,
                                from_offset,
                            )
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
            from_offset,
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
        // Unfinished sessions stay live so polls never race their supervisor's final save.
        self.prune_completed().await;
    }

    async fn observe_session(
        &self,
        session: Arc<CommandSession>,
        cancellation: WorkspaceCancellation,
        yield_time_ms: u64,
        mode: ObservationMode,
        from_offset: u64,
    ) -> Result<(CommandOutput, u64)> {
        let completion = wait_for_completion(&session, &cancellation, yield_time_ms).await?;
        session
            .output_snapshot(completion, None, mode, from_offset)
            .await
    }

    async fn observe_after_write_error(
        &self,
        session: Arc<CommandSession>,
        cancellation: WorkspaceCancellation,
        yield_time_ms: u64,
        write_error: anyhow::Error,
        from_offset: u64,
    ) -> Result<(CommandOutput, u64)> {
        match wait_for_completion(&session, &cancellation, yield_time_ms).await {
            Ok(Some(completion)) => {
                let write_error = format!("failed to write command stdin: {write_error:#}");
                session
                    .output_snapshot(
                        Some(completion),
                        Some(write_error),
                        ObservationMode::after_action(yield_time_ms),
                        from_offset,
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
    control: mpsc::UnboundedSender<()>,
    stdin: mpsc::Sender<StdinRequest>,
    completion: watch::Receiver<Option<CommandCompletion>>,
    output: Arc<Mutex<CapturedOutput>>,
    max_output_chars: usize,
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
            .send(())
            .map_err(|_| anyhow!("command session {} is no longer running", self.id))
    }

    async fn output_snapshot(
        &self,
        completion: Option<CommandCompletion>,
        write_error: Option<String>,
        mode: ObservationMode,
        from_offset: u64,
    ) -> Result<(CommandOutput, u64)> {
        let mut observation = self.observation.lock().await;
        let (mut output, next_offset) = match observation.final_output.clone() {
            Some(mut output) => {
                let unreturned = self
                    .read_output(&output.complete_log_path, from_offset, true, mode)
                    .await?;
                output.output = unreturned.output;
                (output, unreturned.next_offset)
            }
            None => {
                self.snapshot_output(completion, mode, &mut observation, from_offset)
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
            observation.final_output = Some(CommandOutput {
                output: String::new(),
                ..output.clone()
            });
        }
        Ok((output, next_offset))
    }

    async fn read_output(
        &self,
        log_path: &str,
        from_offset: u64,
        final_stream: bool,
        mode: ObservationMode,
    ) -> Result<UnreturnedOutput> {
        if matches!(mode, ObservationMode::Metadata) {
            return Ok(UnreturnedOutput::none(from_offset));
        }
        read_log_from(
            Path::new(log_path),
            from_offset,
            self.max_output_chars,
            final_stream,
        )
        .await
    }

    async fn snapshot_output(
        &self,
        completion: Option<CommandCompletion>,
        mode: ObservationMode,
        observation: &mut CommandObservation,
        from_offset: u64,
    ) -> Result<(CommandOutput, u64)> {
        let preview = self.output.lock().await.preview_metadata();
        // Completion can arrive while this observer waits for the capture lock.
        let completion = completion.or_else(|| self.completion.borrow().clone());
        let pending_zero_poll = completion.is_none() && matches!(mode, ObservationMode::ZeroPoll);
        let unreturned = observation
            .zero_poll_cooldown
            .observe(
                pending_zero_poll,
                |error| anyhow!(error.message("Command is still running.")),
                self.read_output(
                    &preview.complete_log_path,
                    from_offset,
                    completion.is_some(),
                    mode,
                ),
            )
            .await?;
        let running = completion.is_none();
        let completion = completion.unwrap_or_default();

        let output = CommandOutput {
            exit_code: completion.exit_code,
            success: completion.success,
            running,
            timed_out: completion.timed_out,
            output: unreturned.output,
            complete_log_path: preview.complete_log_path,
            events_path: preview.events_path,
            error: completion.error,
        };
        Ok((output, unreturned.next_offset))
    }
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

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandExecOutput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub next_offset: u64,
    #[serde(flatten, serialize_with = "serialize_for_model")]
    pub result: CommandOutput,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandStdinOutput {
    pub command: String,
    pub workdir: String,
    pub next_offset: u64,
    #[serde(flatten, serialize_with = "serialize_for_model")]
    pub result: CommandOutput,
}

fn serialize_for_model<S: serde::Serializer>(
    output: &CommandOutput,
    serializer: S,
) -> std::result::Result<S::Ok, S::Error> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct ModelCommandOutput<'a> {
        #[serde(skip_serializing_if = "Option::is_none")]
        exit_code: Option<i32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        success: Option<bool>,
        running: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        timed_out: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        output: Option<&'a str>,
        complete_log_path: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<&'a str>,
    }

    ModelCommandOutput {
        exit_code: output.exit_code,
        success: (!output.running).then_some(output.success),
        running: output.running,
        timed_out: (!output.running).then_some(output.timed_out),
        output: (!output.output.is_empty()).then_some(output.output.as_str()),
        complete_log_path: &output.complete_log_path,
        error: output.error.as_deref(),
    }
    .serialize(serializer)
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
