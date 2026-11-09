use std::sync::Arc;

use anyhow::Result;
use tokio::process::{Child, Command};

#[cfg(target_os = "linux")]
mod cgroup;
#[cfg(windows)]
mod job_object;

#[cfg(target_os = "linux")]
use cgroup as platform;
#[cfg(windows)]
use job_object as platform;

#[cfg(not(any(target_os = "linux", windows)))]
mod platform {
    pub enum Container {}

    pub fn create(_name: &str) -> anyhow::Result<Option<Container>> {
        Ok(None)
    }

    impl Container {
        pub fn spawn(
            &self,
            _command: &mut tokio::process::Command,
        ) -> std::io::Result<tokio::process::Child> {
            match *self {}
        }

        pub async fn kill(&self) -> anyhow::Result<()> {
            match *self {}
        }
    }
}

/// Holds every process that command sessions start, including ones that leave the shell's
/// process group, so shutdown can kill them all. Linux uses a cgroup and Windows a job object.
#[derive(Clone)]
pub struct CommandContainer(Arc<platform::Container>);

impl CommandContainer {
    /// Returns `None` on operating systems without a way to contain a process tree. On Linux, a
    /// server that restarts under the same `name` takes over the earlier server's processes.
    pub fn create(name: &str) -> Result<Option<Self>> {
        Ok(platform::create(name)?.map(|container| Self(Arc::new(container))))
    }

    pub(crate) fn spawn(&self, command: &mut Command) -> std::io::Result<Child> {
        self.0.spawn(command)
    }

    pub async fn kill(&self) -> Result<()> {
        self.0.kill().await
    }
}
