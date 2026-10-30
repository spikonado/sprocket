use std::sync::{Arc, Mutex};

use rig::agent::{
    AgentHook, CompletionCallAction, CompletionCallEvent, HookContext, InvalidToolCallAction,
    InvalidToolCallContext, ModelTurnAction, ModelTurnFinished, ObservationAction, OutcomeAction,
    OutcomeEvent, StepEventKind, ToolCallDelta,
};
use rig::completion::{Message, Usage};
use rig::message::AssistantContent;
use rig::tool::{Tool, ToolExecutionError};
use schemars::JsonSchema;
use serde::Deserialize;

pub(crate) const HANDOFF_PROMPT: &str = "Your context is filled up; write a handoff document (to the `handoff_context` tool) summarising the current conversation so a fresh agent can continue the work. Don't talk about the handoff document itself. Include the user's last request, your decisions and the reasoning behind them, and a summary of the work you have completed. Do not duplicate content already captured in other artifacts (specs, plans, issues, commits, diffs). Reference them by path or URL instead. Redact any sensitive information, such as API keys, passwords, or personally identifiable information.";
pub(crate) const HANDOFF_SUBMITTED: &str = "SPROCKET_CONTEXT_HANDOFF_SUBMITTED";
const HANDOFF_REQUESTED: &str = "SPROCKET_CONTEXT_HANDOFF_REQUESTED";
const MAX_COMPLETION_CALLS: usize = 1_000;

/// User role because the handoff can follow an assistant reply, and Anthropic
/// models reject requests that end on an assistant turn once developer
/// messages are folded into the system prompt.
pub(crate) fn handoff_prompt() -> Message {
    Message::user(HANDOFF_PROMPT)
}

pub(crate) fn context_summary_text(summary: &str) -> String {
    format!(
        "A handoff document was created automatically from the conversation context.\n\n<handoff_document>\n{summary}\n</handoff_document>"
    )
}

#[derive(Default)]
struct HandoffState {
    context_tokens: u64,
    /// The history the handoff summarizes, set once one is due.
    handoff_history: Option<Vec<Message>>,
    writing: bool,
    summary: Option<String>,
    calls: usize,
}

impl HandoffState {
    fn due(&self, limit: u64) -> bool {
        self.context_tokens >= limit && self.context_tokens > 0
    }

    fn prepare(&mut self, event: CompletionCallEvent<'_>, limit: u64) -> CompletionCallAction {
        if self.writing || !self.due(limit) {
            return CompletionCallAction::Continue;
        }
        let history = event.history.iter().map(|message| &**message);
        let history = history.chain([event.prompt]).cloned().collect();
        self.handoff_history = Some(history);
        CompletionCallAction::stop(HANDOFF_REQUESTED)
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
    pub(crate) fn new(token_limit: u64, context_tokens: u64) -> Self {
        Self {
            token_limit,
            state: Arc::new(Mutex::new(HandoffState {
                context_tokens,
                ..Default::default()
            })),
        }
    }

    /// The last reported context already reaches the handoff limit.
    pub(crate) fn handoff_due(&self) -> bool {
        self.state
            .lock()
            .is_ok_and(|state| state.due(self.token_limit))
    }

    pub(crate) fn tool(&self) -> HandoffTool {
        HandoffTool {
            state: self.state.clone(),
        }
    }

    pub(crate) fn take_handoff_history(&self) -> Option<Vec<Message>> {
        self.state.lock().ok()?.handoff_history.take()
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
    async fn on_outcome(&self, _context: &HookContext, event: OutcomeEvent<'_>) -> OutcomeAction {
        if event.tool_name() == Some(HandoffTool::NAME)
            && self
                .state
                .lock()
                .is_ok_and(|state| state.writing && state.summary.is_some())
        {
            return OutcomeAction::stop(HANDOFF_SUBMITTED);
        }
        OutcomeAction::Proceed
    }

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
        event: &InvalidToolCallContext,
    ) -> Option<InvalidToolCallAction> {
        // Rig skips delta and turn validation after name repair.
        (self.is_writing()
            || event.tool_name == HandoffTool::NAME
            || matches!(
                crate::hooks::resolve_invalid_tool_call(event),
                InvalidToolCallAction::Repair { tool_name } if tool_name == HandoffTool::NAME
            ))
        .then(InvalidToolCallAction::fail)
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
        let mut calls = event.content.iter().filter_map(|content| match content {
            AssistantContent::ToolCall(call) => Some(call),
            _ => None,
        });
        if self.is_writing() {
            if event
                .finish_reason
                .is_some_and(|reason| reason.truncated_output())
                || !calls
                    .next()
                    .is_some_and(|call| call.function.name == HandoffTool::NAME)
                || calls.next().is_some()
            {
                return ModelTurnAction::stop(
                    "Context handoff failed: the agent must submit one complete handoff document.",
                );
            }
        } else if calls.any(|call| call.function.name == HandoffTool::NAME) {
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
                | StepEventKind::ToolDispatch
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
mod integration_tests;

#[cfg(test)]
mod tests;
