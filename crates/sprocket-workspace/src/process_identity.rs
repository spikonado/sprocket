use anyhow::Result;
use serde::{Deserialize, Serialize};

/// A command's process group. `leader_start` is the OS start time of the group
/// leader, so a later process that reuses the ID never matches.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandProcess {
    pub group_id: u32,
    pub leader_start: u64,
}

impl CommandProcess {
    pub(crate) fn of_group_leader(process_id: u32) -> Option<Self> {
        Some(Self {
            group_id: process_id,
            leader_start: process_start(process_id).ok()??,
        })
    }
}

/// Only a live leader with the recorded start time proves the group is still
/// the command's. Once the leader exits its ID may name an unrelated group, so
/// children that outlived a dead leader are left running.
pub(crate) fn stop_leftover_process_group(process: CommandProcess) -> Result<()> {
    match process_start(process.group_id) {
        Ok(Some(start)) if start == process.leader_start => {
            crate::commands::stop_remaining_processes(Some(process.group_id))
        }
        _ => Ok(()),
    }
}

/// `Ok(None)` means no process has this ID.
#[cfg(target_os = "linux")]
fn process_start(process_id: u32) -> std::io::Result<Option<u64>> {
    let stat = match std::fs::read_to_string(format!("/proc/{process_id}/stat")) {
        Ok(stat) => stat,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    // `starttime` is field 22; counting starts after the command name, which may contain spaces.
    stat.rsplit_once(')')
        .and_then(|(_, fields)| fields.split_whitespace().nth(19))
        .and_then(|start| start.parse().ok())
        .map(Some)
        .ok_or_else(|| std::io::Error::other("unexpected /proc stat format"))
}

#[cfg(target_os = "macos")]
fn process_start(process_id: u32) -> std::io::Result<Option<u64>> {
    let mut info = unsafe { std::mem::zeroed::<libc::proc_bsdinfo>() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    let written = unsafe {
        libc::proc_pidinfo(
            process_id as libc::c_int,
            libc::PROC_PIDTBSDINFO,
            0,
            (&raw mut info).cast(),
            size,
        )
    };
    if written == size {
        return Ok(Some(
            info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec,
        ));
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(None)
    } else {
        Err(error)
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn process_start(_process_id: u32) -> std::io::Result<Option<u64>> {
    Err(std::io::ErrorKind::Unsupported.into())
}
