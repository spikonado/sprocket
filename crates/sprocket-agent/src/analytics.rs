use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use rig::agent::{
    AgentHook, CompletionCallAction, CompletionCallEvent, DispatchAction, DispatchEvent,
    HookContext, ModelTurnAction, ModelTurnFinished, OutcomeAction, OutcomeEvent,
};
use rig::completion::{FinishReason, Message, Usage};
use rig::effect::EffectId;
use rig::message::AssistantContent;
use serde::Serialize;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::types::CompletionProvider;

/// One oversized tool result would otherwise get the whole capture batch rejected.
const MAX_CONTENT_BYTES: usize = 256 * 1024;

/// Joins each model call's input, the provider facts only the provider loop knows, and the
/// call's output into one `$ai_generation` event, and captures each tool run as an `$ai_span`
/// under the generation that called it.
#[derive(Clone)]
pub(crate) struct GenerationTracker {
    // Hashed ids, also the personless distinct id, so generations don't link to the user.
    trace_id: String,
    session_id: String,
    share_content: bool,
    state: Arc<Mutex<TrackerState>>,
}

#[derive(Default)]
struct TrackerState {
    conversation_len: usize,
    turns: HashMap<usize, PendingGeneration>,
    /// Tools run after their model call and before the next one.
    latest_generation_span_id: Option<String>,
    tools: HashMap<EffectId, PendingTool>,
}

struct PendingGeneration {
    span_id: String,
    started_at: Instant,
    input: Option<Value>,
    /// Rig streams a call's usage before the hook that sees its content, so the event waits here.
    event: Option<posthog_rs::Event>,
}

struct PendingTool {
    started_at: Instant,
    parent_id: Option<String>,
}

// Rig skips the content hook for a turn that ends the run or gets abandoned.
impl Drop for PendingGeneration {
    fn drop(&mut self) {
        if let Some(event) = self.event.take() {
            posthog_rs::capture(event);
        }
    }
}

pub(crate) struct GenerationCall<'a> {
    pub(crate) turn: usize,
    pub(crate) provider: CompletionProvider,
    pub(crate) model: &'a str,
    pub(crate) usage: Usage,
    pub(crate) finish_reason: Option<&'a FinishReason>,
    pub(crate) context_handoff: bool,
    pub(crate) provider_fallback: bool,
}

impl GenerationTracker {
    pub(crate) fn new(run_id: &str, thread_id: &str, share_content: bool) -> Self {
        Self {
            trace_id: analytics_id(run_id),
            session_id: analytics_id(thread_id),
            share_content,
            state: Arc::default(),
        }
    }

    pub(crate) fn capture(&self, call: GenerationCall<'_>) {
        let mut state = self.state.lock().ok();
        let mut pending = state
            .as_mut()
            .and_then(|state| state.turns.remove(&call.turn));
        let mut event = posthog_rs::Event::new("$ai_generation", self.trace_id.as_str());
        for (key, value) in
            generation_properties(&self.trace_id, &self.session_id, &call, pending.as_mut())
        {
            let _ = event.insert_prop(key, value);
        }
        match (state, pending) {
            (Some(mut state), Some(mut pending)) => {
                pending.event = Some(event);
                state.turns.insert(call.turn, pending);
            }
            _ => posthog_rs::capture(event),
        }
    }

    fn capture_tool_span(&self, name: &str, pending: PendingTool, event: &OutcomeEvent<'_>) {
        let mut span = posthog_rs::Event::new("$ai_span", self.trace_id.as_str());
        let result = event.tool_result();
        let (input, output) = if self.share_content {
            (
                event.tool_args().map(|args| bounded(tool_arguments(args))),
                result.map(|result| bounded(to_json(result.output()))),
            )
        } else {
            (None, None)
        };
        let properties = [
            ("$ai_trace_id", json!(self.trace_id)),
            ("$ai_session_id", json!(self.session_id)),
            ("$ai_span_name", json!(name)),
            ("$ai_parent_id", json!(pending.parent_id)),
            (
                "$ai_latency",
                json!(pending.started_at.elapsed().as_secs_f64()),
            ),
            (
                "$ai_is_error",
                json!(result.is_none_or(|result| result.is_error())),
            ),
            ("$ai_input_state", json!(input)),
            ("$ai_output_state", json!(output)),
            ("$process_person_profile", json!(false)),
        ];
        for (key, value) in properties {
            if !value.is_null() {
                let _ = span.insert_prop(key, value);
            }
        }
        posthog_rs::capture(span);
    }
}

