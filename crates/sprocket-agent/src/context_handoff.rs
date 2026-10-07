use std::sync::{Arc, Mutex};

use rig::agent::{
    AgentHook, CompletionCallAction, CompletionCallEvent, HookContext, InvalidToolCallAction,
    InvalidToolCallContext, ModelTurnAction, ModelTurnFinished, ObservationAction, StepEventKind,
    ToolCallDelta,
};
use rig::completion::{Message, Usage};
use rig::message::AssistantContent;
use rig::tool::{Tool, ToolExecutionError};
use schemars::JsonSchema;
use serde::Deserialize;

pub(crate) const HANDOFF_PROMPT: &str = "Your context is filled up; write a handoff document (to the `handoff_context` tool) summarising the current conversation so a fresh agent can continue the work. Don't talk about the handoff document itself. Include the user's last request, your decisions and the reasoning behind them, and a summary of the work you have completed. Do not duplicate content already captured in other artifacts (specs, plans, issues, commits, diffs). Reference them by path or URL instead. Redact any sensitive information, such as API keys, passwords, or personally identifiable information.";
const HANDOFF_REQUESTED: &str = "SPROCKET_CONTEXT_HANDOFF_REQUESTED";
const MAX_COMPLETION_CALLS: usize = 1_000;

pub(crate) fn context_summary_text(summary: &str) -> String {
    format!(
        "A handoff document was created automatically from the conversation context. Treat this document as authoritative, continue the current task from this state, and do not redo completed work.\n\n<handoff_document>\n{summary}\n</handoff_document>"
    )
}

pub(crate) struct HandoffRequest {
    pub(crate) history: Vec<Message>,
    pub(crate) deferred_prompt: Option<Message>,
    pub(crate) before_prompt: bool,
}

#[derive(Default)]
struct HandoffState {
    context_tokens: u64,
    first_call: bool,
    defer_prompt: bool,
    request: Option<HandoffRequest>,
    writing: bool,
    summary: Option<String>,
    calls: usize,
}

impl HandoffState {
    fn prepare(&mut self, event: CompletionCallEvent<'_>, limit: u64) -> CompletionCallAction {
        if self.writing {
            return CompletionCallAction::Continue;
        }
        if self.context_tokens >= limit && self.context_tokens > 0 {
            let before_prompt = self.first_call && self.defer_prompt;
            let mut history = event.history.to_vec();
            let deferred_prompt = if before_prompt {
                Some(event.prompt.clone())
            } else {
                history.push(event.prompt.clone());
                None
            };
            self.request = Some(HandoffRequest {
                history,
                deferred_prompt,
                before_prompt,
            });
            return CompletionCallAction::stop(HANDOFF_REQUESTED);
        }
        self.first_call = false;
        CompletionCallAction::Continue
    }

    fn submit(&mut self, document: String) -> Result<(), ToolExecutionError> {
        if !self.writing || self.summary.is_some() {
            return Err(ToolExecutionError::other("No context handoff is pending."));
        }
        if document.trim().is_empty() || document.len() > 256_000 {
            return Err(ToolExecutionError::other(
                "The handoff document must contain 1 to 256000 bytes.",
            ));
        }
        self.summary = Some(document);
        Ok(())
    }
}

#[derive(Clone)]
pub(crate) struct ContextHandoffHook {
    token_limit: u64,
    state: Arc<Mutex<HandoffState>>,
}

impl ContextHandoffHook {
    pub(crate) fn new(token_limit: u64, context_tokens: u64, defer_prompt: bool) -> Self {
        Self {
            token_limit,
            state: Arc::new(Mutex::new(HandoffState {
                context_tokens,
                first_call: true,
                defer_prompt,
                ..Default::default()
            })),
        }
    }

    pub(crate) fn tool(&self) -> HandoffTool {
        HandoffTool {
            state: self.state.clone(),
        }
    }

    pub(crate) fn take_request(&self) -> Option<HandoffRequest> {
        self.state.lock().ok()?.request.take()
    }

