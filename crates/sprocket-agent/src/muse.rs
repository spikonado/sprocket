mod mcp;
mod msp;
mod process;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use rig::DynModel;
use rig::operation::Completion;
use serde_json::Value;

pub use self::msp::{Incoming, Msp};
use self::process::Process;
use crate::cli_session::{self, Cli, ResumePoint, Spawn, error_event, resets_in};
use crate::types::CliLocator;

pub(crate) const USAGE_LIMIT_CODE: &str = "muse_subscription_usage_limit";
pub(crate) const ERROR_CODE: &str = "muse_code_error";
const PLAN_REQUIRED: &str = "Muse Wonder Full needs the Power Usage or Maximum Usage plan of a Muse Code subscription. Upgrade it in Meta's Accounts Center, or switch to another provider.";
const SIGNED_OUT: &str =
    "Muse Code isn't signed in to a Muse Code subscription. Sign in in Settings > BYOK/BYOS.";

/// Runs Meta models through the local Muse Code CLI on the user's subscription.
#[derive(Clone)]
pub struct Muse {
    locator: Arc<dyn CliLocator>,
}

impl Muse {
    pub fn new(locator: Arc<dyn CliLocator>) -> Self {
        Self { locator }
    }

    pub(crate) async fn completion_model(
        &self,
        model: &str,
        instructions: &str,
        cwd: &Path,
        resume: Option<ResumePoint>,
    ) -> anyhow::Result<DynModel<Completion>> {
        let cli = MuseCli {
            executable: self.locator.executable().await?,
        };
        Ok(cli_session::completion_model(
            cli,
            model,
            instructions,
            cwd,
            resume,
        ))
    }
}

/// The ID Muse's `model/list` `result` serves catalog model `model` under, which follows
/// the user's Contributor mode. None when the user's plan doesn't include it.
pub fn served_model_id(result: &Value, model: &str) -> Option<String> {
    let contributor = format!("{model}-contributor");
    result["models"]
        .as_array()?
        .iter()
        .filter_map(|entry| entry["modelId"].as_str())
        .find(|id| *id == model || *id == contributor)
        .map(str::to_string)
}

struct MuseCli {
    executable: PathBuf,
}

impl Cli for MuseCli {
    type Process = Process;

    const NAME: &'static str = "Muse Code";
    const ERROR_CODE: &'static str = ERROR_CODE;

    fn spawn(&self, spawn: Spawn<'_>) -> anyhow::Result<Process> {
        Process::spawn(&self.executable, spawn)
    }
}

/// The error event for a turn Muse ended with `error`, an MSP `TurnError`.
fn turn_error(error: &Value, now_ms: u64) -> Value {
    let message = error["message"].as_str().unwrap_or_default();
    if !error["quota"].is_null() || is_usage_limit_refusal(message) {
        let resets = error["quota"]["resetsAtMs"]
            .as_u64()
            .and_then(|at| at.checked_sub(now_ms))
            .map(|ms| resets_in(ms / 1_000))
            .unwrap_or_default();
        return error_event(
            USAGE_LIMIT_CODE,
            &format!(
                "Your Muse Code subscription's usage limit has been reached.{resets} Try again after it resets, or switch to another provider."
            ),
        );
    }
    if error["kind"] == "authRequired" || message.contains("not logged in") {
        return error_event(ERROR_CODE, SIGNED_OUT);
    }
    let detail = if message.is_empty() {
        "Muse Code ended the turn with an error."
    } else {
        message
    };
    error_event(ERROR_CODE, detail)
}

/// Credential proxies can leave `quota` out of a 429 refusal, so its text counts too.
fn is_usage_limit_refusal(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    message.contains("429") && (message.contains("quota") || message.contains("usage limit"))
}

#[cfg(test)]
mod tests;
