use std::fs;
use std::sync::Arc;
use std::time::Duration;

use super::{
    Capture, CommandCompletion, CommandProcess, Supervision, build_shell_command,
    completion_output, supervise_command,
};
use crate::command_history::{CommandHistory, history_path};
use crate::command_output::CapturedOutput;
use crate::default_command_shell;
use crate::test_support::temp_workspace;
use tokio::sync::{Mutex, mpsc, watch};

#[cfg(windows)]
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
    let output = CapturedOutput::create(&root.join("logs"), 100)
        .await
        .unwrap();
    let history_path = history_path(&root.join("logs"), &uuid::Uuid::new_v4().to_string()).unwrap();
    let history = CommandHistory {
        user_id: String::new(),
        thread_id: String::new(),
        machine_id: String::new(),
        command: command.into(),
        workdir: root.to_string_lossy().into_owned(),
        max_output_chars: 100,
        result: completion_output(&CommandCompletion::default(), output.preview_metadata()),
        process: None,
    };
    let (mut process, _source) = build_shell_command(
        command,
        &default_command_shell(),
        history.result.log_directory().unwrap(),
    )
    .unwrap();
    process.current_dir(&root).kill_on_drop(true);
    #[cfg(unix)]
    process.process_group(0);
    let (_control, controls) = mpsc::unbounded_channel();
    let (completion, mut completed) = watch::channel(None);
    let supervisor = tokio::spawn(supervise_command(
        Supervision {
            process: CommandProcess::spawned(process.spawn().unwrap()),
            capture: Capture {
                task: tokio::spawn(async { anyhow::bail!("injected log write failure") }),
                stop: watch::channel(false).0,
            },
            output: Arc::new(Mutex::new(output)),
            timeout: Some(Duration::from_secs(5)),
            lifetime_guard: None,
            history: (history_path, history),
        },
        tokio::spawn(std::future::pending()),
        controls,
        completion,
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

#[cfg(unix)]
#[test]
fn stopping_a_process_group_of_only_zombies_succeeds() {
    use std::os::unix::process::CommandExt;
    let mut child = std::process::Command::new("true")
        .process_group(0)
        .spawn()
        .unwrap();
    let mut exited = unsafe { std::mem::zeroed::<libc::siginfo_t>() };
    let waited = unsafe {
        libc::waitid(
            libc::P_PID,
            child.id(),
            &mut exited,
            libc::WEXITED | libc::WNOWAIT,
        )
    };
    assert_eq!(waited, 0);
    super::stop_remaining_processes(Some(child.id())).unwrap();
    child.wait().unwrap();
}
