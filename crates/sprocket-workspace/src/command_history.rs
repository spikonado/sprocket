use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;

use crate::command_output::{CapturedOutput, read_output_events};
use crate::commands::CommandOutput;
use crate::process_identity::{CommandProcess, stop_leftover_process_group};

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
    /// The sequence of the first `events.jsonl` event not yet returned to the model.
    #[serde(default)]
    pub read_sequence: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process: Option<CommandProcess>,
    /// Unreturned output saved by released servers before `read_sequence` existed.
    #[serde(default, skip_serializing)]
    pub pending_output: Option<String>,
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
            // The supervisor may have archived the result since this snapshot was read.
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

    /// Settles a session that an earlier server process on this machine left
    /// running and kills its leftover process group. Call only before this
    /// process starts commands.
    pub async fn settle_interrupted(path: &Path, machine_id: &str) -> Result<()> {
        let Some(mut history) = Self::read(path).await? else {
            return Ok(());
        };
        if !history.result.running || history.machine_id != machine_id {
            return Ok(());
        }
        if let Some(process) = history.process {
            stop_leftover_process_group(process)?;
        }
        history.mark_interrupted().await?;
        history.save(path).await
    }

    pub(crate) async fn mark_interrupted(&mut self) -> Result<()> {
        if self.result.running {
            self.result.running = false;
            self.result.success = false;
            self.result.error = Some(INTERRUPTED_ERROR.into());
            self.result.output = CapturedOutput::read_log_preview(
                Path::new(&self.result.complete_log_path),
                self.max_output_chars,
            )
            .await?;
        }
        Ok(())
    }

    /// Returns output the model hasn't received and advances `read_sequence`
    /// past it. Callers save the history before returning the output.
    pub(crate) async fn take_unreturned_output(&mut self, final_stream: bool) -> Result<String> {
        let unreturned = read_output_events(
            Path::new(&self.result.events_path),
            self.read_sequence,
            self.max_output_chars,
            final_stream,
        )
        .await?;
        self.read_sequence = unreturned.next_sequence;
        Ok(self.pending_output.take().unwrap_or(unreturned.output))
    }
}

pub fn history_path(log_directory: &Path, session_id: &str) -> Result<PathBuf> {
    let id = uuid::Uuid::parse_str(session_id)
        .map_err(|_| anyhow::anyhow!("unknown command session: {session_id}"))?;
    Ok(log_directory.join("sessions").join(format!("{id}.json")))
}
