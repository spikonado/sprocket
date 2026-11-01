mod cdp;

use std::collections::BTreeMap;
use std::process::Stdio;
use std::time::Duration;

use fancy_regex::Regex;
use rig::tool::{ToolErrorKind, ToolExecutionError};
use schemars::JsonSchema;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sprocket_workspace::WorkspaceCancellation;
use tokio::process::Command;
use tokio::time::{sleep, timeout};
use uuid::Uuid;

use self::cdp::{Interceptor, PausedPayment};
use super::context::{AgentToolContext, cancelled_error, tool_error, tool_failure};
use super::job::{action_args_from_payload, execute_tool_job, run_convex_tool_action};

const RECOGNIZERS: &str = "payments:checkoutRecognizers";
const CREATE: &str = "payments:checkoutCreate";
const POLL: &str = "payments:checkoutPoll";
const CANCEL: &str = "payments:checkoutCancel";
const REPORT_ORDER: &str = "payments:reportOrder";

const PAYMENT_REQUEST_WAIT: Duration = Duration::from_secs(60);
const AGENT_BROWSER_TIMEOUT: Duration = Duration::from_secs(60);
const CANCEL_TIMEOUT: Duration = Duration::from_secs(15);
const MIN_POLL_INTERVAL: Duration = Duration::from_millis(500);
const CREATE_RETRY_DELAY: Duration = Duration::from_secs(2);
const MAX_CONVEX_FAILURES: u32 = 3;

#[derive(Clone)]
pub(crate) struct CardCheckoutTool(pub(super) AgentToolContext);
#[derive(Clone)]
pub(crate) struct ReportOrderTool(pub(super) AgentToolContext);

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CardCheckoutArgs {
    /// Order total in major units as a decimal string, e.g. "23.06".
    amount: String,
    /// ISO 4217 currency code, e.g. "usd".
    currency: String,
    /// agent-browser ref of the store's Pay or Place order button, e.g. "@e12".
    pay_button: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReportOrderArgs {
    /// purchaseId returned by card_checkout.
    purchase_id: String,
    /// Order number shown by the store.
    order_number: String,
}

impl rig::tool::Tool for CardCheckoutTool {
    const NAME: &'static str = "card_checkout";
    type Error = ToolExecutionError;
    type Args = CardCheckoutArgs;
    type Output = Value;

    fn description(&self) -> String {
        "Pay at a store's checkout open in agent-browser with the user's saved card. Ask the user before buying. Fill the checkout first, typing the placeholder card 4242 4242 4242 4242 with any future expiry and any CVC. Then call this with the Pay button's ref instead of clicking it; Sprocket clicks it and the user approves the purchase with a passkey. Never retry after outcome_unknown; check the store page instead. After approved, confirm the order on the store page, then call report_order."
            .to_string()
    }

    fn parameters(&self) -> Value {
        json!(schemars::schema_for!(CardCheckoutArgs))
    }

    async fn call(
        &self,
        _context: &mut rig::tool::ToolContext,
        args: Self::Args,
    ) -> Result<Self::Output, Self::Error> {
        let payload = serde_json::to_value(&args).map_err(|error| tool_error(error.into()))?;
        execute_tool_job(&self.0, Self::NAME, payload, |cancellation| {
            card_checkout(&self.0, args, cancellation)
        })
        .await
    }
}

impl rig::tool::Tool for ReportOrderTool {
    const NAME: &'static str = "report_order";
    type Error = ToolExecutionError;
    type Args = ReportOrderArgs;
    type Output = Value;

    fn description(&self) -> String {
        "Record the store's order number for a card_checkout purchase once the store page confirms the order."
            .to_string()
    }

    fn parameters(&self) -> Value {
        json!(schemars::schema_for!(ReportOrderArgs))
    }

    async fn call(
        &self,
        _context: &mut rig::tool::ToolContext,
        args: Self::Args,
    ) -> Result<Self::Output, Self::Error> {
        let payload = serde_json::to_value(&args).map_err(|error| tool_error(error.into()))?;
        execute_tool_job(
            &self.0,
            Self::NAME,
            payload.clone(),
            |cancellation| async move {
                payments_action(&self.0, &cancellation, REPORT_ORDER, &payload).await
            },
        )
        .await
    }
}

#[derive(Deserialize)]
struct RecognizerList {
    recognizers: Vec<RecognizerSpec>,
}

#[derive(Deserialize)]
pub(super) struct RecognizerSpec {
    psp: String,
    hosts: Vec<String>,
    #[serde(rename = "match")]
    host_and_path: String,
}

/// A processor endpoint Agentcard can complete.
pub(super) struct Recognizer {
    psp: String,
    hosts: Vec<Regex>,
    host_and_path: Regex,
}

impl Recognizer {
    fn compile(spec: &RecognizerSpec) -> Result<Self, fancy_regex::Error> {
        Ok(Self {
            psp: spec.psp.clone(),
            hosts: spec
                .hosts
                .iter()
                .map(|host| Regex::new(host))
                .collect::<Result<_, _>>()?,
            host_and_path: Regex::new(&format!("^(?:{})$", spec.host_and_path))?,
        })
    }
}

pub(super) fn compile_recognizers(specs: &[RecognizerSpec]) -> Vec<Recognizer> {
    specs
        .iter()
        .filter_map(|spec| {
            Recognizer::compile(spec)
                .inspect_err(|error| {
                    eprintln!(
                        "sprocket-agent: skipping the {} payment recognizer: {error}",
                        spec.psp
                    );
                })
                .ok()
        })
        .collect()
}

/// Returns the processor of a payment request, matching the parsed URL so a
/// processor endpoint in the query never counts.
pub(super) fn recognize<'a>(recognizers: &'a [Recognizer], url: &str) -> Option<&'a str> {
    let url = url::Url::parse(url).ok()?;
    let host = url.host_str()?;
    let host_and_path = format!("{host}{}", url.path());
    recognizers
        .iter()
        .find(|recognizer| {
            recognizer
                .hosts
                .iter()
                .any(|pattern| pattern.is_match(host).unwrap_or(false))
                && recognizer
                    .host_and_path
                    .is_match(&host_and_path)
                    .unwrap_or(false)
        })
        .map(|recognizer| recognizer.psp.as_str())
}

