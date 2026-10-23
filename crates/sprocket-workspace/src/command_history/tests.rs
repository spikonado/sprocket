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
}
