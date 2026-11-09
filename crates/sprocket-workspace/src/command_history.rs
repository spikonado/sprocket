use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;

use crate::command_output::{UnreturnedOutput, read_log_from};
use crate::commands::CommandOutput;

const INTERRUPTED_ERROR: &str =
    "command session was interrupted before its final status was saved; output may be incomplete";

#[derive(Clone, Deserialize, Serialize)]
pub struct CommandHistory {
    pub user_id: String,
    pub thread_id: String,
    pub machine_id: String,
    pub command: String,
    pub workdir: String,
    pub max_output_chars: usize,
    pub result: CommandOutput,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process: Option<ProcessRecord>,
}

/// What a later server needs to adopt a command that outlived the server that started it.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ProcessRecord {
    pub pid: u32,
    /// The kernel's start time for `pid`, which tells the process apart from a later one that
    /// reuses its pid.
    pub start_token: String,
    pub started_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deadline_ms: Option<u64>,
}

#[cfg(test)]
mod tests;

impl CommandHistory {
    pub async fn recover_if_running(
        &mut self,
        log_directory: &Path,
        session_id: &str,
    ) -> Result<()> {
        if self.result.running {
            let Some(mut saved) = Self::read(&history_path(log_directory, session_id)?).await?
            else {
                bail!("unknown command session: {session_id}");
            };
            saved.mark_interrupted().await?;
            self.result = saved.result;
        }
        Ok(())
    }

    pub async fn save(&self, path: &Path) -> Result<()> {
        let parent = path.parent().context("command history has no directory")?;
        tokio::fs::create_dir_all(parent).await?;
        let temporary = tempfile::NamedTempFile::new_in(parent)?;
        let (file, temporary_path) = temporary.into_parts();
        let mut file = tokio::fs::File::from_std(file);
        file.write_all(&serde_json::to_vec(self)?).await?;
        file.flush().await?;
        file.sync_all().await?;
        drop(file);
        temporary_path.persist(path)?;
        Ok(())
    }

    pub(crate) async fn read(path: &Path) -> Result<Option<Self>> {
        match tokio::fs::read(path).await {
            Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes).with_context(|| {
                format!("failed to read command history {}", path.display())
            })?)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    pub(crate) fn is_orphaned_on(&self, machine_id: &str) -> bool {
        self.machine_id == machine_id && self.result.running
    }

    pub(crate) async fn mark_interrupted(&mut self) -> Result<()> {
        if self.result.running {
            self.result.running = false;
            self.result.success = false;
            self.result.error = Some(INTERRUPTED_ERROR.into());
            self.result.output = self.read_output(0).await?.output;
        }
        Ok(())
    }

    pub(crate) async fn read_output(&self, from_offset: u64) -> Result<UnreturnedOutput> {
        read_log_from(
            Path::new(&self.result.complete_log_path),
            from_offset,
            self.max_output_chars,
            !self.result.running,
        )
        .await
    }
}

pub fn history_path(log_directory: &Path, session_id: &str) -> Result<PathBuf> {
    let id = uuid::Uuid::parse_str(session_id)
        .map_err(|_| anyhow::anyhow!("unknown command session: {session_id}"))?;
    Ok(log_directory.join("sessions").join(format!("{id}.json")))
}
