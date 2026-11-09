use super::*;
use crate::command_output::CommandOutputLimits;

#[test]
fn liveness_tells_a_process_from_its_zombie_and_from_a_pid_reuse() {
    let mut child = std::process::Command::new("sleep")
        .arg("30")
        .spawn()
        .unwrap();
    let token = start_token(child.id()).unwrap();
    let process = AdoptedProcess::new(child.id(), token.clone(), Path::new("/nonexistent"));
    assert!(process.running());
    assert_eq!(process.process_group(), Some(child.id()));
    let reused = AdoptedProcess::new(std::process::id(), token, Path::new("/nonexistent"));
    assert!(!reused.running());
    assert_eq!(reused.process_group(), None);

    child.kill().unwrap();
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
    assert!(!process.running());
    child.wait().unwrap();
    assert!(!process.running());
}

#[tokio::test]
async fn commands_write_their_output_and_exit_code_to_files() {
    let directory = tempfile::tempdir().unwrap();
    let (mut command, spools) = shell_command(
        "echo out; echo err >&2; exit 3",
        "/bin/sh",
        directory.path(),
    )
    .unwrap();
    assert_eq!(command.status().await.unwrap().code(), Some(3));
    assert_eq!(read_exit_code(&directory.path().join(EXIT_STATUS)), Some(3));

    let output = Arc::new(Mutex::new(
        CapturedOutput::create(directory.path(), 100).await.unwrap(),
    ));
    let capture = spools.capture(output.clone());
    capture.stop.send(true).unwrap();
    capture.task.await.unwrap().unwrap();
    assert_eq!(output.lock().await.full_preview().output, "out\nerr\n");
}

#[tokio::test]
async fn capture_stops_once_the_spools_outgrow_the_log_quota() {
    let directory = tempfile::tempdir().unwrap();
    let (mut command, spools) =
        shell_command("yes | head -c 65536", "/bin/sh", directory.path()).unwrap();
    assert!(command.status().await.unwrap().success());
    let limits = CommandOutputLimits {
        max_log_bytes: 60 * 1024,
        ..CommandOutputLimits::default()
    };
    let output = Arc::new(Mutex::new(
        CapturedOutput::create_with_limits(directory.path(), 100, limits)
            .await
            .unwrap(),
    ));
    let error = spools
        .capture(output.clone())
        .task
        .await
        .unwrap()
        .unwrap_err();
    assert!(error.to_string().contains("quota"));
    assert_eq!(output.lock().await.full_preview().output, "");
}
