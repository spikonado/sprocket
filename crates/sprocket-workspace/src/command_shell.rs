use std::path::Path;

use anyhow::Result;

pub fn default_command_shell() -> String {
    #[cfg(unix)]
    {
        let configured = std::env::var("SHELL").ok();
        let path = std::env::var_os("PATH");
        let cwd = std::env::current_dir().unwrap_or_else(|_| "/".into());
        unix::default_shell(configured.as_deref(), path.as_deref(), &cwd)
    }
    #[cfg(windows)]
    {
        "powershell.exe".to_string()
    }
}

pub(crate) fn resolve_command_shell(shell: &str, cwd: &Path) -> Result<String> {
    #[cfg(unix)]
    {
        unix::resolve_shell(shell, std::env::var_os("PATH").as_deref(), cwd)
            .map(|path| path.to_string_lossy().into_owned())
    }
    #[cfg(windows)]
    {
        let _ = cwd;
        Ok(shell.to_string())
    }
}

#[cfg(unix)]
mod unix {
    use std::ffi::{CString, OsStr};
    use std::os::unix::ffi::OsStrExt;
    use std::path::{Path, PathBuf};

    use anyhow::Result;

    fn executable(path: &Path) -> bool {
        if !path.is_file() {
            return false;
        }
        let Ok(path) = CString::new(path.as_os_str().as_bytes()) else {
            return false;
        };
        unsafe { libc::faccessat(libc::AT_FDCWD, path.as_ptr(), libc::X_OK, libc::AT_EACCESS) == 0 }
    }

    fn find_in_path(shell: &OsStr, path: Option<&OsStr>, cwd: &Path) -> Option<PathBuf> {
        std::env::split_paths(path?)
            .map(|directory| cwd.join(directory).join(shell))
            .find(|candidate| executable(candidate))
    }

    pub(super) fn resolve_shell(shell: &str, path: Option<&OsStr>, cwd: &Path) -> Result<PathBuf> {
        let requested = Path::new(shell);
        let resolved = if shell.is_empty() {
            None
        } else if requested.components().count() == 1 {
            find_in_path(requested.as_os_str(), path, cwd)
        } else {
            let candidate = cwd.join(requested);
            if executable(&candidate) {
                Some(candidate)
            } else if matches!(requested.parent(), Some(parent) if parent == Path::new("/bin") || parent == Path::new("/usr/bin"))
                && candidate.try_exists().is_ok_and(|exists| !exists)
            {
                // NixOS provides shells through PATH, not conventional /bin paths.
                requested
                    .file_name()
                    .and_then(|name| find_in_path(name, path, cwd))
            } else {
                None
            }
        };
        resolved.ok_or_else(|| {
            let kind = if cwd.join(requested).exists() {
                std::io::ErrorKind::PermissionDenied
            } else {
                std::io::ErrorKind::NotFound
            };
            anyhow::Error::new(std::io::Error::new(kind, "shell executable was not found or is not executable"))
                .context(format!(
                    "failed to start shell \"{shell}\" in {}: shell executable was not found or is not executable; omit `shell` to use an available default or provide an installed shell",
                    cwd.display()
                ))
        })
    }

    pub(super) fn default_shell(
        configured: Option<&str>,
        path: Option<&OsStr>,
        cwd: &Path,
    ) -> String {
        configured
            .into_iter()
            .chain(["bash", "/bin/bash", "sh", "/bin/sh"])
            .find_map(|shell| resolve_shell(shell, path, cwd).ok())
            .unwrap_or_else(|| "/bin/sh".into())
            .to_string_lossy()
            .into_owned()
    }

    #[cfg(test)]
    mod tests {
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
        fn default_uses_available_configured_shell() {
            let directory = tempfile::tempdir().unwrap();
            let configured = shell_file(directory.path(), "user-shell");
            shell_file(directory.path(), "bash");
            assert_eq!(
                default_shell(
                    configured.to_str(),
                    Some(directory.path().as_os_str()),
                    directory.path(),
                ),
                configured.to_string_lossy()
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
        fn default_skips_shell_executable_only_by_other_users() {
            if unsafe { libc::geteuid() } == 0 {
                return;
            }
            let directory = tempfile::tempdir().unwrap();
            let configured = shell_file(directory.path(), "user-shell");
            fs::set_permissions(&configured, fs::Permissions::from_mode(0o601)).unwrap();
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
    }
}
