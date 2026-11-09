use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, bail, ensure};
use tokio::process::Command;
use tokio::sync::{Mutex, watch};
use tokio::time::Instant;

use super::{Capture, PROCESS_POLL_INTERVAL, stop_remaining_processes};
use crate::command_output::{CapturedBytes, CapturedOutput, MAX_EVENT_OUTPUT_BYTES, OutputChannel};

const STDOUT_SPOOL: &str = "stdout.spool";
const STDERR_SPOOL: &str = "stderr.spool";
const EXIT_STATUS: &str = "exit-status";
const STOP_TIMEOUT: Duration = Duration::from_secs(5);

/// Saves the shell's exit code to `$1`, so a server that didn't start the shell can still learn
/// how it ended.
const WRAPPER: &str = r#"status=$1
shift
"$@"
code=$?
printf '%s\n' "$code" > "$status"
exit "$code""#;

/// Read ends of the files a command writes its output to. Unlike pipes, they keep taking output
/// while no server is reading them.
pub(in crate::commands) struct Spools {
    stdout: File,
    stderr: File,
    /// The spool lengths when capture was asked to stop. Later writes come from processes that
    /// left the command's group, so reading ends there.
    ends: Option<[u64; 2]>,
}

impl Spools {
    pub(in crate::commands) fn open(
        log_directory: &Path,
        captured: CapturedBytes,
    ) -> std::io::Result<Self> {
        let open = |name: &str, offset: u64| {
            let mut file = File::open(log_directory.join(name))?;
            file.seek(SeekFrom::Start(offset))?;
            Ok::<_, std::io::Error>(file)
        };
        Ok(Self {
            stdout: open(STDOUT_SPOOL, captured.stdout)?,
            stderr: open(STDERR_SPOOL, captured.stderr)?,
            ends: None,
        })
    }

    pub(in crate::commands) fn capture(self, output: Arc<Mutex<CapturedOutput>>) -> Capture {
        let (stop, stopping) = watch::channel(false);
        Capture {
            task: tokio::spawn(capture_spools(self, output, stopping)),
            stop,
        }
    }

    /// The spools' total length, and the next chunk of each.
    fn read_chunks(
        &mut self,
        stopping: bool,
    ) -> std::io::Result<(u64, Vec<(OutputChannel, Vec<u8>)>)> {
        let ends = match self.ends {
            Some(ends) => ends,
            None => {
                let lengths = [self.stdout.metadata()?.len(), self.stderr.metadata()?.len()];
                if stopping {
                    self.ends = Some(lengths);
                }
                lengths
            }
        };
        let mut chunks = Vec::new();
        for ((channel, file), end) in [
            (OutputChannel::Stdout, &mut self.stdout),
            (OutputChannel::Stderr, &mut self.stderr),
        ]
        .into_iter()
        .zip(ends)
        {
            let unread = end.saturating_sub(file.stream_position()?);
            if unread == 0 {
                continue;
            }
            let mut bytes = vec![0; unread.min(MAX_EVENT_OUTPUT_BYTES as u64) as usize];
            let read = file.read(&mut bytes)?;
            if read > 0 {
                bytes.truncate(read);
                chunks.push((channel, bytes));
            }
        }
        Ok((ends.iter().sum(), chunks))
    }
}

pub(super) fn shell_command(
    command: &str,
    shell: &str,
    log_directory: &Path,
) -> std::io::Result<(Command, Spools)> {
    let create = |name: &str| {
        OpenOptions::new()
            .append(true)
            .create_new(true)
            .open(log_directory.join(name))
    };
    let mut process = Command::new("/bin/sh");
    process
        .arg("-c")
        .arg(WRAPPER)
        .arg("sprocket-command")
        .arg(log_directory.join(EXIT_STATUS))
        .arg(shell)
        .arg("-c")
        .arg(command)
        .stdout(create(STDOUT_SPOOL)?)
        .stderr(create(STDERR_SPOOL)?);
    Ok((
        process,
        Spools::open(log_directory, CapturedBytes::default())?,
    ))
}

