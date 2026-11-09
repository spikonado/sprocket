use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use super::{
    CapturedOutput, CommandAction, CommandCompletion, CommandObservation, CommandOutput,
    CommandSession, CommandSessionManager, ObservationMode,
};
use crate::cancellation::WorkspaceCancellation;
use crate::command_container::CommandContainer;
use crate::command_output::OutputChannel;
use crate::default_command_shell;
use crate::test_support::temp_workspace;
use tokio::sync::{Mutex, mpsc, watch};

static CURSORS: std::sync::Mutex<BTreeMap<String, u64>> = std::sync::Mutex::new(BTreeMap::new());

fn cursor(id: &str) -> u64 {
    CURSORS.lock().unwrap().get(id).copied().unwrap_or(0)
}

fn advance(id: &str, next_offset: u64) {
    CURSORS.lock().unwrap().insert(id.to_string(), next_offset);
}

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
    history: super::CommandHistory,
    history_path: std::path::PathBuf,
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

    async fn archive(&self) {
        let preview = self.output.lock().await.full_preview();
        let mut history = self.history.clone();
        history.result = super::completion_output(&completed_ok(), preview);
        history.save(&self.history_path).await.unwrap();
        self.completion
            .send(Some(CommandCompletion {
                saved: true,
                ..completed_ok()
            }))
            .unwrap();
    }

    async fn observe(&self, mode: ObservationMode) -> anyhow::Result<CommandOutput> {
        let id = &self.session.id;
        let (output, next_offset) = self
            .session
            .output_snapshot(None, None, mode, cursor(id))
            .await?;
        advance(id, next_offset);
        Ok(output)
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
        exit_code: Some(0),
        success: true,
        timed_out: false,
        error: None,
        saved: false,
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
    let id = uuid::Uuid::new_v4().to_string();
    let history = super::CommandHistory {
        user_id: String::new(),
        thread_id: String::new(),
        machine_id: String::new(),
        command: "test".into(),
        workdir: root.to_string_lossy().into_owned(),
        max_output_chars: 20_000,
        result: CommandOutput {
            running: true,
            ..super::completion_output(&CommandCompletion::default(), output.preview_metadata())
        },
        process: None,
    };
    let (completion, completion_rx) = watch::channel(None);
    let (control, _controls) = mpsc::unbounded_channel();
    let (stdin, _requests) = mpsc::channel(1);
    let output = Arc::new(Mutex::new(output));
    StubSession {
        history_path: super::history_path(&root.join("logs"), &id).unwrap(),
        session: Arc::new(CommandSession {
            id,
            command: "test".into(),
            workdir: root.to_string_lossy().into_owned(),
            started_at: 0,
            control,
            stdin,
            completion: completion_rx,
            output: output.clone(),
            max_output_chars: 20_000,
            observation: Mutex::new(CommandObservation::default()),
        }),
        completion,
        output,
        history,
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
    let id = started.session_id.unwrap();
    advance(&id, started.next_offset);
    (id, started.result)
}

async fn exec_running(sessions: &CommandSessionManager, command: &str) -> (String, CommandOutput) {
    exec_running_with_timeout(sessions, command, Some(10_000)).await
}

async fn write(
    sessions: &CommandSessionManager,
    id: &str,
    chars: &str,
    yield_time_ms: u64,
) -> CommandOutput {
    control(sessions, id, CommandAction::Write, chars, yield_time_ms)
        .await
        .unwrap()
}

async fn terminate(
    sessions: &CommandSessionManager,
    id: &str,
    yield_time_ms: u64,
) -> CommandOutput {
    control(sessions, id, CommandAction::Terminate, "", yield_time_ms)
        .await
        .unwrap()
}

async fn control(
    sessions: &CommandSessionManager,
    id: &str,
    action: CommandAction,
    chars: &str,
    yield_time_ms: u64,
) -> anyhow::Result<CommandOutput> {
    let controlled = sessions
        .control_command(
            WorkspaceCancellation::new(),
            id,
            action,
            chars,
            yield_time_ms,
            cursor(id),
        )
        .await?;
    advance(id, controlled.next_offset);
    Ok(controlled.result)
}

async fn poll(sessions: &CommandSessionManager, id: &str, yield_time_ms: u64) -> CommandOutput {
    try_poll(sessions, id, yield_time_ms).await.unwrap()
}

async fn try_poll(
    sessions: &CommandSessionManager,
    id: &str,
    yield_time_ms: u64,
) -> anyhow::Result<CommandOutput> {
    let polled = sessions
        .poll_command(WorkspaceCancellation::new(), id, yield_time_ms, cursor(id))
        .await?;
    advance(id, polled.next_offset);
    Ok(polled.result)
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
    assert_eq!(finished.output, ":done");
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
        finished.output, ":done",
        "completed output omits bytes already returned by earlier observations"
    );
    assert_eq!(
        fs::read(&finished.complete_log_path).unwrap(),
        b"ready:done"
    );
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn completed_session_returns_output_once_and_skips_yield_waits() {
    let root = temp_workspace();
    let sessions = CommandSessionManager::new(root.clone(), root.join("logs"));
    let (id, _started) = exec_running_with_timeout(&sessions, "printf done", None).await;

    let finished = poll(&sessions, &id, 10_000).await;
    assert!(finished.success);
    assert_eq!(finished.output, "done");

    for _ in 0..2 {
        let replay = poll(&sessions, &id, 0).await;
        assert!(!replay.running);
        assert_eq!(replay.output, "");
        assert_eq!(replay.exit_code, Some(0));
    }
    let replay = poll(&sessions, &id, 270_000).await;
    assert!(
        replay.success,
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
            "nextOffset": output.next_offset,
            "exitCode": 0,
            "success": true,
            "running": false,
            "timedOut": false,
            "output": "starting\nfailed\ncleaning up\n",
            "completeLogPath": output.result.complete_log_path,
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
    assert_eq!(
        serde_json::to_value(&started).unwrap(),
        serde_json::json!({
            "sessionId": id,
            "nextOffset": 0,
            "running": true,
            "completeLogPath": log_path,
        })
    );
    let running = sessions
        .poll_command(WorkspaceCancellation::new(), id, 0, 0)
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(running).unwrap(),
        serde_json::json!({
            "command": command,
            "workdir": root.to_string_lossy(),
            "nextOffset": 0,
            "running": true,
            "completeLogPath": log_path,
        })
    );
    let finished = sessions
        .control_command(
            WorkspaceCancellation::new(),
            id,
            CommandAction::Write,
            "done\n",
            5_000,
            0,
        )
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(finished).unwrap(),
        serde_json::json!({
            "command": command,
            "workdir": root.to_string_lossy(),
            "nextOffset": 4,
            "exitCode": 0,
            "success": true,
            "running": false,
            "timedOut": false,
            "output": "done",
            "completeLogPath": log_path,
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
    let sessions = CommandSessionManager::new(root.clone(), root.join("logs")).with_output_limits(
        super::CommandOutputLimits {
            min_free_disk_bytes: u64::MAX,
            ..Default::default()
        },
    );
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
    let sessions = CommandSessionManager::new(root.clone(), root.join("logs")).with_output_limits(
        super::CommandOutputLimits {
            max_log_bytes: 4,
            ..Default::default()
        },
    );
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
    let error = output.result.error.unwrap();
    assert!(error.contains("command was stopped") && error.contains("log quota"));
    assert!(
        fs::read(output.result.complete_log_path)
            .unwrap()
            .is_empty()
    );
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn reads_from_the_same_cursor_return_the_same_output() {
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
            0,
        ),
        sessions.poll_command(WorkspaceCancellation::new(), &id, 5_000, 0),
    );
    let finished = finished.unwrap();
    let concurrent = concurrent.unwrap();
    assert_eq!(finished.result.output, "done");
    assert_eq!(concurrent.result.output, "done");
    assert_eq!(finished.next_offset, concurrent.next_offset);
    advance(&id, finished.next_offset);
    let repeated = poll(&sessions, &id, 10_000).await;

    assert!(!repeated.running);
    assert!(repeated.output.is_empty());
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
    let entries = fs::read_dir(&logs)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect::<Vec<_>>();
    assert_eq!(entries, vec![std::ffi::OsString::from("sessions")]);
    assert_eq!(fs::read_dir(logs.join("sessions")).unwrap().count(), 0);
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
async fn action_waits_honor_their_budgets() {
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
    let (id, _started) = exec_running(&sessions, "read value; printf 'got:%s' \"$value\"").await;

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
            0,
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
            0,
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
            finished.next_offset,
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
    let observer = sessions.poll_command(cancellation.clone(), session_id, 5_000, 0);
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
        .control_command(
            cancellation,
            session_id,
            CommandAction::Write,
            "x",
            5_000,
            0,
        )
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
async fn cleanup_releases_only_unobserved_saved_sessions() {
    let root = temp_workspace();
    let sessions = CommandSessionManager::new(root.clone(), root.join("logs"));
    let running = stub_session(&root).await;
    let running_id = running.session.id.clone();
    sessions
        .sessions
        .lock()
        .await
        .insert(running_id.clone(), running.session.clone());
    let observed = stub_session(&root).await;
    let observed_id = observed.session.id.clone();
    observed.archive().await;
    sessions
        .sessions
        .lock()
        .await
        .insert(observed_id.clone(), observed.session.clone());
    let completed = stub_session(&root).await;
    let completed_id = completed.session.id.clone();
    completed.append(b"unreturned").await;
    completed.archive().await;
    sessions
        .sessions
        .lock()
        .await
        .insert(completed_id.clone(), completed.session);
    let unsaved = stub_session(&root).await;
    let unsaved_id = unsaved.session.id.clone();
    unsaved.history.save(&unsaved.history_path).await.unwrap();
    unsaved
        .completion
        .send(Some(CommandCompletion {
            success: false,
            error: Some("failed to save command result: disk full".into()),
            ..completed_ok()
        }))
        .unwrap();
    sessions
        .sessions
        .lock()
        .await
        .insert(unsaved_id.clone(), unsaved.session);
    sessions.prune_completed().await;
    let retained = sessions.sessions.lock().await;
    assert_eq!(retained.len(), 3);
    assert!(retained.contains_key(&running_id));
    assert!(retained.contains_key(&observed_id));
    assert!(retained.contains_key(&unsaved_id));
    drop(retained);
    assert_eq!(poll(&sessions, &completed_id, 0).await.output, "unreturned");
    assert_eq!(
        poll(&sessions, &unsaved_id, 0).await.error.as_deref(),
        Some("failed to save command result: disk full")
    );
    drop(observed);
    sessions.prune_completed().await;
    assert!(!sessions.sessions.lock().await.contains_key(&observed_id));
    sessions.stop_all().await;
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn interrupted_session_output_is_returned_once() {
    let root = temp_workspace();
    let stub = stub_session(&root).await;
    stub.append(b"before restart\n").await;
    stub.history.save(&stub.history_path).await.unwrap();

    let sessions = CommandSessionManager::new(root.clone(), root.join("logs"));
    let first = poll(&sessions, &stub.session.id, 270_000).await;
    assert_eq!(first.output, "before restart\n");
    assert!(!first.running);
    assert!(first.error.unwrap().contains("interrupted"));
    assert_eq!(poll(&sessions, &stub.session.id, 270_000).await.output, "");
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn stop_all_keeps_unreturned_output_for_later_polls() {
    let root = temp_workspace();
    let sessions = CommandSessionManager::new(root.clone(), root.join("logs"));
    let completed = stub_session(&root).await;
    let id = completed.session.id.clone();
    sessions
        .sessions
        .lock()
        .await
        .insert(id.clone(), completed.session.clone());
    completed.append(b"returned").await;
    assert_eq!(poll(&sessions, &id, 0).await.output, "returned");
    completed.append(b" unreturned").await;
    completed.archive().await;
    sessions.stop_all().await;
    drop(sessions);

    let sessions = CommandSessionManager::new(root.clone(), root.join("logs"));
    assert_eq!(poll(&sessions, &id, 270_000).await.output, " unreturned");
    assert_eq!(poll(&sessions, &id, 270_000).await.output, "");
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn later_runs_get_only_unreturned_output_after_cleanup_and_server_restart() {
    let root = temp_workspace();
    let sessions = CommandSessionManager::new(root.clone(), root.join("logs"));
    let (id, started) = exec_running(&sessions, "printf ready; read value; printf ':done'").await;
    wait_for_log(&started.complete_log_path, b"ready").await;
    assert_eq!(poll(&sessions, &id, 0).await.output, "ready");
    write(&sessions, &id, "go\n", 0).await;
    await_completion(&sessions, &id).await;
    sessions.prune_completed().await;
    assert!(sessions.sessions.lock().await.is_empty());
    assert!(terminate(&sessions, &id, 0).await.output.is_empty());
    let replay = sessions
        .poll_command(WorkspaceCancellation::new(), &id, 270_000, cursor(&id))
        .await
        .unwrap();
    advance(&id, replay.next_offset);
    assert_eq!(replay.command, "printf ready; read value; printf ':done'");
    assert_eq!(replay.result.output, ":done");
    assert_eq!(replay.result.exit_code, Some(0));
    assert!(replay.result.success);
    assert_eq!(replay.result.complete_log_path, started.complete_log_path);
    assert!(poll(&sessions, &id, 0).await.output.is_empty());
    let saved: super::CommandHistory = serde_json::from_slice(
        &fs::read(super::history_path(&root.join("logs"), &id).unwrap()).unwrap(),
    )
    .unwrap();
    assert_eq!(saved.result.output, "ready:done");
    sessions.stop_all().await;
    drop(sessions);
    let restarted = CommandSessionManager::new(root.clone(), root.join("logs"));
    let restarted_replay = poll(&restarted, &id, 0).await;
    assert!(restarted_replay.success);
    assert!(restarted_replay.output.is_empty());
    let other = CommandSessionManager::new(root.clone(), root.join("other-thread"));
    assert!(
        other
            .poll_command(WorkspaceCancellation::new(), &id, 0, 0)
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
    let cached = poll(&offline, &id, 0).await;
    assert!(cached.success);
    assert_eq!(cached.output, "");
    fs::remove_dir_all(origin).unwrap();
    fs::remove_dir_all(destination).unwrap();
}

#[tokio::test]
async fn cached_history_stays_available_during_failed_or_stalled_remote_fetches() {
    let root = temp_workspace();
    let sessions = CommandSessionManager::new(root.clone(), root.join("logs")).with_history_scope(
        "user".into(),
        "thread".into(),
        "destination".into(),
    );
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
    assert_eq!(poll(&sessions, &completed_id, 0).await.exit_code, Some(0));
    tokio::time::advance(Duration::from_secs(10)).await;
    let cached = fetching.await.unwrap();
    assert!(cached.running);
    assert_eq!(cached.output, "cached");
    assert!(cached.error.unwrap().contains("last synced"));
    let unknown = uuid::Uuid::new_v4().to_string();
    let timed_out = sessions
        .poll_command(WorkspaceCancellation::new(), &unknown, 0, 0)
        .await
        .unwrap_err();
    assert!(timed_out.to_string().contains("timed out"));
    tokio::time::resume();

    let sessions = sessions.with_history_resolver(|_, _| async { anyhow::bail!("offline") });
    let cached = poll(&sessions, &remote_id, 0).await;
    assert!(cached.running);
    assert_eq!(cached.output, "");
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
async fn rejected_zero_poll_keeps_unreturned_output_and_cooldown() {
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
                .output_snapshot(None, None, ObservationMode::ZeroPoll, 0)
                .await
        });
    }
    let mut admitted = Vec::new();
    while let Some(result) = calls.join_next().await {
        match result.unwrap() {
            Ok((output, _)) => admitted.push(output),
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
    let from_offset = cursor(&session.id);
    let blocked = tokio::spawn(async move {
        session
            .output_snapshot(None, None, ObservationMode::ZeroPoll, from_offset)
            .await
    });
    tokio::task::yield_now().await;
    drop(observation);
    tokio::task::yield_now().await;
    assert!(stub.session.observation.try_lock().is_err());
    stub.complete();
    drop(capture);

    let (raced, next_offset) = blocked
        .await
        .unwrap()
        .expect("a completion observed after the capture lock must bypass the cooldown");
    advance(&stub.session.id, next_offset);
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
    assert!(replay.output.is_empty());
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
    assert!(waiting.output.is_empty());
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
            .poll_command(WorkspaceCancellation::new(), &id, 270_000, 0)
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
        exec_running_with_timeout(&sessions, "(sleep 30; touch leaked.txt) & sleep 30", None).await;

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
async fn container_kill_stops_processes_that_left_the_process_group() {
    let container = match CommandContainer::create(&uuid::Uuid::new_v4().to_string()) {
        Ok(Some(container)) => container,
        Ok(None) => return,
        Err(error) => {
            eprintln!("skipping, this machine can't contain commands: {error:#}");
            return;
        }
    };
    let root = temp_workspace();
    let sessions = CommandSessionManager::new(root.clone(), root.join("logs"))
        .with_container(Some(container.clone()));
    #[cfg(unix)]
    let (shell, command) = (
        default_command_shell(),
        "setsid sleep 30 >/dev/null 2>&1 </dev/null & echo $! > pid.txt",
    );
    // Windows defaults to Git Bash when it's installed, as on CI.
    #[cfg(windows)]
    let (shell, command) = (
        "powershell.exe".to_string(),
        "Set-Content -Path pid.txt -Value (Start-Process -FilePath ping.exe -ArgumentList '-n','30','127.0.0.1' -WindowStyle Hidden -PassThru).Id",
    );
    let finished = sessions
        .exec_command(
            WorkspaceCancellation::new(),
            command,
            ".",
            &shell,
            None,
            10_000,
            20_000,
        )
        .await
        .unwrap()
        .result;
    assert!(finished.success, "{finished:?}");

    let pid: u32 = fs::read_to_string(root.join("pid.txt"))
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    assert!(
        process_is_alive(pid),
        "the escaped job lives on after its shell exits"
    );

    container.kill().await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while process_is_alive(pid) {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("container kill must stop the escaped job");
    fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
fn process_is_alive(pid: u32) -> bool {
    // SAFETY: signal 0 only checks that the process exists.
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

#[cfg(windows)]
fn process_is_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_TIMEOUT};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject,
    };
    // SAFETY: the handle is checked for null and closed after the zero-timeout wait.
    unsafe {
        let process = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
        if process.is_null() {
            return false;
        }
        let alive = WaitForSingleObject(process, 0) == WAIT_TIMEOUT;
        CloseHandle(process);
        alive
    }
}

#[tokio::test]
async fn unknown_session_ids_are_rejected() {
    let root = temp_workspace();
    let sessions = CommandSessionManager::new(root.clone(), root.join("logs"));
    let error = sessions
        .poll_command(WorkspaceCancellation::new(), "missing", 0, 0)
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
            0,
        )
        .await
        .expect_err("unknown sessions must be rejected");
    assert!(error.to_string().contains("unknown command session"));
    fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn a_restarted_server_adopts_a_running_command_and_reports_its_exit() {
    let root = temp_workspace();
    let logs = root.join("logs");
    let sessions = CommandSessionManager::new(root.clone(), logs.clone());
    let started = sessions
        .exec_command(
            WorkspaceCancellation::new(),
            "echo before; until [ -e go ]; do sleep 0.02; done; echo during; \
             until [ -e end ]; do sleep 0.02; done; echo after; exit 7",
            ".",
            &default_command_shell(),
            Some(30_000),
            0,
            20_000,
        )
        .await
        .unwrap();
    let id = started.session_id.unwrap();
    wait_for_log(&started.result.complete_log_path, b"before\n").await;
    sessions.detach_all().await;

    fs::write(root.join("go"), "").unwrap();
    let spool = Path::new(&started.result.complete_log_path).with_file_name("stdout.spool");
    tokio::time::timeout(Duration::from_secs(2), async {
        while fs::read(&spool).unwrap() != b"before\nduring\n" {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let history = super::CommandHistory::read(&super::history_path(&logs, &id).unwrap())
        .await
        .unwrap()
        .unwrap();
    let restarted = CommandSessionManager::new(root.clone(), logs);
    restarted.adopt(&id, history).await.unwrap();
    let write_error = control(&restarted, &id, CommandAction::Write, "x", 0)
        .await
        .unwrap_err();
    assert!(write_error.to_string().contains("stdin is closed"));
    fs::write(root.join("end"), "").unwrap();

    let mut output = String::new();
    let result = loop {
        let polled = poll(&restarted, &id, 5_000).await;
        output.push_str(&polled.output);
        if !polled.running {
            break polled;
        }
    };
    assert_eq!(output, "before\nduring\nafter\n");
    assert_eq!(result.exit_code, Some(7));
    assert!(!spool.exists());
    fs::remove_dir_all(root).unwrap();
}
