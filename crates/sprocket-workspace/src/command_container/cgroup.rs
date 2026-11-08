use std::fs::{self, File, OpenOptions};
use std::io;
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use tokio::process::{Child, Command};
use tokio::time::Instant;

const REMOVAL_TIMEOUT: Duration = Duration::from_secs(5);
const REMOVAL_POLL_INTERVAL: Duration = Duration::from_millis(25);

pub struct Container {
    path: PathBuf,
    procs: File,
}

pub fn create() -> Result<Option<Container>> {
    let membership =
        fs::read_to_string("/proc/self/cgroup").context("failed to read /proc/self/cgroup")?;
    let Some(own) = membership.lines().find_map(|line| line.strip_prefix("0::")) else {
        bail!("the server is not in a cgroup v2 hierarchy");
    };
    let parent = Path::new("/sys/fs/cgroup").join(own.trim_start_matches('/'));
    // Moving a process needs write access to the cgroup.procs of the cgroup it leaves.
    OpenOptions::new()
        .write(true)
        .open(parent.join("cgroup.procs"))
        .with_context(|| format!("cannot move processes out of {}", parent.display()))?;
    let path = parent.join(format!("sprocket-commands-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&path).with_context(|| format!("failed to create {}", path.display()))?;
    let procs = if path.join("cgroup.kill").exists() {
        OpenOptions::new()
            .write(true)
            .open(path.join("cgroup.procs"))
    } else {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "cgroup.kill needs Linux 5.14 or newer",
        ))
    };
    match procs {
        Ok(procs) => Ok(Some(Container { path, procs })),
        Err(error) => {
            let _ = fs::remove_dir(&path);
            Err(error).with_context(|| format!("failed to set up {}", path.display()))
        }
    }
}

impl Container {
    pub fn spawn(&self, command: &mut Command) -> io::Result<Child> {
        let procs = self.procs.as_raw_fd();
        // SAFETY: write is async-signal-safe, and `procs` stays open while `spawn` forks.
        // Joining before exec means the shell cannot fork anything outside the cgroup. A failed
        // join leaves the shell in the server's cgroup, where its process group is still killed.
        unsafe {
            command.pre_exec(move || {
                let _ = libc::write(procs, b"0".as_ptr().cast(), 1);
                Ok(())
            });
        }
        command.spawn()
    }

    pub async fn kill(&self) -> Result<()> {
        tokio::fs::write(self.path.join("cgroup.kill"), "1")
            .await
            .with_context(|| format!("failed to kill {}", self.path.display()))?;
        let deadline = Instant::now() + REMOVAL_TIMEOUT;
        loop {
            match remove_with_nested_cgroups(&self.path) {
                Ok(()) => return Ok(()),
                // The cgroup stays busy until the kernel finishes tearing down the killed processes.
                Err(error)
                    if error.raw_os_error() == Some(libc::EBUSY) && Instant::now() < deadline =>
                {
                    tokio::time::sleep(REMOVAL_POLL_INTERVAL).await;
                }
                Err(error) => {
                    return Err(error)
                        .with_context(|| format!("failed to remove {}", self.path.display()));
                }
            }
        }
    }
}

impl Drop for Container {
    fn drop(&mut self) {
        let _ = remove_with_nested_cgroups(&self.path);
    }
}

fn remove_with_nested_cgroups(path: &Path) -> io::Result<()> {
    let result = fs::read_dir(path).and_then(|entries| {
        for entry in entries {
            let entry = entry?;
            if entry.file_type()?.is_dir() {
                remove_with_nested_cgroups(&entry.path())?;
            }
        }
        fs::remove_dir(path)
    });
    match result {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}
