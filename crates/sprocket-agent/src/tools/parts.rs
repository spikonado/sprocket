use rig::tool::ToolExecutionError;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::context::{AgentToolContext, tool_error};
use super::job::execute_cloud_tool_job;

#[derive(Clone)]
pub(crate) struct LookupPartsTool(pub(super) AgentToolContext);

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct LookupPartsArgs {
    /// Manufacturer part numbers or LCSC/JLCPCB part numbers like `C2864583`.
    #[schemars(length(min = 1, max = 50))]
    pub(crate) parts: Vec<String>,
    /// Order quantity for `unitPrice`. Defaults to 1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1))]
    pub(crate) quantity: Option<u32>,
}

impl rig::tool::Tool for LookupPartsTool {
    const NAME: &'static str = "lookup_parts";
    type Error = ToolExecutionError;
    type Args = LookupPartsArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        "Check stock, prices, MOQ, lifecycle, and JLCPCB library type for a list of parts at JLCPCB, LCSC, DigiKey, and Mouser. Use it for stock, price, and availability checks, and `scrape_url` for datasheets and specs. Prices are USD unless an offer has `currency`."
            .to_string()
    }

    fn parameters(&self) -> serde_json::Value {
        json!(schemars::schema_for!(LookupPartsArgs))
    }

    async fn call(
        &self,
        _context: &mut rig::tool::ToolContext,
        args: Self::Args,
    ) -> Result<Self::Output, Self::Error> {
        let payload = serde_json::to_value(&args).map_err(|e| tool_error(e.into()))?;
        execute_cloud_tool_job(&self.0, Self::NAME, payload).await
    }
}
