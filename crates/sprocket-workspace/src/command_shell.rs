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
        windows::default_shell(std::env::var_os("PATH").as_deref())
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
        Ok(windows::resolve_shell(
            shell,
            std::env::var_os("PATH").as_deref(),
        ))
    }
}

#[cfg(windows)]
mod windows {
    use std::ffi::OsStr;
    use std::path::{Path, PathBuf};

    // These directories hold WSL launchers named bash.exe, which run commands
    // inside a Linux distro that can't see Windows paths.
    fn is_wsl_launcher_directory(directory: &Path) -> bool {
        directory.file_name().is_some_and(|name| {
            ["system32", "sysnative", "windowsapps"]
                .iter()
                .any(|launcher| name.eq_ignore_ascii_case(launcher))
        })
    }

    fn find_bash(path: Option<&OsStr>) -> Option<PathBuf> {
        let directories: Vec<PathBuf> = std::env::split_paths(path?).collect();
        let on_path = directories
            .iter()
            .filter(|directory| !is_wsl_launcher_directory(directory))
            .map(|directory| directory.join("bash.exe"))
            .find(|candidate| candidate.is_file());
        // Git for Windows usually only puts `Git\cmd` on PATH.
        on_path.or_else(|| {
            directories
                .iter()
                .filter(|directory| directory.join("git.exe").is_file())
                .filter_map(|directory| Some(directory.parent()?.join("bin").join("bash.exe")))
                .find(|candidate| candidate.is_file())
        })
    }

    pub(super) fn default_shell(path: Option<&OsStr>) -> String {
        find_bash(path)
            .map(|bash| bash.to_string_lossy().into_owned())
            .unwrap_or_else(|| "powershell.exe".to_string())
    }

    pub(super) fn resolve_shell(shell: &str, path: Option<&OsStr>) -> String {
        if (shell.eq_ignore_ascii_case("bash") || shell.eq_ignore_ascii_case("bash.exe"))
            && let Some(bash) = find_bash(path)
        {
            return bash.to_string_lossy().into_owned();
        }
        shell.to_string()
    }

    pub(crate) fn is_powershell(shell: &str) -> bool {
        Path::new(shell).file_stem().is_some_and(|stem| {
            stem.eq_ignore_ascii_case("powershell") || stem.eq_ignore_ascii_case("pwsh")
        })
    }

    #[cfg(test)]
    mod tests;
}

#[cfg(windows)]
pub(crate) use windows::is_powershell;

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
        ["bash", "/bin/bash"]
            .into_iter()
            .chain(configured)
            .chain(["sh", "/bin/sh"])
            .find_map(|shell| resolve_shell(shell, path, cwd).ok())
            .unwrap_or_else(|| "/bin/sh".into())
            .to_string_lossy()
            .into_owned()
    }

    #[cfg(test)]
    mod tests;
}
