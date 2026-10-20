use rig::completion::Usage;
use serde::Serialize;

use crate::types::CompletionProvider;

/// The provider, model and price band a completion call ran under.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct UsageSource {
    pub(crate) provider: CompletionProvider,
    pub(crate) model: String,
    pub(crate) fast: bool,
    pub(crate) long_context_threshold_tokens: Option<u64>,
}

/// One completion call's tokens, in the shape `agentRuntime` records.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelCallUsage {
    provider: CompletionProvider,
    model: String,
    service_tier: &'static str,
    long_context: bool,
    input_tokens: u64,
    cache_read_tokens: u64,
    cache_write_tokens: u64,
    output_tokens: u64,
    reasoning_tokens: u64,
}

impl UsageSource {
    /// None when the provider reported no token counts.
    pub(crate) fn call_usage(&self, usage: Usage) -> Option<ModelCallUsage> {
        if usage.input_tokens.is_none() && usage.output_tokens.is_none() {
            return None;
        }
        let input_tokens = usage.input_tokens.unwrap_or(0);
        let output_tokens = usage.output_tokens.unwrap_or(0);
        // Convex rejects counts that break rig's subset contract, which would drop the transcript.
        let cache_read_tokens = usage.cached_input_tokens.unwrap_or(0).min(input_tokens);
        let cache_write_tokens = usage
            .cache_creation_input_tokens
            .unwrap_or(0)
            .min(input_tokens - cache_read_tokens);
        Some(ModelCallUsage {
            provider: self.provider,
            model: self.model.clone(),
            service_tier: if self.fast { "fast" } else { "standard" },
            long_context: self
                .long_context_threshold_tokens
                .is_some_and(|threshold| input_tokens > threshold),
            input_tokens,
            cache_read_tokens,
            cache_write_tokens,
            output_tokens,
            reasoning_tokens: usage.reasoning_tokens.unwrap_or(0).min(output_tokens),
        })
    }
}

#[cfg(test)]
mod tests;
