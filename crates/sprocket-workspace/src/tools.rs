use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use crate::text::limit_chars;
use crate::workspace::{relative_to_root, resolve_workspace_path};
use anyhow::{Context, Result, bail};
use serde::Serialize;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;

const DEFAULT_COMMAND_TIMEOUT_MS: u64 = 60_000;
const DEFAULT_COMMAND_MAX_OUTPUT_CHARS: usize = 20_000;
const MAX_COMMAND_MAX_OUTPUT_CHARS: usize = 80_000;

#[derive(Clone)]
pub(crate) struct WorkspaceTools {
    root: PathBuf,
}

impl WorkspaceTools {
    pub(crate) fn new(root: PathBuf) -> Self {
        Self { root }
    }

    fn root(&self) -> &PathBuf {
        &self.root
    }

    async fn exec_command(
        &self,
        command: &str,
        workdir: Option<&str>,
        shell: Option<&str>,
        login: Option<bool>,
        timeout_ms: Option<u64>,
        max_output_chars: Option<usize>,
    ) -> Result<CommandExecOutput> {
        if command.trim().is_empty() {
            bail!("command cannot be empty");
        }

        let cwd = resolve_workspace_path(self.root(), workdir.unwrap_or("."), false)?;
        let output_limit = max_output_chars
            .unwrap_or(DEFAULT_COMMAND_MAX_OUTPUT_CHARS)
            .clamp(1, MAX_COMMAND_MAX_OUTPUT_CHARS);

        let mut process = build_shell_command(command, shell, login.unwrap_or(false));
        process
            .current_dir(&cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = process
            .spawn()
            .with_context(|| format!("failed to start command in {}", cwd.display()))?;
        let stdout_task = tokio::spawn(read_pipe(child.stdout.take()));
        let stderr_task = tokio::spawn(read_pipe(child.stderr.take()));

        let timeout =
            Duration::from_millis(timeout_ms.unwrap_or(DEFAULT_COMMAND_TIMEOUT_MS).max(1));
        let (status, timed_out) = match tokio::time::timeout(timeout, child.wait()).await {
            Ok(status) => (
                status
                    .with_context(|| format!("failed to wait for command in {}", cwd.display()))?,
                false,
            ),
            Err(_) => {
                let _ = child.kill().await;
                let status = child.wait().await.with_context(|| {
                    format!("failed to stop timed out command in {}", cwd.display())
                })?;
                (status, true)
            }
        };

        let stdout = String::from_utf8_lossy(&stdout_task.await??).to_string();
        let stderr = String::from_utf8_lossy(&stderr_task.await??).to_string();
        let combined_output = combine_command_output(&stdout, &stderr);
        let (output, truncated) = limit_chars(&combined_output, output_limit);

        Ok(CommandExecOutput {
            command: command.to_string(),
            cwd: workdir.map(str::to_owned),
            exit_code: status.code(),
            success: status.success() && !timed_out,
            timed_out,
            stdout,
            stderr,
            output,
            truncated,
        })
    }

    async fn create_file(&self, relative_path: &str, content: &str) -> Result<FileWriteOutput> {
        let path = resolve_workspace_path(self.root(), relative_path, true)?;
        if tokio::fs::try_exists(&path)
            .await
            .with_context(|| format!("failed to inspect {}", path.display()))?
        {
            bail!("file already exists: {}", path.display());
        }

        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .with_context(|| format!("failed to create {}", parent.display()))?;
        }

        tokio::fs::write(&path, content.as_bytes())
            .await
            .with_context(|| format!("failed to write {}", path.display()))?;

        Ok(FileWriteOutput {
            path: relative_to_root(self.root(), &path),
            bytes_written: content.len(),
        })
    }

    async fn replace_in_file(
        &self,
        relative_path: &str,
        old_text: &str,
        new_text: &str,
        replace_all: bool,
    ) -> Result<FileEditOutput> {
        if old_text.is_empty() {
            bail!("old_text cannot be empty");
        }

        let path = resolve_workspace_path(self.root(), relative_path, false)?;
        let contents = tokio::fs::read_to_string(&path)
            .await
            .with_context(|| format!("failed to read {}", path.display()))?;
        let occurrences = contents.matches(old_text).count();

        if occurrences == 0 {
            bail!("target text was not found in {}", path.display());
        }

        if occurrences > 1 && !replace_all {
            bail!(
                "target text matched {} times in {}; retry with replace_all=true or use a more specific old_text",
                occurrences,
                path.display()
            );
        }

        let next_contents = if replace_all {
            contents.replace(old_text, new_text)
        } else {
            contents.replacen(old_text, new_text, 1)
        };

        tokio::fs::write(&path, next_contents.as_bytes())
            .await
            .with_context(|| format!("failed to write {}", path.display()))?;

        Ok(FileEditOutput {
            path: relative_to_root(self.root(), &path),
            replacements: if replace_all { occurrences } else { 1 },
            bytes_written: next_contents.len(),
        })
    }
}