    pub(crate) fn start_handoff(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.writing = true;
        }
    }

    pub(crate) fn is_writing(&self) -> bool {
        self.state.lock().map(|state| state.writing).unwrap_or(true)
    }

    pub(crate) fn take_summary(&self) -> Option<String> {
        self.state.lock().ok()?.summary.take()
    }

    pub(crate) fn completion_calls(&self) -> usize {
        self.state.lock().map(|state| state.calls).unwrap_or(0)
    }

    pub(crate) fn restart(&self) {
        if let Ok(mut state) = self.state.lock() {
            let calls = state.calls;
            *state = HandoffState {
                calls,
                ..Default::default()
            };
        }
    }

    pub(crate) fn record_usage(&self, usage: Usage) -> Option<u64> {
        let tokens = context_tokens(usage);
        if let Some(tokens) = tokens
            && let Ok(mut state) = self.state.lock()
        {
            state.context_tokens = tokens;
        }
        tokens
    }
}

impl AgentHook for ContextHandoffHook {
    async fn on_tool_call_delta(
        &self,
        _context: &HookContext,
        event: ToolCallDelta<'_>,
    ) -> ObservationAction {
        if event.tool_name == HandoffTool::NAME && !self.is_writing() {
            return ObservationAction::stop("No context handoff is pending.");
        }
        ObservationAction::Continue
    }

    async fn on_invalid_tool_call(
        &self,
        _context: &HookContext,
        _event: &InvalidToolCallContext,
    ) -> Option<InvalidToolCallAction> {
        // Rig skips turn validation after name repair. Handoffs must not take that path.
        self.is_writing().then(InvalidToolCallAction::fail)
    }

    async fn on_completion_call(
        &self,
        _context: &HookContext,
        event: CompletionCallEvent<'_>,
    ) -> CompletionCallAction {
        match self.state.lock() {
            Ok(mut state) => {
                if state.calls >= MAX_COMPLETION_CALLS {
                    return CompletionCallAction::stop(
                        "The agent reached its completion call limit.",
                    );
                }
                let action = state.prepare(event, self.token_limit);
                if !matches!(action, CompletionCallAction::Stop(_)) {
                    state.calls += 1;
                }
                action
            }
            Err(_) => CompletionCallAction::stop("Context handoff state is unavailable."),
        }
    }

    async fn on_model_turn_finished(
        &self,
        _context: &HookContext,
        event: ModelTurnFinished<'_>,
    ) -> ModelTurnAction {
        let calls: Vec<_> = event
            .content
            .iter()
            .filter_map(|content| match content {
                AssistantContent::ToolCall(call) => Some(call),
                _ => None,
            })
            .collect();
        if self.is_writing() {
            if event
                .finish_reason
                .is_some_and(|reason| reason.truncated_output())
                || calls.len() != 1
                || calls[0].function.name.as_str() != HandoffTool::NAME
            {
                return ModelTurnAction::stop(
                    "Context handoff failed: the agent must submit one complete handoff document.",
                );
            }
        } else if calls
            .iter()
            .any(|call| call.function.name.as_str() == HandoffTool::NAME)
        {
            return ModelTurnAction::stop("No context handoff is pending.");
        }
        ModelTurnAction::Continue
    }

    fn observes(&self, kind: StepEventKind) -> bool {
        matches!(
            kind,
            StepEventKind::CompletionCall
                | StepEventKind::ModelTurnFinished
                | StepEventKind::InvalidToolCall
                | StepEventKind::ToolCallDelta
        )
    }
}

// Responses API input_tokens includes cached input; output_tokens includes reasoning.
fn context_tokens(usage: Usage) -> Option<u64> {
    usage.total_tokens.or_else(|| {
        usage
            .input_tokens
            .zip(usage.output_tokens)
            .map(|(input, output)| input.saturating_add(output))
    })
}

#[derive(Clone)]
pub(crate) struct HandoffTool {
    state: Arc<Mutex<HandoffState>>,
}

#[derive(Deserialize, JsonSchema)]
pub(crate) struct HandoffArgs {
    /// Handoff document for the next agent. Reference existing artifacts and redact secrets and PII.
    document: String,
}

impl Tool for HandoffTool {
    const NAME: &'static str = "handoff_context";
    type Error = ToolExecutionError;
    type Args = HandoffArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        "Submit the handoff document for a fresh agent to continue this conversation. Only use this tool when explicitly asked to write a context handoff document; never initiate a handoff yourself.".to_string()
    }

    fn parameters(&self) -> serde_json::Value {
        serde_json::json!(schemars::schema_for!(HandoffArgs))
    }

    async fn call(
        &self,
        _context: &mut rig::tool::ToolContext,
        args: HandoffArgs,
    ) -> Result<Self::Output, Self::Error> {
        self.state
            .lock()
            .map_err(|_| ToolExecutionError::other("Context handoff state is unavailable."))?
            .submit(args.document)?;
        Ok(serde_json::json!({ "accepted": true }))
    }
}

