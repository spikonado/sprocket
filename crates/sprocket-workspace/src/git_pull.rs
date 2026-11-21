use std::ffi::OsString;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context, bail};
use tokio::process::Command;

use crate::github::{agent_environment, hide_console_window};

const PULL_TIMEOUT: Duration = Duration::from_secs(120);

/// Fast-forwards `checkout` to its upstream. Git refuses when the branch has diverged
/// or the pull would overwrite local changes, so the user's work is never merged or lost.
pub async fn pull_fast_forward(
    checkout: &Path,
    tool_environment: Vec<(OsString, OsString)>,
) -> anyhow::Result<()> {
    let mut git = Command::new("git");
    git.args([
        "pull",
        "--no-rebase",
        "--ff-only",
        "--no-autostash",
        "--quiet",
    ])
    .current_dir(checkout)
    .envs(tool_environment)
    .envs(agent_environment().await)
    .env("GIT_TERMINAL_PROMPT", "0")
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::piped())
    .kill_on_drop(true);
    hide_console_window(&mut git);
    let output = tokio::time::timeout(PULL_TIMEOUT, git.output())
        .await
        .context("git pull timed out")?
        .context("couldn't run git")?;
    if !output.status.success() {
        bail!(
            "git pull failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests;
