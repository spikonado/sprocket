mod process;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use rig::DynModel;
use rig::operation::Completion;
use serde_json::Value;

use self::process::Process;
use crate::cli_session::{self, Cli, ResumePoint, Spawn, error_event, resets_in};
use crate::types::CliLocator;

pub(crate) const USAGE_LIMIT_CODE: &str = "claude_subscription_usage_limit";
pub(crate) const ERROR_CODE: &str = "claude_code_error";

/// Runs Anthropic models through the local Claude Code CLI on the user's subscription.
#[derive(Clone)]
pub struct ClaudeCode {
    locator: Arc<dyn CliLocator>,
    config_dir: PathBuf,
}

impl ClaudeCode {
    pub fn new(locator: Arc<dyn CliLocator>, config_dir: PathBuf) -> Self {
        Self {
            locator,
            config_dir,
        }
    }

    pub(crate) async fn completion_model(
        &self,
        token: String,
        anthropic_model: &str,
        instructions: &str,
        cwd: &Path,
        resume: Option<ResumePoint>,
    ) -> anyhow::Result<DynModel<Completion>> {
        let cli = ClaudeCodeCli {
            executable: self.locator.executable().await?,
            config_dir: self.config_dir.clone(),
            token,
        };
        Ok(cli_session::completion_model(
            cli,
            anthropic_model,
            instructions,
            cwd,
            resume,
        ))
    }
}

struct ClaudeCodeCli {
    executable: PathBuf,
    config_dir: PathBuf,
    token: String,
}

impl Cli for ClaudeCodeCli {
    type Process = Process;

    const NAME: &'static str = "Claude Code";
    const ERROR_CODE: &'static str = ERROR_CODE;

    fn spawn(&self, spawn: Spawn<'_>) -> anyhow::Result<Process> {
        Process::spawn(self, spawn)
    }
}

/// The error event for a turn Claude Code ended with `result`.
fn result_error(result: &Value, rate_limit: Option<&Value>, now_secs: u64) -> Value {
    if result["is_error"] != true {
        return error_event(ERROR_CODE, "Claude Code ended the turn without a reply.");
    }
    let status = result["api_error_status"].as_u64();
    let rejected = rate_limit.filter(|info| info["status"] == "rejected");
    if status == Some(429) || rejected.is_some() {
        let resets = rejected
            .and_then(|info| info["resetsAt"].as_u64())
            .and_then(|at| at.checked_sub(now_secs))
            .map(resets_in)
            .unwrap_or_default();
        return error_event(
            USAGE_LIMIT_CODE,
            &format!(
                "Your Claude subscription's usage limit has been reached.{resets} Try again after it resets, or switch to another provider."
            ),
        );
    }
    if status == Some(401) {
        return error_event(
            ERROR_CODE,
            "Claude rejected the subscription token. Remove it and sign in with Claude again in Settings > BYOK/BYOS.",
        );
    }
    let detail = result["result"]
        .as_str()
        .or_else(|| result["errors"][0].as_str())
        .unwrap_or("Claude Code ended the turn with an error.");
    error_event(ERROR_CODE, detail)
}

#[cfg(test)]
mod tests;
