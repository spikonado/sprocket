use rig::tool::ToolExecutionError;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sprocket_workspace::apply_workspace_patch;

use super::context::{AgentToolContext, tool_error};
use super::job::execute_tool_job;

#[derive(Clone)]
pub(crate) struct ApplyPatchTool(pub(super) AgentToolContext);

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
pub(crate) struct ApplyPatchArgs {
    /// Prefer Begin Patch format.
    /// For Begin Patch, use `@@` or `@@ anchor`, never unified `@@ -n,m +p,q @@`.
    /// Supports `*** Delete File:`, `*** Move to:`, `*** Copy File:` / `*** Copy to:`.
    /// Unified/`diff --git` also accepted; well-formed hunk line counts are auto-corrected.
    /// Example:
    /// *** Begin Patch
    /// *** Add File: path/to/new.txt
    /// +hello
    /// *** Update File: path/to/existing.txt
    /// @@
    /// -old
    /// +new
    /// *** End Patch
    pub(crate) patch: String,
}

impl rig::tool::Tool for ApplyPatchTool {
    const NAME: &'static str = "apply_patch";
    type Error = ToolExecutionError;
    type Args = ApplyPatchArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        "Use to create, update, delete, rename, or copy files.".to_string()
    }

    fn parameters(&self) -> serde_json::Value {
        json!(schemars::schema_for!(ApplyPatchArgs))
    }

    async fn call(
        &self,
        _context: &mut rig::tool::ToolContext,
        args: Self::Args,
    ) -> Result<Self::Output, Self::Error> {
        execute_tool_job(
            &self.0.runtime,
            &self.0.run_id,
            &self.0.claim_id,
            Self::NAME,
            &self.0.tool_call_tracker,
            serde_json::to_value(&args).map_err(|e| tool_error(e.into()))?,
            |cancellation| async {
                let output =
                    apply_workspace_patch(self.0.workspace_root.clone(), cancellation, &args.patch)
                        .await
                        .map_err(tool_error)?;
                serde_json::to_value(output).map_err(|e| tool_error(e.into()))
            },
        )
        .await
    }
}
