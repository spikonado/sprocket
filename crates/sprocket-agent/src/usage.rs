use rig::completion::Usage;
use serde::Serialize;

use crate::types::{CompletionProvider, LongContextPricing, UsagePricing};

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct UsageSource {
    pub(crate) provider: CompletionProvider,
    pub(crate) model: String,
    pub(crate) fast: bool,
    pub(crate) pricing: UsagePricing,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelCallUsage {
    provider: CompletionProvider,
    model: String,
    service_tier: &'static str,
    long_context: bool,
    cache_write_ttl: Option<String>,
    pub(crate) input_tokens: u64,
    pub(crate) cache_read_tokens: u64,
    pub(crate) cache_write_tokens: u64,
    pub(crate) output_tokens: u64,
    pub(crate) reasoning_tokens: u64,
}

impl UsageSource {
    pub(crate) fn call_usage(&self, usage: Usage) -> Option<ModelCallUsage> {
        if usage.input_tokens.is_none() && usage.output_tokens.is_none() {
            return None;
        }
        let input_tokens = usage.input_tokens.unwrap_or(0);
        let output_tokens = usage.output_tokens.unwrap_or(0);
        // Convex rejects counts that break rig's subset contract, which would fail the run.
        let cache_read_tokens = usage.cached_input_tokens.unwrap_or(0).min(input_tokens);
        let cache_write_tokens = usage
            .cache_creation_input_tokens
            .unwrap_or(0)
            .min(input_tokens - cache_read_tokens);
        Some(ModelCallUsage {
            provider: self.provider,
            model: self.model.clone(),
            service_tier: if self.fast { "fast" } else { "standard" },
            long_context: self.long_context_pricing(input_tokens).is_some(),
            cache_write_ttl: self.pricing.cache_write_ttl.clone(),
            input_tokens,
            cache_read_tokens,
            cache_write_tokens,
            output_tokens,
            reasoning_tokens: usage.reasoning_tokens.unwrap_or(0).min(output_tokens),
        })
    }

    /// Matches the web's `apiCost`, so it is `None` when the catalog can't price the call.
    pub(crate) fn cost_usd(&self, call: &ModelCallUsage) -> Option<f64> {
        let pricing = self.pricing.direct_api.as_ref()?;
        let cache_write_price = match call
            .cache_write_ttl
            .as_ref()
            .and_then(|ttl| pricing.cache_write.get(ttl))
        {
            Some(price) => *price,
            None if call.cache_write_tokens > 0 => return None,
            None => 0.0,
        };
        let (input_multiplier, output_multiplier) = self
            .long_context_pricing(call.input_tokens)
            .map_or((1.0, 1.0), |long_context| {
                (
                    long_context.input_multiplier,
                    long_context.output_multiplier,
                )
            });
        let tier_multiplier = if self.fast {
            pricing.fast_multiplier
        } else {
            1.0
        };
        let uncached_input = call.input_tokens - call.cache_read_tokens - call.cache_write_tokens;
        let input = uncached_input as f64 * pricing.input
            + call.cache_read_tokens as f64 * pricing.cache_read
            + call.cache_write_tokens as f64 * cache_write_price;
        let output = call.output_tokens as f64 * pricing.output;
        Some(
            (input * input_multiplier + output * output_multiplier) * tier_multiplier / 1_000_000.0,
        )
    }

    fn long_context_pricing(&self, input_tokens: u64) -> Option<&LongContextPricing> {
        self.pricing
            .direct_api
            .as_ref()?
            .long_context
            .as_ref()
            .filter(|long_context| input_tokens > long_context.threshold_input_tokens)
    }
}

#[cfg(test)]
mod tests;
