use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;

use crate::command_output::CapturedOutput;
use crate::commands::{CommandOutput, CommandStdinOutput};

#[derive(Clone, Deserialize, Serialize)]
pub struct CommandHistory {
    pub user_id: String,
    pub thread_id: String,
    pub machine_id: String,
    pub command: String,
    pub workdir: String,
    pub max_output_chars: usize,
    pub result: CommandOutput,
    /// Output not yet returned to the model, saved once the live session is released.
    #[serde(default, skip_serializing_if = "Option::is_none")]
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
            self.result = Self::load(log_directory, session_id).await?.result;
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

    pub async fn load(log_directory: &Path, session_id: &str) -> Result<CommandStdinOutput> {
        let path = history_path(log_directory, session_id)?;
        let contents = match tokio::fs::read(&path).await {
            Ok(contents) => contents,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                bail!("unknown command session: {session_id}");
            }
            Err(error) => return Err(error.into()),
        };
        let mut history: Self = serde_json::from_slice(&contents)
            .with_context(|| format!("failed to read command session {session_id}"))?;
        history.settle_interrupted(&path).await?;
        Ok(CommandStdinOutput {
            command: history.command,
            workdir: history.workdir,
            result: history.result,
        })
    }

    /// Persist an interrupted session so later polls consume its output once.
    pub(crate) async fn settle_interrupted(&mut self, path: &Path) -> Result<()> {
        if !self.result.running {
            return Ok(());
        }
        self.result.running = false;
        self.result.success = false;
        self.result.error = Some(
            "command session was interrupted before its final status was saved; output may be incomplete"
                .into(),
        );
        self.result.output = CapturedOutput::read_log_preview(
            Path::new(&self.result.complete_log_path),
            self.max_output_chars,
        )
        .await?;
        if self.pending_output.is_none() {
            self.pending_output = Some(self.result.output.clone());
        }
        self.save(path).await
    }
}

pub fn history_path(log_directory: &Path, session_id: &str) -> Result<PathBuf> {
    let id = uuid::Uuid::parse_str(session_id)
        .map_err(|_| anyhow::anyhow!("unknown command session: {session_id}"))?;
    Ok(log_directory.join("sessions").join(format!("{id}.json")))
}
