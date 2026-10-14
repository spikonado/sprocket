use std::sync::{Arc, Mutex};
use std::time::Duration;

use rig::ProviderError;
use rig::agent::{
    AgentHook, CompletionCallAction, CompletionCallEvent, HookContext, StepEventKind,
};
use rig::completion::{Message, PromptError};

const MAX_STREAM_RECOVERIES: u32 = 3;

#[derive(Clone, Default)]
pub(crate) struct StreamRecovery {
    input: Arc<Mutex<Option<(Vec<Message>, Message)>>>,
    recoveries: u32,
}

impl StreamRecovery {
    pub(crate) fn resume(
        &mut self,
        error: &PromptError,
    ) -> Option<(Vec<Message>, Message, Duration)> {
        let truncated = match error {
            PromptError::Provider(ProviderError::Truncated) => true,
            PromptError::Report(report) => {
                // Rig's effect bus replaces the typed error with its report.
                let expected = ProviderError::Truncated.report();
                report.kind == expected.kind
                    && report.retryable
                    && report.message == expected.message
            }
            _ => false,
        };
        if !truncated || self.recoveries >= MAX_STREAM_RECOVERIES {
            return None;
        }
        let (history, prompt) = self.input.lock().ok()?.take()?;
        let delay = Duration::from_secs(1 << self.recoveries);
        self.recoveries += 1;
        Some((history, prompt, delay))
    }
}

impl AgentHook for StreamRecovery {
    fn observes(&self, kind: StepEventKind) -> bool {
        kind == StepEventKind::CompletionCall
    }

    async fn on_completion_call(
        &self,
        _context: &HookContext,
        event: CompletionCallEvent<'_>,
    ) -> CompletionCallAction {
        match self.input.lock() {
            Ok(mut input) => {
                // The next call's input includes committed tool results, not partial output.
                *input = Some((event.history.to_vec(), event.prompt.clone()));
                CompletionCallAction::Continue
            }
            Err(_) => CompletionCallAction::stop("Stream recovery state is unavailable."),
        }
    }
}

#[cfg(test)]
mod tests;
