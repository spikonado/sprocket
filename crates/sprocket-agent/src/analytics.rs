use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use rig::agent::{
    AgentHook, CompletionCallAction, CompletionCallEvent, DispatchAction, DispatchEvent,
    HookContext, ModelTurnAction, ModelTurnFinished, OutcomeAction, OutcomeEvent,
};
use rig::completion::{FinishReason, PromptError, ToolDefinition};
use rig::effect::EffectId;
use rig::message::AssistantContent;
use serde::Serialize;
use serde_json::{Map, Value, json};
use sprocket_convex::{ConvexErrorCode, convex_error_code};

use crate::chatgpt::ChatGptNotConnected;
use crate::provider::ProviderFailures;
use crate::stream_recovery::is_provider_failure_cause;
use crate::types::{CompletionProvider, ContextBudget};
use crate::usage::{ModelCallUsage, UsageSource};

#[derive(Clone)]
pub(crate) struct GenerationTracker {
    user_id: String,
    run_id: String,
    thread_id: String,
    initial_provider: CompletionProvider,
    context_budget: ContextBudget,
    state: Arc<Mutex<TrackerState>>,
}

#[derive(Default)]
struct TrackerState {
    turns: HashMap<usize, PendingModelCall>,
    in_flight_turn: Option<usize>,
    parameter_defaults: HashMap<String, Map<String, Value>>,
    tools: HashMap<EffectId, PendingTool>,
    handoff: Option<PendingHandoff>,
}

struct PendingModelCall {
    started_at: Instant,
    /// Rig streams a call's usage before the hook that sees its content, so the event waits here.
    event: Option<posthog_rs::Event>,
}

struct PendingTool {
    started_at: Instant,
    changed_defaults: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum HandoffTrigger {
    ContextLimit,
    ProviderSwitch,
}

pub(crate) enum HandoffOutcome<'a> {
    Resumed,
    ContinuedWithoutHandoff { reason: &'a str },
    Failed { error: &'a anyhow::Error },
    Cancelled,
}

struct PendingHandoff {
    started_at: Instant,
    writer: Option<(CompletionProvider, String)>,
    model_calls: u32,
    /// `None` once any writing call can't be priced.
    cost_usd: Option<f64>,
    /// Holds the properties known at the start, and is sent on drop if the run future is dropped.
    event: Option<posthog_rs::Event>,
}

impl PendingHandoff {
    fn new(event: posthog_rs::Event) -> Self {
        Self {
            started_at: Instant::now(),
            writer: None,
            model_calls: 0,
            cost_usd: Some(0.0),
            event: Some(event),
        }
    }

    fn record_call(&mut self, call: &ModelCall<'_>) {
        self.writer = Some((call.provider, call.model.to_string()));
        self.model_calls += 1;
        self.cost_usd = self
            .cost_usd
            .zip(call.cost_usd)
            .map(|(sum, cost)| sum + cost);
    }

    fn finish(&mut self, outcome: &HandoffOutcome<'_>) -> Option<posthog_rs::Event> {
        let mut event = self.event.take()?;
        for (key, value) in handoff_properties(self, outcome) {
            let _ = event.insert_prop(key, value);
        }
        Some(event)
    }
}

impl Drop for PendingHandoff {
    fn drop(&mut self) {
        if let Some(event) = self.finish(&HandoffOutcome::Cancelled) {
            posthog_rs::capture(event);
        }
    }
}

// Rig skips the content hook for a turn that ends the run or gets abandoned.
impl Drop for PendingModelCall {
    fn drop(&mut self) {
        if let Some(event) = self.event.take() {
            posthog_rs::capture(event);
        }
    }
}

struct ModelCall<'a> {
    provider: CompletionProvider,
    model: &'a str,
    usage: Option<&'a ModelCallUsage>,
    cost_usd: Option<f64>,
    finish_reason: Option<&'a FinishReason>,
    error: Option<String>,
    context_handoff: bool,
    provider_fallback: bool,
}

impl GenerationTracker {
    pub(crate) fn new(
        user_id: &str,
        run_id: &str,
        thread_id: &str,
        initial_provider: CompletionProvider,
        context_budget: ContextBudget,
    ) -> Self {
        Self {
            user_id: user_id.to_string(),
            run_id: run_id.to_string(),
            thread_id: thread_id.to_string(),
            initial_provider,
            context_budget,
            state: Arc::default(),
        }
    }

