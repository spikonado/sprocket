use super::*;

#[tokio::test]
async fn run_trusts_the_os_certificate_store() {
    let mut command = if cfg!(windows) {
        let mut command = Command::new("cmd");
        command.args(["/C", "echo %AGENT_BROWSER_USE_SYSTEM_CA%"]);
        command
    } else {
        let mut command = Command::new("printenv");
        command.arg(AGENT_BROWSER_USE_SYSTEM_CA);
        command
    };
    let output = run(&mut command).await.unwrap();
    assert!(output.status.success());
    assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "1");
}
