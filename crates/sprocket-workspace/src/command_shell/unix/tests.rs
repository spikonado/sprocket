use std::fs;
use std::os::unix::fs::PermissionsExt;

use super::*;

fn shell_file(directory: &Path, name: &str) -> PathBuf {
    let shell = directory.join(name);
    fs::write(&shell, "#!/bin/sh\nexit 0\n").unwrap();
    fs::set_permissions(&shell, fs::Permissions::from_mode(0o755)).unwrap();
    shell
}

#[test]
fn default_prefers_bash_over_configured_shell() {
    let directory = tempfile::tempdir().unwrap();
    let configured = shell_file(directory.path(), "user-shell");
    let bash = shell_file(directory.path(), "bash");
    assert_eq!(
        default_shell(
            configured.to_str(),
            Some(directory.path().as_os_str()),
            directory.path(),
        ),
        bash.to_string_lossy()
    );
}

#[test]
fn default_finds_bash_on_path_when_user_shell_is_unavailable() {
    let directory = tempfile::tempdir().unwrap();
    let bash = shell_file(directory.path(), "bash");
    let stale = directory.path().join("removed-nix-shell");
    let not_executable = directory.path().join("not-executable");
    fs::write(&not_executable, "not a shell").unwrap();
    for configured in [None, Some(""), stale.to_str(), not_executable.to_str()] {
        assert_eq!(
            default_shell(
                configured,
                Some(directory.path().as_os_str()),
                directory.path(),
            ),
            bash.to_string_lossy()
        );
    }
}

#[test]
fn default_works_without_shell_or_path_environment() {
    let resolved = default_shell(None, None, Path::new("/"));
    assert!(executable(Path::new(&resolved)));
}

#[test]
fn shell_executable_only_by_other_users_is_unavailable() {
    if unsafe { libc::geteuid() } == 0 {
        return;
    }
    let directory = tempfile::tempdir().unwrap();
    let configured = shell_file(directory.path(), "user-shell");
    fs::set_permissions(&configured, fs::Permissions::from_mode(0o601)).unwrap();
    assert!(resolve_shell(configured.to_str().unwrap(), None, directory.path()).is_err());
}

#[test]
fn missing_conventional_path_resolves_same_shell_from_path() {
    let directory = tempfile::tempdir().unwrap();
    let name = format!("sprocket-shell-{}", uuid::Uuid::new_v4());
    let shell = shell_file(directory.path(), &name);
    for prefix in ["/bin", "/usr/bin"] {
        assert_eq!(
            resolve_shell(
                &format!("{prefix}/{name}"),
                Some(directory.path().as_os_str()),
                directory.path(),
            )
            .unwrap(),
            shell
        );
    }
}

#[test]
fn explicit_custom_shell_path_does_not_change_to_another_installation() {
    let directory = tempfile::tempdir().unwrap();
    let shell = shell_file(directory.path(), "custom-shell");
    let error = resolve_shell(
        directory
            .path()
            .join("missing/custom-shell")
            .to_str()
            .unwrap(),
        Some(directory.path().as_os_str()),
        directory.path(),
    )
    .unwrap_err();
    assert!(error.to_string().contains("shell executable was not found"));
    assert_eq!(
        resolve_shell("./custom-shell", None, directory.path()).unwrap(),
        directory.path().join("./custom-shell")
    );
    assert_eq!(
        resolve_shell("custom-shell", Some(OsStr::new(".")), directory.path()).unwrap(),
        shell
    );
}

#[tokio::test]
async fn exec_command_accepts_conventional_bash_path() {
    let directory = tempfile::tempdir().unwrap();
    let sessions = crate::CommandSessionManager::new(
        directory.path().to_path_buf(),
        directory.path().join("logs"),
    );
    let output = sessions
        .exec_command(
            crate::WorkspaceCancellation::new(),
            "values=(ready); printf '%s' \"${values[0]}\" > marker; cat marker",
            ".",
            "/bin/bash",
            Some(5_000),
            5_000,
            20_000,
        )
        .await
        .unwrap();
    assert!(output.result.success);
    assert_eq!(output.result.output, "ready");
    assert_eq!(
        fs::read_to_string(directory.path().join("marker")).unwrap(),
        "ready"
    );
    sessions.stop_all().await;
}