    pub(crate) fn capture(
        &self,
        turn: usize,
        source: &UsageSource,
        context_handoff: bool,
        usage: Option<&ModelCallUsage>,
        finish_reason: Option<&FinishReason>,
    ) {
        let call = ModelCall {
            usage,
            cost_usd: usage.and_then(|usage| source.cost_usd(usage)),
            finish_reason,
            ..self.model_call(source, context_handoff)
        };
        let mut state = self.state.lock().ok();
        let pending = state.as_mut().and_then(|state| {
            if context_handoff && let Some(handoff) = &mut state.handoff {
                handoff.record_call(&call);
            }
            state.in_flight_turn = None;
            state.turns.remove(&turn)
        });
        let event =
            self.model_call_event(&call, pending.as_ref().map(|pending| pending.started_at));
        match (state, pending) {
            (Some(mut state), Some(mut pending)) => {
                pending.event = Some(event);
                state.turns.insert(turn, pending);
            }
            _ => posthog_rs::capture(event),
        }
    }

    /// Rig reports no usage for a call that fails, so only the in-flight call is known.
    pub(crate) fn capture_failure(
        &self,
        source: &UsageSource,
        context_handoff: bool,
        error: &PromptError,
    ) {
        let call = ModelCall {
            error: Some(error.to_string()),
            ..self.model_call(source, context_handoff)
        };
        let Some(pending) = self.state.lock().ok().and_then(|mut state| {
            let turn = state.in_flight_turn.take()?;
            if context_handoff && let Some(handoff) = &mut state.handoff {
                handoff.record_call(&call);
            }
            state.turns.remove(&turn)
        }) else {
            return;
        };
        posthog_rs::capture(self.model_call_event(&call, Some(pending.started_at)));
    }

    pub(crate) fn start_handoff(&self, trigger: HandoffTrigger, context_tokens: u64) {
        let event = self.event(
            "context_handoff",
            [
                ("trigger", to_json(trigger)),
                ("context_tokens", json!(context_tokens)),
                (
                    "handoff_token_limit",
                    json!(self.context_budget.auto_handoff_token_limit),
                ),
                (
                    "context_window_tokens",
                    json!(self.context_budget.context_window_tokens),
                ),
            ],
        );
        if let Ok(mut state) = self.state.lock() {
            state.handoff = Some(PendingHandoff::new(event));
        }
    }

    /// Does nothing when no handoff is open, so every run exit can call it.
    pub(crate) fn finish_handoff(&self, outcome: HandoffOutcome<'_>) {
        if let Some(event) = self
            .state
            .lock()
            .ok()
            .and_then(|mut state| state.handoff.take()?.finish(&outcome))
        {
            posthog_rs::capture(event);
        }
    }

    fn model_call<'a>(&self, source: &'a UsageSource, context_handoff: bool) -> ModelCall<'a> {
        ModelCall {
            provider: source.provider,
            model: &source.model,
            usage: None,
            cost_usd: None,
            finish_reason: None,
            error: None,
            context_handoff,
            provider_fallback: source.provider != self.initial_provider,
        }
    }

    fn event<K: Into<String>>(
        &self,
        name: &str,
        properties: impl IntoIterator<Item = (K, Value)>,
    ) -> posthog_rs::Event {
        let mut event = posthog_rs::Event::new(name, self.user_id.as_str());
        let _ = event.insert_prop("run_id", &self.run_id);
        let _ = event.insert_prop("thread_id", &self.thread_id);
        for (key, value) in properties {
            let _ = event.insert_prop(key, value);
        }
        event
    }

    fn model_call_event(
        &self,
        call: &ModelCall<'_>,
        started_at: Option<Instant>,
    ) -> posthog_rs::Event {
        self.event("model_call", model_call_properties(call, started_at))
    }

    fn capture_tool_call(&self, name: &str, pending: PendingTool, event: &OutcomeEvent<'_>) {
        let properties = [
            ("tool", json!(name)),
            (
                "latency_seconds",
                json!(pending.started_at.elapsed().as_secs_f64()),
            ),
            (
                "is_error",
                json!(event.tool_result().is_none_or(|result| result.is_error())),
            ),
            ("changed_defaults", json!(pending.changed_defaults)),
        ];
        posthog_rs::capture(self.event("tool_called", properties));
    }
}