/// The exact origin Agentcard binds a purchase to, or `None` for non-https pages.
pub(super) fn checkout_origin(page_url: &str) -> Option<String> {
    let url = url::Url::parse(page_url).ok()?;
    (url.scheme() == "https").then(|| url.origin().ascii_serialization())
}

/// Headers for the fulfilled processor response. The page calls the processor
/// cross-origin, so CORS must allow the paused request's origin. The body is
/// replayed decoded, so its original framing headers no longer apply.
pub(super) fn fulfilled_headers(
    response: &BTreeMap<String, String>,
    request_origin: Option<&str>,
) -> Vec<(String, String)> {
    const REPLACED: [&str; 5] = [
        "access-control-allow-origin",
        "access-control-allow-credentials",
        "content-encoding",
        "content-length",
        "transfer-encoding",
    ];
    let mut headers: Vec<_> = response
        .iter()
        .filter(|(name, _)| {
            !REPLACED
                .iter()
                .any(|replaced| name.eq_ignore_ascii_case(replaced))
        })
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect();
    if let Some(origin) = request_origin {
        headers.push(("access-control-allow-origin".into(), origin.into()));
    }
    headers.push(("access-control-allow-credentials".into(), "true".into()));
    headers
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CheckoutState {
    status: String,
    purchase_id: Option<String>,
    poll_interval_ms: Option<f64>,
    reason: Option<String>,
    response: Option<ProcessorResponse>,
}

#[derive(Deserialize)]
pub(super) struct ProcessorResponse {
    pub(super) status: u16,
    #[serde(default)]
    pub(super) headers: BTreeMap<String, String>,
    pub(super) body: String,
}

enum Outcome {
    Approved {
        purchase_id: String,
        merchant: String,
        response: ProcessorResponse,
    },
    /// Anything else; the paused request must not reach the processor.
    Stopped(Value),
}

async fn card_checkout(
    context: &AgentToolContext,
    args: CardCheckoutArgs,
    cancellation: WorkspaceCancellation,
) -> Result<Value, ToolExecutionError> {
    let RecognizerList { recognizers } = decode(
        payments_action(context, &cancellation, RECOGNIZERS, &json!({})).await?,
        RECOGNIZERS,
    )?;
    let recognizers = compile_recognizers(&recognizers);
    let cdp_url = cancellable(&cancellation, agent_browser(context, &["get", "cdp-url"]))
        .await?
        .get("cdpUrl")
        .and_then(Value::as_str)
        .ok_or_else(|| tool_failure("agent-browser did not report the browser's CDP URL."))?
        .to_string();
    let tabs = cancellable(&cancellation, agent_browser(context, &["tab", "list"])).await?;
    let target_id = active_target(&tabs).ok_or_else(|| {
        tool_failure("agent-browser has no active tab. Open the checkout page first.")
    })?;
    let mut interceptor = cancellable(&cancellation, async {
        Interceptor::arm(&cdp_url, target_id, recognizers)
            .await
            .map_err(tool_error)
    })
    .await?;
    let result = checkout(context, &mut interceptor, &args, &cancellation).await;
    interceptor.close().await;
    result
}

async fn checkout(
    context: &AgentToolContext,
    interceptor: &mut Interceptor,
    args: &CardCheckoutArgs,
    cancellation: &WorkspaceCancellation,
) -> Result<Value, ToolExecutionError> {
    let Some(payment) =
        wait_for_payment(context, interceptor, &args.pay_button, cancellation).await?
    else {
        return Ok(json!({ "status": "no_payment_request" }));
    };
    match approve(context, interceptor, args, &payment, cancellation).await {
        Ok(Outcome::Approved {
            purchase_id,
            merchant,
            response,
        }) => Ok(match interceptor.fulfill(&payment, &response).await {
            Ok(()) => finished("approved", &purchase_id, &merchant, None),
            Err(_) => finished(
                "outcome_unknown",
                &purchase_id,
                &merchant,
                Some("The approved payment could not reach the checkout page.".into()),
            ),
        }),
        Ok(Outcome::Stopped(result)) => {
            interceptor.fail(&payment).await;
            Ok(result)
        }
        Err(error) => {
            interceptor.fail(&payment).await;
            Err(error)
        }
    }
}

async fn wait_for_payment(
    context: &AgentToolContext,
    interceptor: &mut Interceptor,
    pay_button: &str,
    cancellation: &WorkspaceCancellation,
) -> Result<Option<PausedPayment>, ToolExecutionError> {
    let click_args = ["click", pay_button];
    let click = agent_browser(context, &click_args);
    tokio::pin!(click);
    let mut clicked = false;
    let deadline = sleep(PAYMENT_REQUEST_WAIT);
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(cancelled_error()),
            payment = interceptor.payment() => return payment.map(Some).map_err(tool_error),
            result = &mut click, if !clicked => {
                result?;
                clicked = true;
            }
            _ = &mut deadline => return Ok(None),
        }
    }
}

