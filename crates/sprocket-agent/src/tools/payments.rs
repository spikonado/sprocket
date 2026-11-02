mod cdp;

use std::collections::{BTreeMap, HashMap};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use fancy_regex::Regex;
use futures::StreamExt;
use rig::tool::{ToolErrorKind, ToolExecutionError};
use schemars::JsonSchema;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sprocket_workspace::WorkspaceCancellation;
use tokio::process::Command;
use tokio::sync::watch;
use tokio::time::{Instant, sleep, sleep_until, timeout};
use uuid::Uuid;

use self::cdp::{Interceptor, PausedPayment};
use super::async_tools::{YieldMode, default_yield_ms, is_default_yield_ms, yield_time_schema};
use super::context::{AgentToolContext, cancelled_error, tool_error, tool_failure};
use super::job::{action_args_from_payload, execute_tool_job, run_convex_tool_action};
use crate::convex::RuntimeClient;

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
pub(crate) struct PollCheckoutTool(pub(super) AgentToolContext);
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
    #[serde(
        default = "default_yield_ms",
        skip_serializing_if = "is_default_yield_ms"
    )]
    #[schemars(default = "default_yield_ms")]
    yield_time_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PollCheckoutArgs {
    /// purchaseId returned by card_checkout.
    purchase_id: String,
    #[serde(
        default = "default_yield_ms",
        skip_serializing_if = "is_default_yield_ms"
    )]
    #[schemars(default = "default_yield_ms")]
    yield_time_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReportOrderArgs {
    /// purchaseId returned by card_checkout.
    purchase_id: String,
    /// Order number shown by the store.
    order_number: String,
    /// https link to the store's page for this order.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    order_link: Option<String>,
    /// https link for tracking the shipment.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tracking_link: Option<String>,
}

impl rig::tool::Tool for CardCheckoutTool {
    const NAME: &'static str = "card_checkout";
    type Error = ToolExecutionError;
    type Args = CardCheckoutArgs;
    type Output = Value;

    fn description(&self) -> String {
        "Used by $paying-at-checkout.".to_string()
    }

    fn parameters(&self) -> Value {
        let mut schema = json!(schemars::schema_for!(CardCheckoutArgs));
        schema["properties"]["yieldTimeMs"] = yield_time_schema(
            YieldMode::Action,
            self.0.max_yield_ms,
            "Maximum time to wait for the user's approval before returning the tool call.",
        );
        schema
    }

    async fn call(
        &self,
        _context: &mut rig::tool::ToolContext,
        args: Self::Args,
    ) -> Result<Self::Output, Self::Error> {
        let payload = serde_json::to_value(&args).map_err(|error| tool_error(error.into()))?;
        let yield_time_ms = YieldMode::Action.normalize(args.yield_time_ms, self.0.max_yield_ms);
        execute_tool_job(&self.0, Self::NAME, payload, |cancellation| {
            let progress = start_checkout(self.0.clone(), args);
            async move {
                cancellable(&cancellation, wait_for_checkout(progress, yield_time_ms)).await
            }
        })
        .await
    }
}

impl rig::tool::Tool for PollCheckoutTool {
    const NAME: &'static str = "poll_checkout";
    type Error = ToolExecutionError;
    type Args = PollCheckoutArgs;
    type Output = Value;

    fn description(&self) -> String {
        "Used by $paying-at-checkout.".to_string()
    }

    fn parameters(&self) -> Value {
        let mut schema = json!(schemars::schema_for!(PollCheckoutArgs));
        schema["properties"]["yieldTimeMs"] = yield_time_schema(
            YieldMode::Poll,
            self.0.max_yield_ms,
            "Maximum time to wait for the user's approval before returning the tool call. Zero returns an immediate status snapshot.",
        );
        schema
    }

