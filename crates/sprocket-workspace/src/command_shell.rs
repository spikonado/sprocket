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
    mod tests;
}