async fn approve(
    context: &AgentToolContext,
    interceptor: &Interceptor,
    args: &CardCheckoutArgs,
    payment: &PausedPayment,
    cancellation: &WorkspaceCancellation,
) -> Result<Outcome, ToolExecutionError> {
    let page_url = interceptor.page_url().await.map_err(tool_error)?;
    let origin = checkout_origin(&page_url)
        .ok_or_else(|| tool_failure("card_checkout only works on https checkout pages."))?;
    let merchant = origin.trim_start_matches("https://").to_string();
    let create_args = action_args_from_payload(
        &context.run_id,
        &context.claim_id,
        &json!({
            "attemptId": Uuid::new_v4().to_string(),
            "checkoutOrigin": origin,
            "amount": args.amount,
            "currency": args.currency,
            "psp": payment.psp,
            "request": payment.request.to_convex(),
        }),
    )?;
    // Not cancellable: once the purchase exists, its id is needed to cancel it.
    // A failed create may still have started the purchase, so retries reuse the
    // attempt id and Convex returns that purchase instead of starting another.
    let mut create_failures = 0;
    let created: CheckoutState = loop {
        match context
            .runtime
            .action_json::<Value>(CREATE, create_args.clone())
            .await
        {
            Ok(value) => break decode(value, CREATE)?,
            Err(error) => {
                create_failures += 1;
                if create_failures >= MAX_CONVEX_FAILURES {
                    return Err(tool_failure(format!(
                        "{error:#} Sprocket can't tell whether the purchase started, so don't retry the checkout. Ask the user to check the approval card in this thread and Settings → Payments."
                    )));
                }
                sleep(CREATE_RETRY_DELAY).await;
            }
        }
    };
    let (purchase_id, mut interval) = match (created.status.as_str(), created.purchase_id) {
        ("card_required", _) => {
            return Ok(Outcome::Stopped(json!({
                "status": "card_required",
                "reason": "The user has no saved card. They can save one with the Save a card button below this tool call, or in Settings → Payments.",
            })));
        }
        ("awaiting_approval", Some(purchase_id)) => {
            (purchase_id, poll_interval(created.poll_interval_ms))
        }
        _ => {
            return Err(tool_failure(format!(
                "{CREATE} returned an unexpected response"
            )));
        }
    };
    let mut failures = 0;
    loop {
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => {
                cancel_purchase(context, &purchase_id).await;
                return Err(cancelled_error());
            }
            _ = interceptor.closed() => {
                return lost(context, &purchase_id, &merchant, "The browser closed during checkout.").await;
            }
            _ = sleep(interval) => {}
        }
        let polled = payments_action(
            context,
            cancellation,
            POLL,
            &json!({ "purchaseId": purchase_id }),
        )
        .await
        .and_then(|value| decode::<CheckoutState>(value, POLL));
        let state = match polled {
            Ok(state) => state,
            Err(error) if error.kind() == ToolErrorKind::Cancelled => continue,
            Err(error) => {
                failures += 1;
                if failures < MAX_CONVEX_FAILURES {
                    continue;
                }
                return lost(context, &purchase_id, &merchant, &error.to_string()).await;
            }
        };
        failures = 0;
        interval = poll_interval(state.poll_interval_ms);
        if state.status == "awaiting_approval" {
            continue;
        }
        return Ok(match (state.status.as_str(), state.response) {
            ("approved", Some(response)) => Outcome::Approved {
                purchase_id,
                merchant,
                response,
            },
            (status @ ("submitted_on_device" | "declined" | "expired"), _) => {
                Outcome::Stopped(finished(status, &purchase_id, &merchant, state.reason))
            }
            _ => Outcome::Stopped(finished(
                "outcome_unknown",
                &purchase_id,
                &merchant,
                state.reason,
            )),
        });
    }
}