impl AgentHook for GenerationTracker {
    async fn on_completion_call(
        &self,
        _context: &HookContext,
        event: CompletionCallEvent<'_>,
    ) -> CompletionCallAction {
        if let Ok(mut state) = self.state.lock() {
            state.in_flight_turn = Some(event.turn);
            state.turns.insert(
                event.turn,
                PendingModelCall {
                    started_at: Instant::now(),
                    event: None,
                },
            );
        }
        CompletionCallAction::Continue
    }

    async fn on_model_turn_finished(
        &self,
        _context: &HookContext,
        turn: ModelTurnFinished<'_>,
    ) -> ModelTurnAction {
        let event = self
            .state
            .lock()
            .ok()
            .and_then(|mut state| state.turns.remove(&turn.turn))
            .and_then(|mut pending| pending.event.take());
        if let Some(mut event) = event {
            let tools = tools_called(turn.content);
            if !tools.is_empty() {
                let _ = event.insert_prop("tool_call_count", tools.len());
                let _ = event.insert_prop("tools_called", tools);
            }
            posthog_rs::capture(event);
        }
        ModelTurnAction::Continue
    }

    async fn on_dispatch(
        &self,
        _context: &HookContext,
        event: DispatchEvent<'_>,
    ) -> DispatchAction {
        let Ok(mut state) = self.state.lock() else {
            return DispatchAction::Proceed;
        };
        if let Some(request) = event.completion_request() {
            state.parameter_defaults = parameter_defaults(&request.tools);
        } else if let Some(name) = event.tool_name() {
            let changed_defaults = changed_defaults(
                state.parameter_defaults.get(name),
                event.tool_args().unwrap_or_default(),
            );
            state.tools.insert(
                event.id,
                PendingTool {
                    started_at: Instant::now(),
                    changed_defaults,
                },
            );
        }
        DispatchAction::Proceed
    }

    async fn on_outcome(&self, _context: &HookContext, event: OutcomeEvent<'_>) -> OutcomeAction {
        if let Some(name) = event.tool_name()
            && let Some(pending) = self
                .state
                .lock()
                .ok()
                .and_then(|mut state| state.tools.remove(&event.id))
        {
            self.capture_tool_call(name, pending, &event);
        }
        OutcomeAction::Proceed
    }
}

fn tools_called(content: &[AssistantContent]) -> Vec<&str> {
    content
        .iter()
        .filter_map(|block| match block {
            AssistantContent::ToolCall(call) => Some(&*call.function.name),
            _ => None,
        })
        .collect()
}

fn parameter_defaults(tools: &[Arc<ToolDefinition>]) -> HashMap<String, Map<String, Value>> {
    tools
        .iter()
        .map(|tool| {
            let defaults = tool.parameters["properties"]
                .as_object()
                .into_iter()
                .flatten()
                .filter_map(|(name, schema)| Some((name.clone(), schema.get("default")?.clone())))
                .collect();
            (tool.name.to_string(), defaults)
        })
        .collect()
}

/// Names only, because values such as command input are conversation content.
fn changed_defaults(defaults: Option<&Map<String, Value>>, args: &str) -> Vec<String> {
    let Ok(Value::Object(args)) = serde_json::from_str::<Value>(args) else {
        return Vec::new();
    };
    defaults
        .into_iter()
        .flatten()
        .filter(|(name, default)| args.get(*name).is_some_and(|value| value != *default))
        .map(|(name, _)| name.clone())
        .collect()
}

