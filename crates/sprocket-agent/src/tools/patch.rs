use rig::tool::ToolExecutionError;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sprocket_workspace::{PatchOperation, apply_workspace_patch};

use super::context::{AgentToolContext, tool_error};
use super::job::execute_tool_job;
use super::wiring::add_wiring_issues;

#[derive(Clone)]
pub(crate) struct ApplyPatchTool(pub(super) AgentToolContext);

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct ApplyPatchArgs {
    /// Use `@@` or `@@ anchor`, never unified `@@ -n,m +p,q @@`.
    /// Supports `*** Delete File:`, `*** Move to:`, `*** Copy File:` / `*** Copy to:`.
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
        "Create, update, delete, rename, or copy files. A patch applies fully or not at all."
            .to_string()
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
            &self.0,
            Self::NAME,
            serde_json::to_value(&args).map_err(|e| tool_error(e.into()))?,
            |cancellation| async move {
                let output =
                    apply_workspace_patch(self.0.cwd.get(), cancellation.clone(), &args.patch)
                        .await
                        .map_err(tool_error)?;
                let mut value = serde_json::to_value(&output).map_err(|e| tool_error(e.into()))?;
                for (index, change) in output.changes.iter().enumerate() {
                    if matches!(change.operation, PatchOperation::Deleted) {
                        continue;
                    }
                    add_wiring_issues(
                        &self.0,
                        &cancellation,
                        &change.path,
                        &mut value["changes"][index],
                    )
                    .await;
                }
                Ok(value)
            },
        )
        .await
    }
}