/// Cancels a purchase Sprocket can no longer complete. It may already be past
/// approval, in which case only the store knows whether the order went through.
async fn lost(
    context: &AgentToolContext,
    purchase_id: &str,
    merchant: &str,
    reason: &str,
) -> Result<Outcome, ToolExecutionError> {
    match cancel_purchase(context, purchase_id).await.as_deref() {
        Some("declined") => Err(tool_failure(format!(
            "{reason} Sprocket cancelled the purchase before it was paid."
        ))),
        _ => Ok(Outcome::Stopped(finished(
            "outcome_unknown",
            purchase_id,
            merchant,
            Some(reason.into()),
        ))),
    }
}

async fn cancel_purchase(context: &AgentToolContext, purchase_id: &str) -> Option<String> {
    let args = action_args_from_payload(
        &context.run_id,
        &context.claim_id,
        &json!({ "purchaseId": purchase_id }),
    )
    .ok()?;
    let result = timeout(
        CANCEL_TIMEOUT,
        context.runtime.action_json::<Value>(CANCEL, args),
    )
    .await
    .ok()?
    .inspect_err(|error| eprintln!("sprocket-agent: {CANCEL} failed: {error:#}"))
    .ok()?;
    result
        .get("status")
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn finished(status: &str, purchase_id: &str, merchant: &str, reason: Option<String>) -> Value {
    let mut result = json!({ "status": status, "purchaseId": purchase_id, "merchant": merchant });
    if let Some(reason) = reason {
        result["reason"] = reason.into();
    }
    result
}

fn poll_interval(milliseconds: Option<f64>) -> Duration {
    milliseconds.map_or(MIN_POLL_INTERVAL, |milliseconds| {
        Duration::from_millis(milliseconds as u64).max(MIN_POLL_INTERVAL)
    })
}

async fn payments_action(
    context: &AgentToolContext,
    cancellation: &WorkspaceCancellation,
    function: &str,
    payload: &Value,
) -> Result<Value, ToolExecutionError> {
    let args = action_args_from_payload(&context.run_id, &context.claim_id, payload)?;
    run_convex_tool_action(&context.runtime, cancellation.clone(), function, args).await
}

/// Payment responses can carry processor data, so decode errors never echo them.
fn decode<T: DeserializeOwned>(value: Value, function: &str) -> Result<T, ToolExecutionError> {
    serde_json::from_value(value)
        .map_err(|_| tool_failure(format!("{function} returned an unexpected response")))
}

async fn cancellable<T>(
    cancellation: &WorkspaceCancellation,
    work: impl std::future::Future<Output = Result<T, ToolExecutionError>>,
) -> Result<T, ToolExecutionError> {
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err(cancelled_error()),
        result = work => result,
    }
}