/// Matches Convex's `analyticsId`, so its run and thread events share these trace and session ids.
fn analytics_id(id: &str) -> String {
    hex::encode(Sha256::digest(id.as_bytes()))
}

impl AgentHook for GenerationTracker {
    async fn on_completion_call(
        &self,
        _context: &HookContext,
        event: CompletionCallEvent<'_>,
    ) -> CompletionCallAction {
        if let Ok(mut state) = self.state.lock() {
            let input = self
                .share_content
                .then(|| bounded(input_delta(event, state.conversation_len)));
            state.conversation_len = event.history.len() + 1;
            let span_id = Uuid::new_v4().to_string();
            state.latest_generation_span_id = Some(span_id.clone());
            state.turns.insert(
                event.turn,
                PendingGeneration {
                    span_id,
                    started_at: Instant::now(),
                    input,
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
                let _ = event.insert_prop("$ai_tools_called", tools.join(","));
                let _ = event.insert_prop("$ai_tool_call_count", tools.len());
            }
            if self.share_content {
                let _ = event.insert_prop(
                    "$ai_output_choices",
                    bounded(json!([{ "role": "assistant", "content": turn.content }])),
                );
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
        if event.tool_name().is_some()
            && let Ok(mut state) = self.state.lock()
        {
            let parent_id = state.latest_generation_span_id.clone();
            state.tools.insert(
                event.id,
                PendingTool {
                    started_at: Instant::now(),
                    parent_id,
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
            self.capture_tool_span(name, pending, &event);
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

fn tool_arguments(args: &str) -> Value {
    serde_json::from_str(args).unwrap_or_else(|_| json!(args))
}

/// The messages added since the previous call, without the previous call's own output.
/// A run's first call sends only its prompt.
fn input_delta(event: CompletionCallEvent<'_>, previous_len: usize) -> Value {
    let added = if event.turn == 1 || previous_len > event.history.len() {
        &[][..]
    } else {
        &event.history[previous_len..]
    };
    let messages: Vec<&Message> = added
        .iter()
        .map(|message| &**message)
        .filter(|message| !matches!(message, Message::Assistant(_)))
        .chain([event.prompt])
        .collect();
    serde_json::to_value(messages).unwrap_or(Value::Null)
}

fn bounded(content: Value) -> Value {
    let size = content.to_string().len();
    if size > MAX_CONTENT_BYTES {
        Value::String(format!("[{size} bytes omitted]"))
    } else {
        content
    }
}

fn generation_properties(
    trace_id: &str,
    session_id: &str,
    call: &GenerationCall<'_>,
    pending: Option<&mut PendingGeneration>,
) -> Map<String, Value> {
    let mut properties = Map::new();
    let mut set = |key: &str, value: Value| {
        if !value.is_null() {
            properties.insert(key.to_string(), value);
        }
    };
    set("$ai_trace_id", json!(trace_id));
    set("$ai_session_id", json!(session_id));
    set("$ai_model", json!(call.model));
    set("$ai_provider", to_json(call.provider));
    set("$ai_stream", json!(true));
    set("$ai_input_tokens", json!(call.usage.input_tokens));
    set("$ai_output_tokens", json!(call.usage.output_tokens));
    set(
        "$ai_cache_read_input_tokens",
        json!(call.usage.cached_input_tokens),
    );
    set(
        "$ai_cache_creation_input_tokens",
        json!(call.usage.cache_creation_input_tokens),
    );
    set("$ai_reasoning_tokens", json!(call.usage.reasoning_tokens));
    set("$ai_stop_reason", to_json(call.finish_reason));
    set("$process_person_profile", json!(false));
    set("provider_fallback", json!(call.provider_fallback));
    if call.context_handoff {
        set("$ai_span_name", json!("context_handoff"));
    }
    if let Some(pending) = pending {
        set("$ai_span_id", json!(pending.span_id));
        set(
            "$ai_latency",
            json!(pending.started_at.elapsed().as_secs_f64()),
        );
        set("$ai_input", pending.input.take().unwrap_or(Value::Null));
    }
    properties
}

fn to_json(value: impl Serialize) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}

/// Run failures carry the user so PostHog groups them with that person's errors.
pub(crate) async fn capture_run_failure(error: &anyhow::Error, user_id: &str, run_id: &str) {
    let source: &(dyn std::error::Error + Send + Sync + 'static) = error.as_ref();
    let Ok(options) = posthog_rs::CaptureExceptionOptions::new()
        .distinct_id(user_id)
        .property("run_id", run_id)
    else {
        return;
    };
    // Errors only mean analytics is off.
    let _ = posthog_rs::capture_exception_with(source, options).await;
}

#[cfg(test)]
mod tests;
