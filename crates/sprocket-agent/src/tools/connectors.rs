use rig::tool::ToolExecutionError;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::context::AgentToolContext;
use super::job::execute_tool_job;

#[derive(Clone)]
pub(crate) struct ListConnectorsTool {
    pub(super) context: AgentToolContext,
    pub(super) installed_connectors: crate::InstalledConnectors,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct ListConnectorsArgs {}

impl rig::tool::Tool for ListConnectorsTool {
    const NAME: &'static str = "list_connectors";
    type Error = ToolExecutionError;
    type Args = ListConnectorsArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        "List the connectors installed on this machine, such as KiCad, with their versions. The user installs connectors in Settings → Connectors.".to_string()
    }

    fn parameters(&self) -> serde_json::Value {
        json!(schemars::schema_for!(ListConnectorsArgs))
    }

    async fn call(
        &self,
        _context: &mut rig::tool::ToolContext,
        _args: Self::Args,
    ) -> Result<Self::Output, Self::Error> {
        execute_tool_job(
            &self.context,
            Self::NAME,
            json!({}),
            |_cancellation| async { Ok(json!({ "connectors": (self.installed_connectors)() })) },
        )
        .await
    }
}
