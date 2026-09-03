use std::time::Duration;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::time::sleep;

use super::context::{AgentToolContext, cancelled_error, tool_error};
use super::job::{action_args_from_payload, execute_tool_job, run_convex_tool_action};
use rig::tool::ToolExecutionError;

#[derive(Clone)]
pub(crate) struct MandateSetupTool(pub(super) AgentToolContext);
#[derive(Clone)]
pub(crate) struct MandateStatusTool(pub(super) AgentToolContext);
#[derive(Clone)]
pub(crate) struct MandateListTool(pub(super) AgentToolContext);
#[derive(Clone)]
pub(crate) struct MandateChargeTool(pub(super) AgentToolContext);
#[derive(Clone)]
pub(crate) struct MandateReportTool(pub(super) AgentToolContext);

#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum MandateFrequency {
    OneTime,
    Weekly,
    Monthly,
    Yearly,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub(crate) enum MandateScope {
    Listed,
    Any,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MandateSetupArgs {
    /// Merchant to lock this mandate to (required for `listed` scope).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) merchant_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) merchant_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) country_code: Option<String>,
    /// Per-charge cap as a decimal string, e.g. "120.00".
    pub(crate) amount_cap: String,
    pub(crate) currency: String,
    pub(crate) frequency: MandateFrequency,
    /// `listed` locks to one merchant; `any` allows any merchant (one-time only).
    pub(crate) scope: MandateScope,
    pub(crate) description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) max_charges: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) valid_until: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
pub(crate) struct MandateIdArgs {
    /// Mandate identifier returned by mandate_setup or mandate_status.
    #[serde(rename = "mandateId")]
    pub(crate) mandate_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MandateChargeArgs {
    /// Mandate identifier to charge.
    pub(crate) mandate_id: String,
    /// Charge amount as a decimal string, within the mandate's cap.
    pub(crate) amount: String,
    pub(crate) currency: String,
    pub(crate) description: String,
    /// Idempotency key; reusing it returns the original charge handle without re-issuing credentials.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) reference: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ChargeOutcome {
    Approved,
    Declined,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MandateReportArgs {
    /// Charge identifier returned by mandate_charge.
    pub(crate) charge_id: String,
    pub(crate) outcome: ChargeOutcome,
    /// Amount actually captured, if known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) amount_paid: Option<String>,
}


impl rig::tool::Tool for MandateSetupTool {
    const NAME: &'static str = "mandate_setup";
    type Error = ToolExecutionError;
    type Args = MandateSetupArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        "Set up a Prava spending mandate the user approves once with a passkey. The UI shows the approval link; do not paste it in your response, just tell the user to approve. Charge later with mandate_charge (no further passkey)."
            .to_string()
    }

    fn parameters(&self) -> serde_json::Value {
        json!(schemars::schema_for!(MandateSetupArgs))
    }

    async fn call(
        &self,
        _context: &mut rig::tool::ToolContext,
        args: Self::Args,
    ) -> Result<Self::Output, Self::Error> {
        mandate_action_job(
            &self.0,
            Self::NAME,
            "payments:mandateSetup",
            serde_json::to_value(args).map_err(|e| tool_error(e.into()))?,
        )
        .await
    }
}

impl rig::tool::Tool for MandateStatusTool {
    const NAME: &'static str = "mandate_status";
    type Error = ToolExecutionError;
    type Args = MandateIdArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        "Return a mandate's status, remaining spend, and caps. Pending means the user hasn't approved it yet."
            .to_string()
    }

    fn parameters(&self) -> serde_json::Value {
        json!(schemars::schema_for!(MandateIdArgs))
    }

    async fn call(
        &self,
        _context: &mut rig::tool::ToolContext,
        args: Self::Args,
    ) -> Result<Self::Output, Self::Error> {
        mandate_action_job(
            &self.0,
            Self::NAME,
            "payments:mandateStatus",
            serde_json::to_value(args).map_err(|e| tool_error(e.into()))?,
        )
        .await
    }
}

