use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;

use crate::command_output::CapturedOutput;
use crate::commands::{CommandOutput, CommandStdinOutput};

#[derive(Clone, Deserialize, Serialize)]
pub struct CommandHistory {
    #[serde(default)]
    pub user_id: String,
    #[serde(default)]
    pub thread_id: String,
    #[serde(default)]
    pub machine_id: String,
    pub command: String,
    pub workdir: String,
    pub max_output_chars: usize,
    pub result: CommandOutput,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::command_output::OutputChannel;

    #[tokio::test]
    async fn interrupted_session_recovers_output_without_claiming_success() {
        let root = tempfile::tempdir().unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let mut output = CapturedOutput::create(root.path(), 20_000).await.unwrap();
        output
            .append(OutputChannel::Stdout, b"before restart\n")
            .await
            .unwrap();
        let preview = output.preview_metadata();
        let history = CommandHistory {
            user_id: String::new(),
            thread_id: String::new(),
            machine_id: String::new(),
            command: "build".into(),
            workdir: "/workspace".into(),
            max_output_chars: 20_000,
            result: CommandOutput {
                exit_code: None,
                running: true,
                success: false,
                timed_out: false,
                output: String::new(),
                complete_log_path: preview.complete_log_path,
                events_path: preview.events_path,
                error: None,
            },
        };
        history
            .save(&history_path(root.path(), &id).unwrap())
            .await
            .unwrap();
        let mut recovered = history;
        recovered
            .recover_if_running(root.path(), &id)
            .await
            .unwrap();
        assert_eq!(recovered.command, "build");
        assert_eq!(recovered.result.output, "before restart\n");
        assert!(!recovered.result.running);
        assert!(!recovered.result.success);
        assert!(recovered.result.error.unwrap().contains("interrupted"));
        assert_eq!(recovered.result.exit_code, None);
    }
}

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
        if history.result.running {
            history.result.running = false;
            history.result.success = false;
            history.result.error = Some(
                "command session was interrupted before its final status was saved; output may be incomplete"
                    .into(),
            );
            history.result.output = CapturedOutput::read_log_preview(
                Path::new(&history.result.complete_log_path),
                history.max_output_chars,
            )
            .await?;
        }
        Ok(CommandStdinOutput {
            command: history.command,
            workdir: history.workdir,
            result: history.result,
        })
    }
}

pub fn history_path(log_directory: &Path, session_id: &str) -> Result<PathBuf> {
    let id = uuid::Uuid::parse_str(session_id)
        .map_err(|_| anyhow::anyhow!("unknown command session: {session_id}"))?;
    Ok(log_directory.join("sessions").join(format!("{id}.json")))
}
