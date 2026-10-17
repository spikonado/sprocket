use std::sync::{Arc, Mutex};
use std::time::Duration;

use rig::ProviderError;
use rig::agent::{
    AgentHook, CompletionCallAction, CompletionCallEvent, HookContext, StepEventKind,
};
use rig::completion::{Message, PromptError};
use rig::error::ErrorKind;

const MAX_STREAM_RECOVERIES: u32 = 3;
/// Each timed-out attempt already streamed for the gateway's full duration cap.
const MAX_STREAM_TIMEOUT_RECOVERIES: u32 = 1;
const GATEWAY_STREAM_TIMEOUT_CODE: &str = "gateway_stream_timeout";

#[derive(Clone, Default)]
pub(crate) struct StreamRecovery {
    input: Arc<Mutex<Option<(Vec<Message>, Message)>>>,
    recoveries: u32,
    timeout_recoveries: u32,
}

fn is_truncation(error: &PromptError) -> bool {
    match error {
        PromptError::Provider(ProviderError::Truncated) => true,
        PromptError::Report(report) => {
            // Rig's effect bus replaces the typed error with its report.
            let expected = ProviderError::Truncated.report();
            report.kind == expected.kind && report.retryable && report.message == expected.message
        }
        _ => false,
    }
}

fn is_gateway_stream_timeout(error: &PromptError) -> bool {
    let body = match error {
        PromptError::Provider(error) => error.provider_response_json(),
        PromptError::Report(report) => report.provider_response_json(),
        _ => return false,
    };
    body.ok().flatten().is_some_and(|body| {
        body.pointer("/response/error/code")
            .and_then(serde_json::Value::as_str)
            == Some(GATEWAY_STREAM_TIMEOUT_CODE)
    })
}

/// Failures another provider may not have.
pub(crate) fn is_provider_failure(error: &PromptError) -> bool {
    match error {
        PromptError::Provider(_) => true,
        PromptError::Report(report) => matches!(
            report.kind,
            ErrorKind::Http
                | ErrorKind::Request
                | ErrorKind::Response
                | ErrorKind::Provider
                | ErrorKind::ProviderResponse
                | ErrorKind::Timeout
        ),
        _ => false,
    }
}

impl StreamRecovery {
    /// The failed call's input, to replay it on another provider.
    pub(crate) fn take_input(&self) -> Option<(Vec<Message>, Message)> {
        self.input.lock().ok()?.take()
    }

    pub(crate) fn resume(
        &mut self,
        error: &PromptError,
    ) -> Option<(Vec<Message>, Message, Duration)> {
        let timed_out = is_gateway_stream_timeout(error);
        if !(timed_out || is_truncation(error)) || self.recoveries >= MAX_STREAM_RECOVERIES {
            return None;
        }
        if timed_out && self.timeout_recoveries >= MAX_STREAM_TIMEOUT_RECOVERIES {
            return None;
        }
        let (history, prompt) = self.input.lock().ok()?.take()?;
        let delay = Duration::from_secs(1 << self.recoveries);
        self.recoveries += 1;
        self.timeout_recoveries += u32::from(timed_out);
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