/// Runs agent-browser like the agent's own commands do, so it reaches the
/// thread's browser session.
async fn agent_browser(
    context: &AgentToolContext,
    args: &[&str],
) -> Result<Value, ToolExecutionError> {
    #[derive(Deserialize)]
    struct Reply {
        success: bool,
        data: Option<Value>,
        error: Option<String>,
    }
    let command_line = args.join(" ");
    let mut command = Command::new("agent-browser");
    command
        .arg("--json")
        .args(args)
        .envs(
            context
                .command_sessions
                .environment()
                .iter()
                .map(|(key, value)| (key, value)),
        )
        .current_dir(context.cwd.get())
        .stdin(Stdio::null())
        .kill_on_drop(true);
    let output = timeout(AGENT_BROWSER_TIMEOUT, command.output())
        .await
        .map_err(|_| tool_failure(format!("agent-browser {command_line} timed out")))?
        .map_err(|error| tool_failure(format!("Could not run agent-browser: {error}")))?;
    match serde_json::from_slice::<Reply>(&output.stdout) {
        Ok(Reply {
            success: true,
            data: Some(data),
            ..
        }) => Ok(data),
        Ok(Reply { error, .. }) => Err(tool_failure(format!(
            "agent-browser {command_line} failed: {}",
            error.unwrap_or_default()
        ))),
        Err(_) => Err(tool_failure(format!(
            "agent-browser {command_line} failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))),
    }
}

fn active_target(tabs: &Value) -> Option<String> {
    tabs.get("tabs")?
        .as_array()?
        .iter()
        .find(|tab| tab.get("active").and_then(Value::as_bool) == Some(true))?
        .get("targetId")?
        .as_str()
        .map(str::to_string)
}

#[cfg(test)]
mod tests;
