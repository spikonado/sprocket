use std::sync::{Arc, Mutex};
use std::time::Duration;

use rig::agent::{
    AgentHook, CompletionCallAction, CompletionCallEvent, HookContext, StepEventKind,
};
use rig::completion::{Message, PromptError};
use rig::error::ErrorKind;
use rig::{ErrorReport, ProviderError};

const MAX_STREAM_RECOVERIES: u32 = 3;
const MAX_STREAM_TIMEOUT_RECOVERIES: u32 = 1;
const GATEWAY_STREAM_TIMEOUT_CODE: &str = "gateway_stream_timeout";

/// The agent hook that records each completion call's input.
#[derive(Clone, Default)]
pub(crate) struct CompletionInput(Arc<Mutex<Option<(Vec<Message>, Message)>>>);

impl CompletionInput {
    fn take(&self) -> Option<(Vec<Message>, Message)> {
        self.0.lock().ok()?.take()
    }
}

#[derive(Default)]
pub(crate) struct StreamRecovery {
    input: CompletionInput,
    recoveries: u32,
    timeout_recoveries: u32,
}

fn is_truncation(error: &PromptError) -> bool {
    match error {
        PromptError::Provider(ProviderError::Truncated) => true,
        PromptError::Report(report) => {
            // Rig relays a handler's failure as its report.
            let expected = ProviderError::Truncated.report();
            report.kind == expected.kind && report.retryable && report.message == expected.message
        }
        _ => false,
    }
}

fn is_gateway_stream_timeout(error: &PromptError) -> bool {
    provider_error_code(error).as_deref() == Some(GATEWAY_STREAM_TIMEOUT_CODE)
}

pub(crate) fn provider_error_code(error: &(dyn std::error::Error + 'static)) -> Option<String> {
    let response = if let Some(error) = error.downcast_ref::<PromptError>() {
        match error {
            PromptError::Provider(error) => error.provider_response(),
            PromptError::Report(report) => report.provider_response.as_ref(),
            _ => None,
        }
    } else if let Some(error) = error.downcast_ref::<ProviderError>() {
        error.provider_response()
    } else {
        error
            .downcast_ref::<ErrorReport>()?
            .provider_response
            .as_ref()
    };
    response?.machine_code()
}

/// Failures another provider may not have.
pub(crate) fn is_provider_failure(error: &PromptError) -> bool {
    match error {
        PromptError::Provider(_) => true,
        PromptError::Report(report) => is_provider_kind(&report.kind),
        _ => false,
    }
}

pub(crate) fn is_provider_failure_cause(error: &(dyn std::error::Error + 'static)) -> bool {
    if let Some(error) = error.downcast_ref::<PromptError>() {
        is_provider_failure(error)
    } else if error.is::<ProviderError>() {
        true
    } else {
        error
            .downcast_ref::<ErrorReport>()
            .is_some_and(|report| is_provider_kind(&report.kind))
    }
}

fn is_provider_kind(kind: &ErrorKind) -> bool {
    matches!(
        kind,
        ErrorKind::Http
            | ErrorKind::Request
            | ErrorKind::Response
            | ErrorKind::Provider
            | ErrorKind::ProviderResponse
            | ErrorKind::Timeout
    )
}

impl StreamRecovery {
    pub(crate) fn hook(&self) -> CompletionInput {
        self.input.clone()
    }

    pub(crate) fn take_input(&self) -> Option<(Vec<Message>, Message)> {
        self.input.take()
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
        let (history, prompt) = self.input.take()?;
        let delay = Duration::from_secs(1 << self.recoveries);
        self.recoveries += 1;
        self.timeout_recoveries += u32::from(timed_out);
        Some((history, prompt, delay))
    }
}

impl AgentHook for CompletionInput {
    fn observes(&self, kind: StepEventKind) -> bool {
        kind == StepEventKind::CompletionCall
    }

    async fn on_completion_call(
        &self,
        _context: &HookContext,
        event: CompletionCallEvent<'_>,
    ) -> CompletionCallAction {
        match self.0.lock() {
            Ok(mut input) => {
                let history = event.history.iter().map(|message| (**message).clone());
                *input = Some((history.collect(), event.prompt.clone()));
                CompletionCallAction::Continue
            }
            Err(_) => CompletionCallAction::stop("Stream recovery state is unavailable."),
        }
    }
}

#[cfg(test)]
mod tests;