async fn capture_spools(
    mut spools: Spools,
    output: Arc<Mutex<CapturedOutput>>,
    mut stop: watch::Receiver<bool>,
) -> Result<()> {
    let max_log_bytes = output.lock().await.max_log_bytes();
    loop {
        // Checked before reading, so the read after a stop request sees all of the output.
        let stopping = *stop.borrow_and_update() || stop.has_changed().is_err();
        let (returned, chunks) = tokio::task::spawn_blocking(move || {
            let chunks = spools.read_chunks(stopping);
            (spools, chunks)
        })
        .await
        .context("command output reader failed")?;
        spools = returned;
        let (spooled, chunks) = chunks.context("failed to read command output")?;
        // Files don't hold back a writer the way pipes do, so the spools are limited here too.
        ensure!(
            spooled <= max_log_bytes,
            "command output log quota of {max_log_bytes} bytes reached",
        );
        if chunks.is_empty() {
            if stopping {
                return Ok(());
            }
            tokio::select! {
                _ = tokio::time::sleep(PROCESS_POLL_INTERVAL) => {},
                _ = stop.changed() => {},
            }
            continue;
        }
        let mut output = output.lock().await;
        for (channel, bytes) in chunks {
            output.append(channel, &bytes).await?;
        }
    }
}

/// A command's shell started by an earlier server, which this one can't wait on.
pub(in crate::commands) struct AdoptedProcess {
    pid: u32,
    start_token: String,
    exit_status: PathBuf,
}

impl AdoptedProcess {
    pub(in crate::commands) fn new(pid: u32, start_token: String, log_directory: &Path) -> Self {
        Self {
            pid,
            start_token,
            exit_status: log_directory.join(EXIT_STATUS),
        }
    }

    /// The command's process group, unless its pid now belongs to a newer process. The kernel
    /// doesn't reuse a pid while a group still uses it, so a reuse means the group is gone.
    pub(super) fn process_group(&self) -> Option<u32> {
        match process_start(self.pid) {
            Some((token, _)) if token != self.start_token => None,
            _ => Some(self.pid),
        }
    }

    fn running(&self) -> bool {
        process_start(self.pid).is_some_and(|(token, exited)| !exited && token == self.start_token)
    }

    pub(super) fn try_exit(&self) -> Option<Option<i32>> {
        (!self.running()).then(|| read_exit_code(&self.exit_status))
    }

    pub(in crate::commands) async fn terminate(&self) -> Result<Option<i32>> {
        stop_remaining_processes(self.process_group())?;
        let deadline = Instant::now() + STOP_TIMEOUT;
        while self.running() {
            if Instant::now() >= deadline {
                bail!("command process {} did not stop", self.pid);
            }
            tokio::time::sleep(PROCESS_POLL_INTERVAL).await;
        }
        Ok(read_exit_code(&self.exit_status))
    }
}

pub(in crate::commands) fn start_token(pid: u32) -> Option<String> {
    process_start(pid).map(|(token, _)| token)
}

pub(super) fn remove_files(log_directory: &Path) {
    for name in [STDOUT_SPOOL, STDERR_SPOOL, EXIT_STATUS] {
        let _ = std::fs::remove_file(log_directory.join(name));
    }
}

fn read_exit_code(path: &Path) -> Option<i32> {
    std::fs::read_to_string(path).ok()?.trim().parse().ok()
}

/// The kernel's start time for `pid` and whether the process has exited.
#[cfg(target_os = "linux")]
fn process_start(pid: u32) -> Option<(String, bool)> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // The command name can hold spaces and parentheses, so fields count from its closing one.
    let fields: Vec<&str> = stat.rsplit_once(')')?.1.split_whitespace().collect();
    let boot_id = std::fs::read_to_string("/proc/sys/kernel/random/boot_id").ok()?;
    let start_ticks = fields.get(19)?;
    let exited = matches!(*fields.first()?, "Z" | "X");
    Some((format!("{}:{start_ticks}", boot_id.trim()), exited))
}

#[cfg(target_os = "macos")]
fn process_start(pid: u32) -> Option<(String, bool)> {
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
    let size = size_of::<libc::proc_bsdinfo>() as libc::c_int;
    // SAFETY: the buffer holds one `proc_bsdinfo`, which is what this flavor writes.
    let written = unsafe {
        libc::proc_pidinfo(
            pid as libc::c_int,
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            size,
        )
    };
    if written != size {
        return None;
    }
    // SAFETY: proc_pidinfo filled the whole struct.
    let info = unsafe { info.assume_init() };
    Some((
        format!("{}.{:06}", info.pbi_start_tvsec, info.pbi_start_tvusec),
        info.pbi_status == libc::SZOMB,
    ))
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn process_start(_pid: u32) -> Option<(String, bool)> {
    None
}

#[cfg(test)]
mod tests;
