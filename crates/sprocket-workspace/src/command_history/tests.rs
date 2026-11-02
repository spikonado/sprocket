use super::*;
use crate::command_output::OutputChannel;

async fn running_history(root: &Path, output: &[u8]) -> CommandHistory {
    let mut captured = CapturedOutput::create(root, 20_000).await.unwrap();
    captured
        .append(OutputChannel::Stdout, output)
        .await
        .unwrap();
    let preview = captured.preview_metadata();
    CommandHistory {
        user_id: String::new(),
        thread_id: String::new(),
        machine_id: "machine".into(),
        command: "build".into(),
        workdir: "/workspace".into(),
        max_output_chars: 20_000,
        result: CommandOutput {
            exit_code: None,
            running: true,
            success: false,
            timed_out: false,
            output: String::new(),
            complete_log_path: preview.complete_log_path,
            events_path: preview.events_path,
            error: None,
        },
        read_sequence: 0,
        process: None,
        pending_output: None,
    }
}

#[tokio::test]
async fn interrupted_session_recovers_output_without_claiming_success() {
    let root = tempfile::tempdir().unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let history = running_history(root.path(), b"before restart\n").await;
    history
        .save(&history_path(root.path(), &id).unwrap())
        .await
        .unwrap();
    let mut recovered = history;
    recovered
        .recover_if_running(root.path(), &id)
        .await
        .unwrap();
    assert_eq!(recovered.command, "build");
    assert_eq!(recovered.result.output, "before restart\n");
    assert!(!recovered.result.running);
    assert!(!recovered.result.success);
    assert!(recovered.result.error.unwrap().contains("interrupted"));
    assert_eq!(recovered.result.exit_code, None);
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[tokio::test]
async fn startup_settles_interrupted_sessions_and_kills_only_their_own_group() {
    use std::os::unix::process::{CommandExt, ExitStatusExt};

    let root = tempfile::tempdir().unwrap();
    let mut history = running_history(root.path(), b"before restart\n").await;
    let mut leftover = std::process::Command::new("sleep")
        .arg("30")
        .process_group(0)
        .spawn()
        .unwrap();
    let process = CommandProcess::of_group_leader(leftover.id()).unwrap();

    let reused = history_path(root.path(), &uuid::Uuid::new_v4().to_string()).unwrap();
    history.process = Some(CommandProcess {
        leader_start: process.leader_start + 1,
        ..process
    });
    history.save(&reused).await.unwrap();
    CommandHistory::settle_interrupted(&reused, "machine")
        .await
        .unwrap();
    assert!(leftover.try_wait().unwrap().is_none());

    let path = history_path(root.path(), &uuid::Uuid::new_v4().to_string()).unwrap();
    history.process = Some(process);
    history.save(&path).await.unwrap();
    CommandHistory::settle_interrupted(&path, "machine")
        .await
        .unwrap();
    assert_eq!(leftover.wait().unwrap().signal(), Some(libc::SIGKILL));
    let settled = CommandHistory::read(&path).await.unwrap().unwrap();
    assert!(!settled.result.running);
    assert!(!settled.result.success);
    assert!(settled.result.error.unwrap().contains("interrupted"));
    assert_eq!(settled.result.output, "before restart\n");
}
