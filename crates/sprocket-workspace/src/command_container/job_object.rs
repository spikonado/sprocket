use std::io;

use anyhow::{Context, Result};
use tokio::process::{Child, Command};
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_BREAKAWAY_OK,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JobObjectExtendedLimitInformation, SetInformationJobObject, TerminateJobObject,
};

pub struct Container {
    job: HANDLE,
}

// SAFETY: job object handles can be used from any thread.
unsafe impl Send for Container {}
unsafe impl Sync for Container {}

pub fn create() -> Result<Option<Container>> {
    // SAFETY: null attributes and name create an unnamed job with a handle children can't inherit.
    let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if job.is_null() {
        return Err(io::Error::last_os_error()).context("failed to create a job object");
    }
    let container = Container { job };
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    // Closing the last handle kills the job's processes, so they die even if the server crashes.
    // Programs that explicitly ask to break away still start instead of failing.
    limits.BasicLimitInformation.LimitFlags =
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
    // SAFETY: the pointer and size describe `limits`, which outlives the call.
    let configured = unsafe {
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            std::ptr::from_ref(&limits).cast(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    };
    if configured == 0 {
        return Err(io::Error::last_os_error()).context("failed to configure the job object");
    }
    Ok(Some(container))
}

impl Container {
    pub fn spawn(&self, command: &mut Command) -> io::Result<Child> {
        let child = command.spawn()?;
        // Anything the shell starts before this assignment is not contained. Shells take far
        // longer than this to start a child. A failed assignment falls back to `taskkill /T`,
        // which misses processes the shell detaches.
        if let Some(process) = child.raw_handle() {
            // SAFETY: both handles stay open for the call.
            if unsafe { AssignProcessToJobObject(self.job, process as HANDLE) } == 0 {
                tracing::warn!(
                    "failed to add a command shell to the job object: {}",
                    io::Error::last_os_error()
                );
            }
        }
        Ok(child)
    }

    pub async fn kill(&self) -> Result<()> {
        // SAFETY: `job` stays open until drop.
        if unsafe { TerminateJobObject(self.job, 1) } == 0 {
            return Err(io::Error::last_os_error()).context("failed to terminate the job object");
        }
        Ok(())
    }
}

impl Drop for Container {
    fn drop(&mut self) {
        // SAFETY: `job` is owned by this container and closed only here.
        unsafe { CloseHandle(self.job) };
    }
}
