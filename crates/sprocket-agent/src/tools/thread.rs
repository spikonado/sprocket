use rig::tool::ToolExecutionError;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::context::AgentToolContext;
use super::job::execute_tool_job;

#[derive(Clone)]
pub(crate) struct GetThreadIdTool(pub(super) AgentToolContext);

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct GetThreadIdArgs {}

impl rig::tool::Tool for GetThreadIdTool {
    const NAME: &'static str = "get_thread_id";
    type Error = ToolExecutionError;
    type Args = GetThreadIdArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        "Get the ID of the current Sprocket thread.".to_string()
    }

    fn parameters(&self) -> serde_json::Value {
        json!(schemars::schema_for!(GetThreadIdArgs))
    }

    async fn call(
        &self,
        _context: &mut rig::tool::ToolContext,
        _args: Self::Args,
    ) -> Result<Self::Output, Self::Error> {
        execute_tool_job(&self.0, Self::NAME, json!({}), |_cancellation| async {
            Ok(json!({ "threadId": self.0.thread_id }))
        })
        .await
    }
}
