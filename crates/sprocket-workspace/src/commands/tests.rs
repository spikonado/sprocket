use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use super::{
    CapturedOutput, CommandAction, CommandCompletion, CommandObservation, CommandOutput,
    CommandSession, CommandSessionManager, ObservationMode, OutputChannel, WorkspaceCancellation,
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

    async fn archive(&self, root: &Path, id: &str) {
        let preview = self.output.lock().await.full_preview();
        super::CommandHistory {
            user_id: String::new(),
            thread_id: String::new(),
            machine_id: String::new(),
            command: "test".into(),
            workdir: root.to_string_lossy().into_owned(),
            max_output_chars: 20_000,
            result: super::completion_output(&completed_ok(), preview),
            pending_output: None,
        }
        .save(&super::history_path(&root.join("logs"), id).unwrap())
        .await
        .unwrap();
        self.complete();
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

async fn exec_running(sessions: &CommandSessionManager, command: &str) -> (String, CommandOutput) {
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
            "running": true,
            "completeLogPath": log_path,
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
        result: super::completion_output(&CommandCompletion::default(), output.preview_metadata()),
        pending_output: None,
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
        None,
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
async fn concurrent_observers_return_completed_output_once() {
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
    let concurrent = concurrent.unwrap();
    assert_eq!(
        [finished.result.output.as_str(), &concurrent.result.output].concat(),
        "done"
    );
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
    let [running_id, observed_id, completed_id] =
        std::array::from_fn(|_| uuid::Uuid::new_v4().to_string());
    let running = stub_session(&root).await;
    sessions
        .sessions
        .lock()
        .await
        .insert(running_id.clone(), running.session.clone());
    let observed = stub_session(&root).await;
    observed.archive(&root, &observed_id).await;
    sessions
        .sessions
        .lock()
        .await
        .insert(observed_id.clone(), observed.session.clone());
    let completed = stub_session(&root).await;
    completed.append(b"unreturned").await;
    completed.archive(&root, &completed_id).await;
    sessions
        .sessions
        .lock()
        .await
        .insert(completed_id.clone(), completed.session);
    sessions.prune_completed().await;
    let retained = sessions.sessions.lock().await;
    assert_eq!(retained.len(), 2);
    assert!(retained.contains_key(&running_id));
    assert!(retained.contains_key(&observed_id));
    drop(retained);
    assert_eq!(poll(&sessions, &completed_id, 0).await.output, "unreturned");
    drop(observed);
    sessions.prune_completed().await;
    assert!(!sessions.sessions.lock().await.contains_key(&observed_id));
    sessions.stop_all().await;
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
        .poll_command(WorkspaceCancellation::new(), &id, 270_000)
        .await
        .unwrap();
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
    remote.pending_output = None;
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