#[cfg(test)]
#[path = "context_handoff_integration_tests.rs"]
mod integration_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_provider_totals_without_counting_cache_or_reasoning_twice() {
        assert_eq!(
            context_tokens(Usage {
                input_tokens: Some(100),
                output_tokens: Some(30),
                cached_input_tokens: Some(80),
                reasoning_tokens: Some(20),
                ..Default::default()
            }),
            Some(130)
        );
    }

    #[test]
    fn missing_usage_preserves_the_last_observation_until_restart() {
        let hook = ContextHandoffHook::new(100, 120, true);
        assert_eq!(hook.record_usage(Usage::default()), None);
        assert_eq!(hook.state.lock().unwrap().context_tokens, 120);
        hook.restart();
        assert_eq!(hook.state.lock().unwrap().context_tokens, 0);
    }

    #[test]
    fn partial_usage_preserves_context_without_persisting_an_incomplete_total() {
        let hook = ContextHandoffHook::new(100, 120, true);
        assert_eq!(
            hook.record_usage(Usage {
                output_tokens: Some(30),
                ..Default::default()
            }),
            None
        );
        assert_eq!(hook.state.lock().unwrap().context_tokens, 120);
    }

    #[test]
    fn reported_total_updates_context_without_individual_counters() {
        let hook = ContextHandoffHook::new(100, 120, true);
        assert_eq!(
            hook.record_usage(Usage {
                total_tokens: Some(150),
                ..Default::default()
            }),
            Some(150)
        );
        assert_eq!(hook.state.lock().unwrap().context_tokens, 150);
    }

    #[test]
    fn reported_zero_replaces_the_last_context_observation() {
        let hook = ContextHandoffHook::new(100, 120, true);
        assert_eq!(
            hook.record_usage(Usage {
                input_tokens: Some(0),
                output_tokens: Some(0),
                ..Default::default()
            }),
            Some(0)
        );
        assert_eq!(hook.state.lock().unwrap().context_tokens, 0);
    }

    #[test]
    fn defers_the_new_prompt_without_putting_it_in_the_handoff_history() {
        let history = vec![Message::user("old work")];
        let prompt = Message::user("new task");
        let mut state = HandoffState {
            context_tokens: 100,
            first_call: true,
            defer_prompt: true,
            ..Default::default()
        };
        assert!(matches!(
            state.prepare(
                CompletionCallEvent {
                    history: &history,
                    prompt: &prompt,
                    turn: 1
                },
                100,
            ),
            CompletionCallAction::Stop(_)
        ));
        let request = state.request.unwrap();
        assert_eq!(request.history, history);
        assert_eq!(request.deferred_prompt, Some(prompt));
        assert!(request.before_prompt);
    }

    #[test]
    fn mid_run_handoff_includes_the_pending_tool_result() {
        let history = vec![Message::user("old work")];
        let prompt = Message::user("tool result");
        let mut state = HandoffState {
            context_tokens: 100,
            ..Default::default()
        };
        state.prepare(
            CompletionCallEvent {
                history: &history,
                prompt: &prompt,
                turn: 2,
            },
            100,
        );
        let request = state.request.unwrap();
        assert_eq!(request.history, vec![history[0].clone(), prompt]);
        assert!(request.deferred_prompt.is_none());
        assert!(!request.before_prompt);
    }

    #[test]
    fn does_not_estimate_tokens_from_large_messages() {
        let history = vec![Message::user("x".repeat(100_000))];
        let prompt = Message::user("next");
        let mut state = HandoffState::default();
        assert!(matches!(
            state.prepare(
                CompletionCallEvent {
                    history: &history,
                    prompt: &prompt,
                    turn: 1
                },
                100,
            ),
            CompletionCallAction::Continue
        ));
        assert!(state.request.is_none());
    }

    #[test]
    fn handoff_submission_requires_a_pending_request_and_nonempty_document() {
        let mut state = HandoffState::default();
        assert!(state.submit("handoff".into()).is_err());
        state.writing = true;
        assert!(state.submit("  ".into()).is_err());
        assert!(state.submit("handoff".into()).is_ok());
        assert!(state.submit("duplicate".into()).is_err());
        assert_eq!(state.summary.as_deref(), Some("handoff"));
    }
}