fn model_call_properties(call: &ModelCall<'_>, started_at: Option<Instant>) -> Map<String, Value> {
    let mut properties = Map::new();
    let mut set = |key: &str, value: Value| {
        if !value.is_null() {
            properties.insert(key.to_string(), value);
        }
    };
    set("model", json!(call.model));
    set("provider", to_json(call.provider));
    if let Some(usage) = call.usage {
        set("input_tokens", json!(usage.input_tokens));
        set("cache_read_tokens", json!(usage.cache_read_tokens));
        set("cache_write_tokens", json!(usage.cache_write_tokens));
        set("output_tokens", json!(usage.output_tokens));
        set("reasoning_tokens", json!(usage.reasoning_tokens));
    }
    set("cost_usd", json!(call.cost_usd));
    set("stop_reason", to_json(call.finish_reason));
    set("is_error", json!(call.error.is_some()));
    set("error", json!(call.error));
    set("provider_fallback", json!(call.provider_fallback));
    set("context_handoff", json!(call.context_handoff));
    if let Some(started_at) = started_at {
        set("latency_seconds", json!(started_at.elapsed().as_secs_f64()));
    }
    properties
}

fn to_json(value: impl Serialize) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}

fn handoff_properties(
    handoff: &PendingHandoff,
    outcome: &HandoffOutcome<'_>,
) -> Map<String, Value> {
    let (outcome_name, error) = match outcome {
        HandoffOutcome::Resumed => ("resumed", None),
        HandoffOutcome::ContinuedWithoutHandoff { reason } => {
            ("continued_without_handoff", Some(reason.to_string()))
        }
        HandoffOutcome::Failed { error } => ("failed", Some(format!("{error:#}"))),
        HandoffOutcome::Cancelled => ("cancelled", None),
    };
    let (provider, model) = handoff.writer.clone().unzip();
    let properties = [
        ("outcome", json!(outcome_name)),
        ("error", json!(error)),
        ("model_calls", json!(handoff.model_calls)),
        ("cost_usd", json!(handoff.cost_usd)),
        (
            "latency_seconds",
            json!(handoff.started_at.elapsed().as_secs_f64()),
        ),
        ("provider", to_json(provider)),
        ("model", json!(model)),
    ];
    properties
        .into_iter()
        .filter(|(_, value)| !value.is_null())
        .map(|(key, value)| (key.to_string(), value))
        .collect()
}

fn is_sprocket_fixable(error: &anyhow::Error) -> bool {
    if let Some(failures) = error
        .chain()
        .find_map(|cause| cause.downcast_ref::<ProviderFailures>())
    {
        return failures.errors().any(is_sprocket_fixable);
    }
    let user_state = matches!(
        convex_error_code(error),
        Some(ConvexErrorCode::UsageLimitReached | ConvexErrorCode::ProviderNotConfigured)
    );
    !user_state
        && !error
            .chain()
            .any(|cause| cause.is::<ChatGptNotConnected>() || is_provider_failure_cause(cause))
}

/// PostHog names an issue after the captured error's static type, which for
/// `dyn Error` is the trait itself, so every run failure would share one name.
#[derive(Debug)]
struct AgentRunFailed<'a>(&'a anyhow::Error);

impl std::fmt::Display for AgentRunFailed<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

impl std::error::Error for AgentRunFailed<'_> {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        AsRef::<dyn std::error::Error>::as_ref(self.0).source()
    }
}

pub(crate) async fn capture_run_failure(error: &anyhow::Error, user_id: &str, run_id: &str) {
    if !is_sprocket_fixable(error) {
        return;
    }
    let Ok(options) = posthog_rs::CaptureExceptionOptions::new()
        .distinct_id(user_id)
        .property("run_id", run_id)
    else {
        return;
    };
    let _ = posthog_rs::capture_exception_with(&AgentRunFailed(error), options).await;
}

#[cfg(test)]
mod tests;
