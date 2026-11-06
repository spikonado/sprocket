use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use rig::agent::{
    AgentHook, CompletionCallAction, CompletionCallEvent, HookContext, InvalidToolCallAction,
    InvalidToolCallContext, ModelTurnAction, ModelTurnFinished, StepEventKind,
};
use rig::completion::{Message, Usage};
use rig::message::AssistantContent;

pub(crate) const HANDOFF_PROMPT: &str = "Your context is filled up; reply with only a handoff document summarising the current conversation so a fresh agent can continue the work. Do not call any tools. Don't talk about the handoff document itself. Include the user's last request, your decisions and the reasoning behind them, and a summary of the work you have completed. Do not duplicate content already captured in other artifacts (specs, plans, issues, commits, diffs). Reference them by path or URL instead. Redact any sensitive information, such as API keys, passwords, or personally identifiable information.";
pub(crate) const HANDOFF_SUBMITTED: &str = "SPROCKET_CONTEXT_HANDOFF_SUBMITTED";
const HANDOFF_REQUESTED: &str = "SPROCKET_CONTEXT_HANDOFF_REQUESTED";
const MAX_DOCUMENT_BYTES: usize = 256_000;
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
enum HandoffPhase {
    #[default]
    Idle,
    Requested(Vec<Message>),
    Writing,
    Written(String),
}

impl HandoffPhase {
    fn is_writing(&self) -> bool {
        matches!(self, Self::Writing | Self::Written(_))
    }
}

#[derive(Default)]
struct HandoffState {
    context_tokens: u64,
    phase: HandoffPhase,
    calls: usize,
}

impl HandoffState {
    fn due(&self, limit: u64) -> bool {
        self.context_tokens >= limit && self.context_tokens > 0
    }

    fn prepare(&mut self, event: CompletionCallEvent<'_>, limit: u64) -> CompletionCallAction {
        if self.phase.is_writing() || !self.due(limit) {
            return CompletionCallAction::Continue;
        }
        let history = event.history.iter().map(|message| &**message);
        let history = history.chain([event.prompt]).cloned().collect();
        self.phase = HandoffPhase::Requested(history);
        CompletionCallAction::stop(HANDOFF_REQUESTED)
    }

    fn finish_turn(&mut self, event: &ModelTurnFinished<'_>) -> ModelTurnAction {
        if !self.phase.is_writing() {
            return ModelTurnAction::Continue;
        }
        match handoff_document(event) {
            Ok(document) => {
                self.phase = HandoffPhase::Written(document);
                ModelTurnAction::stop(HANDOFF_SUBMITTED)
            }
            Err(reason) => ModelTurnAction::stop(reason),
        }
    }
}

fn handoff_document(event: &ModelTurnFinished<'_>) -> Result<String, &'static str> {
    if event
        .finish_reason
        .is_some_and(|reason| reason.truncated_output())
    {
        return Err("Context handoff failed: the handoff document was cut off.");
    }
    let mut document = String::new();
    for content in event.content {
        match content {
            AssistantContent::Text(text) => document.push_str(&text.text),
            AssistantContent::ToolCall(_) => {
                return Err(
                    "Context handoff failed: the agent called a tool instead of replying with the handoff document.",
                );
            }
            _ => {}
        }
    }
    if document.trim().is_empty() || document.len() > MAX_DOCUMENT_BYTES {
        return Err("Context handoff failed: the handoff document must contain 1 to 256000 bytes.");
    }
    Ok(document)
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

    /// Every update is one assignment, so a poisoned state is still consistent.
    fn state(&self) -> MutexGuard<'_, HandoffState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub(crate) fn handoff_due(&self) -> bool {
        self.state().due(self.token_limit)
    }

    pub(crate) fn take_handoff_history(&self) -> Option<Vec<Message>> {
        let mut state = self.state();
        match std::mem::take(&mut state.phase) {
            HandoffPhase::Requested(history) => Some(history),
            phase => {
                state.phase = phase;
                None
            }
        }
    }

    pub(crate) fn start_handoff(&self) {
        self.state().phase = HandoffPhase::Writing;
    }

    pub(crate) fn is_writing(&self) -> bool {
        self.state().phase.is_writing()
    }

    pub(crate) fn take_summary(&self) -> Option<String> {
        let mut state = self.state();
        match std::mem::take(&mut state.phase) {
            HandoffPhase::Written(summary) => {
                state.phase = HandoffPhase::Writing;
                Some(summary)
            }
            phase => {
                state.phase = phase;
                None
            }
        }
    }

    pub(crate) fn completion_calls(&self) -> usize {
        self.state().calls
    }

    pub(crate) fn restart(&self) {
        let mut state = self.state();
        let calls = state.calls;
        *state = HandoffState {
            calls,
            ..Default::default()
        };
    }

    pub(crate) fn record_usage(&self, usage: Usage) -> Option<u64> {
        let tokens = context_tokens(usage);
        if let Some(tokens) = tokens {
            self.state().context_tokens = tokens;
        }
        tokens
    }
}

impl AgentHook for ContextHandoffHook {
    async fn on_invalid_tool_call(
        &self,
        _context: &HookContext,
        _event: &InvalidToolCallContext,
    ) -> Option<InvalidToolCallAction> {
        // A repaired call skips on_model_turn_finished, which rejects handoff tool calls.
        self.is_writing().then(InvalidToolCallAction::fail)
    }

    async fn on_completion_call(
        &self,
        _context: &HookContext,
        event: CompletionCallEvent<'_>,
    ) -> CompletionCallAction {
        let mut state = self.state();
        if state.calls >= MAX_COMPLETION_CALLS {
            return CompletionCallAction::stop("The agent reached its completion call limit.");
        }
        let action = state.prepare(event, self.token_limit);
        if !matches!(action, CompletionCallAction::Stop(_)) {
            state.calls += 1;
        }
        action
    }

    async fn on_model_turn_finished(
        &self,
        _context: &HookContext,
        event: ModelTurnFinished<'_>,
    ) -> ModelTurnAction {
        self.state().finish_turn(&event)
    }

    fn observes(&self, kind: StepEventKind) -> bool {
        matches!(
            kind,
            StepEventKind::CompletionCall
                | StepEventKind::ModelTurnFinished
                | StepEventKind::InvalidToolCall
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

#[cfg(test)]
mod integration_tests;

#[cfg(test)]
mod tests;
