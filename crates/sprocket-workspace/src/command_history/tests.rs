use super::*;
use crate::command_output::OutputChannel;

#[tokio::test]
async fn interrupted_session_recovers_output_without_claiming_success() {
    let root = tempfile::tempdir().unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let mut output = CapturedOutput::create(root.path(), 20_000).await.unwrap();
    output
        .append(OutputChannel::Stdout, b"before restart\n")
        .await
        .unwrap();
    let preview = output.preview_metadata();
    let history = CommandHistory {
        user_id: String::new(),
        thread_id: String::new(),
        machine_id: String::new(),
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
        pending_output: None,
    };
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

    let saved: CommandHistory = serde_json::from_slice(
        &tokio::fs::read(&history_path(root.path(), &id).unwrap())
            .await
            .unwrap(),
    )
    .unwrap();
    assert!(!saved.result.running);
    assert_eq!(saved.pending_output.as_deref(), Some("before restart\n"));
}

#[tokio::test]
async fn settle_interrupted_keeps_a_completed_result() {
    let root = tempfile::tempdir().unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let path = history_path(root.path(), &id).unwrap();
    let mut output = CapturedOutput::create(root.path(), 20_000).await.unwrap();
    output
        .append(OutputChannel::Stdout, b"done\n")
        .await
        .unwrap();
    let preview = output.preview_metadata();
    let mut running = CommandHistory {
        user_id: String::new(),
        thread_id: String::new(),
        machine_id: String::new(),
        command: "build".into(),
        workdir: "/workspace".into(),
        max_output_chars: 20_000,
        result: CommandOutput {
            exit_code: None,
            running: true,
            success: false,
            timed_out: false,
            output: String::new(),
            complete_log_path: preview.complete_log_path.clone(),
            events_path: preview.events_path.clone(),
            error: None,
        },
        pending_output: None,
    };
    running.save(&path).await.unwrap();

    let mut completed = running.clone();
    completed.result.running = false;
    completed.result.success = true;
    completed.result.exit_code = Some(0);
    completed.result.output = "done\n".into();
    completed.save(&path).await.unwrap();

    running.settle_interrupted(&path).await.unwrap();
    assert!(running.result.success);
    assert_eq!(running.result.exit_code, Some(0));

    let saved: CommandHistory =
        serde_json::from_slice(&tokio::fs::read(&path).await.unwrap()).unwrap();
    assert!(saved.result.success);
    assert_eq!(saved.result.exit_code, Some(0));
    assert!(!saved.result.running);
}