#[cfg(not(windows))]
fn build_shell_command(command: &str, shell: Option<&str>, login: bool) -> Command {
    let shell = shell
        .map(ToOwned::to_owned)
        .or_else(|| std::env::var("SHELL").ok())
        .unwrap_or_else(|| "/bin/bash".to_string());
    let mut process = Command::new(shell);
    process.arg(if login { "-lc" } else { "-c" }).arg(command);
    process
}

#[cfg(windows)]
fn build_shell_command(command: &str, shell: Option<&str>, login: bool) -> Command {
    let shell = shell.unwrap_or("powershell.exe");
    let mut process = Command::new(shell);
    process.arg("-NoLogo").arg("-NoProfile");
    if login {
        process.arg("-Login");
    }
    process.arg("-Command").arg(command);
    process
}

async fn read_pipe<T>(pipe: Option<T>) -> Result<Vec<u8>>
where
    T: AsyncRead + Unpin,
{
    let mut buffer = Vec::new();
    if let Some(mut pipe) = pipe {
        pipe.read_to_end(&mut buffer).await?;
    }
    Ok(buffer)
}

fn combine_command_output(stdout: &str, stderr: &str) -> String {
    if stdout.is_empty() {
        return stderr.to_string();
    }
    if stderr.is_empty() {
        return stdout.to_string();
    }
    format!("{stdout}\n{stderr}")
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandExecOutput {
    pub command: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    pub success: bool,
    pub timed_out: bool,
    pub stdout: String,
    pub stderr: String,
    pub output: String,
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileWriteOutput {
    pub path: String,
    pub bytes_written: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEditOutput {
    pub path: String,
    pub replacements: usize,
    pub bytes_written: usize,
}

pub async fn exec_workspace_command(
    workspace_root: PathBuf,
    command: &str,
    workdir: Option<&str>,
    shell: Option<&str>,
    login: Option<bool>,
    timeout_ms: Option<u64>,
    max_output_chars: Option<usize>,
) -> Result<CommandExecOutput> {
    WorkspaceTools::new(workspace_root)
        .exec_command(command, workdir, shell, login, timeout_ms, max_output_chars)
        .await
}

pub async fn create_workspace_file(
    workspace_root: PathBuf,
    path: &str,
    content: &str,
) -> Result<FileWriteOutput> {
    WorkspaceTools::new(workspace_root)
        .create_file(path, content)
        .await
}

pub async fn replace_workspace_file(
    workspace_root: PathBuf,
    path: &str,
    old_text: &str,
    new_text: &str,
    replace_all: bool,
) -> Result<FileEditOutput> {
    WorkspaceTools::new(workspace_root)
        .replace_in_file(path, old_text, new_text, replace_all)
        .await
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::WorkspaceTools;

    fn temp_workspace() -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after unix epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("sprocket-workspace-tests-{unique}"));
        fs::create_dir_all(&path).expect("temp dir should be created");
        path
    }

    #[tokio::test]
    async fn exec_command_runs_inside_workspace_root() {
        let root = temp_workspace();
        let tools = WorkspaceTools::new(root.clone());

        let output = tools
            .exec_command("pwd", None, None, Some(false), Some(5_000), None)
            .await
            .expect("command should succeed");

        assert!(output.success);
        assert!(
            output.stdout.contains(root.to_string_lossy().as_ref()),
            "unexpected output: {output:?}"
        );

        fs::remove_dir_all(root).expect("temp dir should be removed");
    }

    #[tokio::test]
    async fn exec_command_rejects_workdir_outside_workspace() {
        let root = temp_workspace();
        let tools = WorkspaceTools::new(root.clone());

        let result = tools
            .exec_command("pwd", Some("../"), None, Some(false), Some(5_000), None)
            .await;

        assert!(result.is_err());

        fs::remove_dir_all(root).expect("temp dir should be removed");
    }

    #[tokio::test]
    async fn replace_in_file_requires_unique_match_without_replace_all() {
        let root = temp_workspace();
        let path = root.join("src.txt");
        fs::write(&path, "alpha\nalpha\n").expect("fixture should be written");

        let tools = WorkspaceTools::new(root.clone());
        let result = tools
            .replace_in_file("src.txt", "alpha", "beta", false)
            .await;

        assert!(result.is_err());

        fs::remove_dir_all(root).expect("temp dir should be removed");
    }
}
