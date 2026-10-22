use std::path::{Path, PathBuf};

use rig::completion::Message;
use rig::tool::ToolExecutionError;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sprocket_workspace::{resolve_directory, simplified_path};

use super::context::{AgentToolContext, tool_error};
use super::job::execute_tool_job;

#[derive(Clone)]
pub(crate) struct SetCwdTool(pub(super) AgentToolContext);

/// Rebuilt from the live cwd whenever history is replaced, so a handoff never
/// shows a model the directory a run started in.
pub(crate) fn working_directory_message(cwd: &Path) -> Message {
    Message::user(format!(
        "Relative paths in tools resolve from the current working directory `{}`. Use set_cwd to change it.",
        cwd.display()
    ))
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct SetCwdArgs {
    /// Directory to switch to. Relative paths resolve from the current working directory.
    pub(crate) path: String,
}

impl rig::tool::Tool for SetCwdTool {
    const NAME: &'static str = "set_cwd";
    type Error = ToolExecutionError;
    type Args = SetCwdArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        "Change the working directory that relative paths in every tool resolve from. It persists for the rest of this thread.".to_string()
    }

    fn parameters(&self) -> serde_json::Value {
        json!(schemars::schema_for!(SetCwdArgs))
    }

    async fn call(
        &self,
        _context: &mut rig::tool::ToolContext,
        args: Self::Args,
    ) -> Result<Self::Output, Self::Error> {
        let payload = serde_json::to_value(&args).map_err(|e| tool_error(e.into()))?;
        let output = execute_tool_job(&self.0, Self::NAME, payload, |_cancellation| async {
            let cwd = resolve_directory(&self.0.cwd.get(), &args.path).map_err(tool_error)?;
            Ok(json!({ "cwd": simplified_path(cwd).to_string_lossy() }))
        })
        .await?;
        // Convex persists the thread's cwd when the job completes, so only
        // switch locally once that has succeeded.
        if let Some(cwd) = output["cwd"].as_str() {
            self.0.cwd.set(PathBuf::from(cwd));
        }
        Ok(output)
    }
}
