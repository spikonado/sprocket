use std::sync::{Arc, Mutex};

use crate::hooks::AGENT_TOOL_NAMES;
use rig::agent::{
    AgentHook, CompletionCallAction, CompletionCallEvent, HookContext, ModelTurnAction,
    ModelTurnFinished, RequestPatch, StepEventKind,
};
use rig::completion::{Message, Usage};
use rig::message::{AssistantContent, ToolChoice};
use rig::tool::{Tool, ToolExecutionError};
use schemars::JsonSchema;
use serde::Deserialize;

pub(crate) const HANDOFF_PROMPT: &str = "Your context is filled up; write a handoff document (to the `handoff_context` tool) summarising the current conversation so a fresh agent can continue the work. Do not duplicate content already captured in other artifacts (specs, plans, issues, commits, diffs). Reference them by path or URL instead. Redact any sensitive information, such as API keys, passwords, or personally identifiable information.";
const HANDOFF_REQUESTED: &str = "SPROCKET_CONTEXT_HANDOFF_REQUESTED";
const MAX_COMPLETION_CALLS: usize = 1_000;

pub(crate) fn context_summary_text(summary: &str) -> String {
    format!(
        "The conversation context was automatically compacted. Treat this summary as authoritative, continue the current task from this state, and do not redo completed work.\n\n<conversation_summary>\n{summary}\n</conversation_summary>"
    )
}

pub(crate) struct HandoffRequest {
    pub(crate) history: Vec<Message>,
    pub(crate) deferred_prompt: Option<Message>,
    pub(crate) before_prompt: bool,
}

#[derive(Default)]
struct CompactionState {
    context_tokens: u64,
    first_call: bool,
    defer_prompt: bool,
    request: Option<HandoffRequest>,
    writing: bool,
    summary: Option<String>,
    calls: usize,
}

impl CompactionState {
    fn prepare(&mut self, event: CompletionCallEvent<'_>, limit: u64) -> CompletionCallAction {
        if self.writing {
            return CompletionCallAction::patch(
                RequestPatch::new()
                    .active_tools([HandoffTool::NAME])
                    .tool_choice(ToolChoice::Required),
            );
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
        CompletionCallAction::patch(
            RequestPatch::new().active_tools(AGENT_TOOL_NAMES.iter().copied()),
        )
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
pub(crate) struct ContextCompactionHook {
    token_limit: u64,
    state: Arc<Mutex<CompactionState>>,
}

impl ContextCompactionHook {
    pub(crate) fn new(token_limit: u64, context_tokens: u64, defer_prompt: bool) -> Self {
        Self {
            token_limit,
            state: Arc::new(Mutex::new(CompactionState {
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
            *state = CompactionState {
                calls,
                ..Default::default()
            };
        }
    }

    pub(crate) fn record_usage(&self, usage: Usage) -> u64 {
        let tokens = context_tokens(usage);
        if tokens > 0
            && let Ok(mut state) = self.state.lock()
        {
            state.context_tokens = tokens;
        }
        tokens
    }
}

impl AgentHook for ContextCompactionHook {
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
        if self.is_writing() {
            let calls: Vec<_> = event
                .content
                .iter()
                .filter_map(|content| match content {
                    AssistantContent::ToolCall(call) => Some(call),
                    _ => None,
                })
                .collect();
            if event
                .finish_reason
                .is_some_and(|reason| reason.truncated_output())
                || calls.len() != 1
                || calls[0].function.name != HandoffTool::NAME
            {
                return ModelTurnAction::stop(
                    "Context handoff failed: the agent must submit one complete handoff document.",
                );
            }
        }
        ModelTurnAction::Continue
    }

    fn observes(&self, kind: StepEventKind) -> bool {
        matches!(
            kind,
            StepEventKind::CompletionCall | StepEventKind::ModelTurnFinished
        )
    }
}

// Responses input_tokens includes cached input; output_tokens includes reasoning.
fn context_tokens(usage: Usage) -> u64 {
    usage.input_tokens.saturating_add(usage.output_tokens)
}

#[derive(Clone)]
pub(crate) struct HandoffTool {
    state: Arc<Mutex<CompactionState>>,
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
        "Submit the handoff document for a fresh agent to continue this conversation.".to_string()
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
#[path = "compaction_integration_tests.rs"]
mod integration_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_provider_totals_without_counting_cache_or_reasoning_twice() {
        assert_eq!(
            context_tokens(Usage {
                input_tokens: 100,
                output_tokens: 30,
                cached_input_tokens: 80,
                reasoning_tokens: 20,
                ..Default::default()
            }),
            130
        );
    }

    #[test]
    fn missing_usage_preserves_the_last_observation_until_restart() {
        let hook = ContextCompactionHook::new(100, 120, true);
        assert_eq!(hook.record_usage(Usage::default()), 0);
        assert_eq!(hook.state.lock().unwrap().context_tokens, 120);
        hook.restart();
        assert_eq!(hook.state.lock().unwrap().context_tokens, 0);
    }

    #[test]
    fn defers_the_new_prompt_without_putting_it_in_the_handoff_history() {
        let history = vec![Message::user("old work")];
        let prompt = Message::user("new task");
        let mut state = CompactionState {
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
                100
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
        let mut state = CompactionState {
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
        let mut state = CompactionState::default();
        assert!(matches!(
            state.prepare(
                CompletionCallEvent {
                    history: &history,
                    prompt: &prompt,
                    turn: 1
                },
                100
            ),
            CompletionCallAction::Patch(_)
        ));
        assert!(state.request.is_none());
    }

    #[test]
    fn handoff_submission_requires_a_pending_request_and_nonempty_document() {
        let mut state = CompactionState::default();
        assert!(state.submit("handoff".into()).is_err());
        state.writing = true;
        assert!(state.submit("  ".into()).is_err());
        assert!(state.submit("handoff".into()).is_ok());
        assert!(state.submit("duplicate".into()).is_err());
        assert_eq!(state.summary.as_deref(), Some("handoff"));
    }
}
