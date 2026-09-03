use rig::tool::ToolExecutionError;
use std::collections::BTreeMap;

use convex::Value;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::context::{AgentToolContext, tool_error, tool_failure};
use super::job::{execute_tool_job, run_convex_tool_action};

#[derive(Clone)]
pub(crate) struct BrowserActTool(pub(super) AgentToolContext);
#[derive(Clone)]
pub(crate) struct BrowserObserveTool(pub(super) AgentToolContext);
#[derive(Clone)]
pub(crate) struct BrowserExtractTool(pub(super) AgentToolContext);

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
pub(crate) struct BrowserObserveArgs {
    pub(crate) instruction: String,
    #[serde(rename = "startUrl", skip_serializing_if = "Option::is_none")]
    pub(crate) start_url: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
pub(crate) struct BrowserAction {
    pub(crate) selector: String,
    pub(crate) description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) method: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) arguments: Option<Vec<String>>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
pub(crate) struct BrowserActToolArgs {
    /// Natural-language instruction for the sub-agent, e.g. 'add 2 to cart and stop at the payment form'. Provide this or `action`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) instruction: Option<String>,
    /// A structured action returned by browser_observe (validate-then-act). Provide this or `instruction`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) action: Option<BrowserAction>,
    /// Optional URL to open first.
    #[serde(rename = "startUrl", skip_serializing_if = "Option::is_none")]
    pub(crate) start_url: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
pub(crate) struct BrowserExtractArgs {
    pub(crate) instruction: String,
    #[serde(rename = "startUrl", skip_serializing_if = "Option::is_none")]
    pub(crate) start_url: Option<String>,
}


impl rig::tool::Tool for BrowserObserveTool {
    const NAME: &'static str = "browser_observe";
    type Error = ToolExecutionError;
    type Args = BrowserObserveArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        "Discover actionable elements on the current page without executing them. Returns candidate actions (selector, description, method, arguments) that browser_act can then run.".to_string()
    }

    fn parameters(&self) -> serde_json::Value {
        json!(schemars::schema_for!(BrowserObserveArgs))
    }

    async fn call(
        &self,
        _context: &mut rig::tool::ToolContext,
        args: Self::Args,
    ) -> Result<Self::Output, Self::Error> {
        let payload = serde_json::to_value(&args).map_err(|e| tool_error(e.into()))?;
        execute_tool_job(
            &self.0.runtime,
            &self.0.run_id,
            &self.0.claim_id,
            Self::NAME,
            &self.0.tool_call_tracker,
            payload,
            |cancellation| {
                let mut action_args = BTreeMap::new();
                action_args.insert("runId".to_string(), self.0.run_id.clone().into());
                action_args.insert("claimId".to_string(), self.0.claim_id.clone().into());
                action_args.insert("instruction".to_string(), args.instruction.clone().into());
                if let Some(start_url) = &args.start_url {
                    action_args.insert("startUrl".to_string(), start_url.clone().into());
                }
                run_convex_tool_action(
                    &self.0.runtime,
                    cancellation,
                    "browserAgent:observe",
                    action_args,
                )
            },
        )
        .await
    }
}

impl rig::tool::Tool for BrowserActTool {
    const NAME: &'static str = "browser_act";
    type Error = ToolExecutionError;
    type Args = BrowserActToolArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        "Perform a browser action via the sub-agent: a natural-language instruction, or one specific action from browser_observe (validate-then-act). Use for all web browsing and checkout steps, including typing the payment credential returned by mandate_charge.".to_string()
    }

    fn parameters(&self) -> serde_json::Value {
        json!(schemars::schema_for!(BrowserActToolArgs))
    }

    async fn call(
        &self,
        _context: &mut rig::tool::ToolContext,
        args: Self::Args,
    ) -> Result<Self::Output, Self::Error> {
        let payload = serde_json::to_value(&args).map_err(|e| tool_error(e.into()))?;
        if args.instruction.is_none() && args.action.is_none() {
            return Err(tool_failure(
                "browser_act needs an instruction or an action".to_string(),
            ));
        }
        let action = match &args.action {
            Some(action) => Some(
                Value::try_from(serde_json::to_value(action).map_err(|e| tool_error(e.into()))?)
                    .map_err(tool_error)?,
            ),
            None => None,
        };
        execute_tool_job(
            &self.0.runtime,
            &self.0.run_id,
            &self.0.claim_id,
            Self::NAME,
            &self.0.tool_call_tracker,
            payload,
            |cancellation| {
                let mut action_args = BTreeMap::new();
                action_args.insert("runId".to_string(), self.0.run_id.clone().into());
                action_args.insert("claimId".to_string(), self.0.claim_id.clone().into());
                if let Some(instruction) = &args.instruction {
                    action_args.insert("instruction".to_string(), instruction.clone().into());
                }
                if let Some(action) = action {
                    action_args.insert("action".to_string(), action);
                }
                if let Some(start_url) = &args.start_url {
                    action_args.insert("startUrl".to_string(), start_url.clone().into());
                }
                run_convex_tool_action(
                    &self.0.runtime,
                    cancellation,
                    "browserAgent:act",
                    action_args,
                )
            },
        )
        .await
    }
}

impl rig::tool::Tool for BrowserExtractTool {
    const NAME: &'static str = "browser_extract";
    type Error = ToolExecutionError;
    type Args = BrowserExtractArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        "Extract structured data or text from the current page (e.g. the order summary and total)."
            .to_string()
    }

    fn parameters(&self) -> serde_json::Value {
        json!(schemars::schema_for!(BrowserExtractArgs))
    }

    async fn call(
        &self,
        _context: &mut rig::tool::ToolContext,
        args: Self::Args,
    ) -> Result<Self::Output, Self::Error> {
        let payload = serde_json::to_value(&args).map_err(|e| tool_error(e.into()))?;
        execute_tool_job(
            &self.0.runtime,
            &self.0.run_id,
            &self.0.claim_id,
            Self::NAME,
            &self.0.tool_call_tracker,
            payload,
            |cancellation| {
                let mut action_args = BTreeMap::new();
                action_args.insert("runId".to_string(), self.0.run_id.clone().into());
                action_args.insert("claimId".to_string(), self.0.claim_id.clone().into());
                action_args.insert("instruction".to_string(), args.instruction.clone().into());
                if let Some(start_url) = &args.start_url {
                    action_args.insert("startUrl".to_string(), start_url.clone().into());
                }
                run_convex_tool_action(
                    &self.0.runtime,
                    cancellation,
                    "browserAgent:extract",
                    action_args,
                )
            },
        )
        .await
    }
}