impl rig::tool::Tool for MandateListTool {
    const NAME: &'static str = "mandate_list";
    type Error = ToolExecutionError;
    type Args = serde_json::Value;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        "List the user's live mandates (one-time and standing) with status, caps, and remaining spend. Each entry includes the local mandateId that mandate_charge and mandate_status take. Use to discover an existing mandate before proposing a new one."
            .to_string()
    }

    fn parameters(&self) -> serde_json::Value {
        json!({ "type": "object", "properties": {}, "additionalProperties": false })
    }

    async fn call(
        &self,
        _context: &mut rig::tool::ToolContext,
        _args: Self::Args,
    ) -> Result<Self::Output, Self::Error> {
        mandate_action_job(&self.0, Self::NAME, "payments:mandateList", json!({})).await
    }
}

impl rig::tool::Tool for MandateChargeTool {
    const NAME: &'static str = "mandate_charge";
    type Error = ToolExecutionError;
    type Args = MandateChargeArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        "Charge an active mandate (no passkey needed) and return a single-use payment credential (token, dynamic CVV, expiry) only on that first response — credentials are not stored or replayed. Reusing `reference` returns the charge handle without credentials. Every charge MUST be settled afterwards with mandate_report — approved when the order completes, declined when it does not. A charge left unreported holds the mandate's remaining balance and eventually expires as abandoned."
            .to_string()
    }

    fn parameters(&self) -> serde_json::Value {
        json!(schemars::schema_for!(MandateChargeArgs))
    }

    async fn call(
        &self,
        _context: &mut rig::tool::ToolContext,
        args: Self::Args,
    ) -> Result<Self::Output, Self::Error> {
        mandate_action_job(
            &self.0,
            Self::NAME,
            "payments:mandateCharge",
            serde_json::to_value(args).map_err(|e| tool_error(e.into()))?,
        )
        .await
    }
}

impl rig::tool::Tool for MandateReportTool {
    const NAME: &'static str = "mandate_report";
    type Error = ToolExecutionError;
    type Args = MandateReportArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        "Report the final outcome of a charge to settle it with the card network. MANDATORY after every mandate_charge: approved when the checkout completes, declined when the checkout fails, is abandoned, or the credential goes unused. Never leave a charge unreported — the network holds the amount until you settle."
            .to_string()
    }

    fn parameters(&self) -> serde_json::Value {
        json!(schemars::schema_for!(MandateReportArgs))
    }

    async fn call(
        &self,
        _context: &mut rig::tool::ToolContext,
        args: Self::Args,
    ) -> Result<Self::Output, Self::Error> {
        mandate_action_job(
            &self.0,
            Self::NAME,
            "payments:mandateReport",
            serde_json::to_value(args).map_err(|e| tool_error(e.into()))?,
        )
        .await
    }
}


pub(super) async fn mandate_action_job(
    context: &AgentToolContext,
    kind: &str,
    function: &'static str,
    payload: serde_json::Value,
) -> Result<serde_json::Value, ToolExecutionError> {
    let runtime = context.runtime.clone();
    let run_id = context.run_id.clone();
    let claim_id = context.claim_id.clone();
    execute_tool_job(
        &context.runtime,
        &context.run_id,
        &context.claim_id,
        kind,
        &context.tool_call_tracker,
        payload.clone(),
        |cancellation| async move {
            let action_args = action_args_from_payload(&run_id, &claim_id, &payload)?;
            loop {
                if cancellation.is_cancelled() {
                    return Err(cancelled_error());
                }
                let result = run_convex_tool_action(
                    &runtime,
                    cancellation.clone(),
                    function,
                    action_args.clone(),
                )
                .await?;
                let in_flight = result
                    .get("inFlight")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false);
                if !in_flight {
                    return Ok(result);
                }
                tokio::select! {
                    biased;
                    _ = cancellation.cancelled() => return Err(cancelled_error()),
                    _ = sleep(Duration::from_millis(250)) => {}
                }
            }
        },
    )
    .await
}