    async fn call(
        &self,
        _context: &mut rig::tool::ToolContext,
        args: Self::Args,
    ) -> Result<Self::Output, Self::Error> {
        let payload = serde_json::to_value(&args).map_err(|error| tool_error(error.into()))?;
        let yield_time_ms = YieldMode::Poll.normalize(args.yield_time_ms, self.0.max_yield_ms);
        execute_tool_job(&self.0, Self::NAME, payload, |cancellation| async move {
            match self.0.checkouts.get(&args.purchase_id) {
                Some(progress) => {
                    cancellable(&cancellation, wait_for_checkout(progress, yield_time_ms)).await
                }
                None => end_orphaned_checkout(&self.0, &cancellation, &args.purchase_id).await,
            }
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
        "Used by $paying-at-checkout.".to_string()
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

#[derive(Clone)]
enum CheckoutProgress {
    Starting,
    AwaitingApproval {
        purchase_id: String,
        merchant: String,
    },
    Finished(Result<Value, String>),
}

/// The run's checkouts by purchase id, so `poll_checkout` can wait on them.
#[derive(Clone, Default)]
pub(super) struct Checkouts(Arc<Mutex<HashMap<String, watch::Receiver<CheckoutProgress>>>>);

impl Checkouts {
    fn insert(&self, purchase_id: String, progress: watch::Receiver<CheckoutProgress>) {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(purchase_id, progress);
    }

    fn get(&self, purchase_id: &str) -> Option<watch::Receiver<CheckoutProgress>> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(purchase_id)
            .cloned()
    }
}

/// Runs the checkout outside the tool call, so approval can outlast one call.
/// The paused request lives in this process, so the checkout ends with its run.
fn start_checkout(
    context: AgentToolContext,
    args: CardCheckoutArgs,
) -> watch::Receiver<CheckoutProgress> {
    let (progress, receiver) = watch::channel(CheckoutProgress::Starting);
    tokio::spawn(async move {
        let cancellation = WorkspaceCancellation::new();
        let run_end = tokio::spawn(cancel_when_run_ends(context.clone(), cancellation.clone()));
        let result = card_checkout(&context, args, &progress, cancellation).await;
        run_end.abort();
        progress.send_replace(CheckoutProgress::Finished(
            result.map_err(|error| error.to_string()),
        ));
    });
    receiver
}

/// Losing the run's status counts as the run ending, since no tool call could
/// observe the checkout anymore.
async fn cancel_when_run_ends(context: AgentToolContext, cancellation: WorkspaceCancellation) {
    if let Ok(mut updates) = context
        .runtime
        .run_finished_subscription(&context.run_id)
        .await
    {
        while let Some(update) = updates.next().await {
            if !matches!(RuntimeClient::decode_run_finished_update(update), Ok(false)) {
                break;
            }
        }
    }
    cancellation.cancel();
}

async fn wait_for_checkout(
    mut progress: watch::Receiver<CheckoutProgress>,
    yield_time_ms: u64,
) -> Result<Value, ToolExecutionError> {
    let deadline = Instant::now() + Duration::from_millis(yield_time_ms);
    loop {
        let state = progress.borrow_and_update().clone();
        let changed = match state {
            CheckoutProgress::Finished(result) => return result.map_err(tool_failure),
            // Bounded by the payment request wait and the purchase create.
            CheckoutProgress::Starting => progress.changed().await,
            CheckoutProgress::AwaitingApproval {
                purchase_id,
                merchant,
            } => tokio::select! {
                changed = progress.changed() => changed,
                _ = sleep_until(deadline) => {
                    return Ok(finished("awaiting_approval", &purchase_id, &merchant, None));
                }
            },
        };
        if changed.is_err() {
            return Err(tool_failure("The checkout stopped unexpectedly."));
        }
    }
}

/// A purchase this run isn't running belongs to an ended run or a restarted
/// host, so nothing can complete it anymore.
async fn end_orphaned_checkout(
    context: &AgentToolContext,
    cancellation: &WorkspaceCancellation,
    purchase_id: &str,
) -> Result<Value, ToolExecutionError> {
    #[derive(Deserialize)]
    struct Ended {
        status: String,
        merchant: String,
    }
    let ended: Ended = decode(
        payments_action(
            context,
            cancellation,
            CANCEL,
            &json!({ "purchaseId": purchase_id }),
        )
        .await?,
        CANCEL,
    )?;
    let reason = (ended.status == "cancelled")
        .then(|| "The checkout ended with the run that started it.".to_string());
    Ok(finished(
        &ended.status,
        purchase_id,
        &ended.merchant,
        reason,
    ))
}

async fn card_checkout(
    context: &AgentToolContext,
    args: CardCheckoutArgs,
    progress: &watch::Sender<CheckoutProgress>,
    cancellation: WorkspaceCancellation,
) -> Result<Value, ToolExecutionError> {
    let recognizers: Vec<RecognizerSpec> = decode(
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
    let result = checkout(context, &mut interceptor, &args, progress, &cancellation).await;
    interceptor.close().await;
    result
}

async fn checkout(
    context: &AgentToolContext,
    interceptor: &mut Interceptor,
    args: &CardCheckoutArgs,
    progress: &watch::Sender<CheckoutProgress>,
    cancellation: &WorkspaceCancellation,
) -> Result<Value, ToolExecutionError> {
    let Some(payment) =
        wait_for_payment(context, interceptor, &args.pay_button, cancellation).await?
    else {
        return Ok(json!({ "status": "no_payment_request" }));
    };
    match approve(context, interceptor, args, &payment, progress, cancellation).await {
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
    progress: &watch::Sender<CheckoutProgress>,
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
    context
        .checkouts
        .insert(purchase_id.clone(), progress.subscribe());
    progress.send_replace(CheckoutProgress::AwaitingApproval {
        purchase_id: purchase_id.clone(),
        merchant: merchant.clone(),
    });
    let mut failures = 0;
    loop {
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => {
                return lost(context, &purchase_id, &merchant, "The run ended before the purchase was approved.").await;
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
        Some(status @ ("cancelled" | "declined" | "expired")) => Ok(Outcome::Stopped(finished(
            status,
            purchase_id,
            merchant,
            Some(format!("{reason} The purchase was not paid.")),
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
