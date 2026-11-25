use rig::completion::Usage;
use serde_json::json;

use super::UsageSource;
use crate::types::{CompletionProvider, DirectApiPricing, LongContextPricing, UsagePricing};

fn source(fast: bool, long_context_threshold_tokens: Option<u64>) -> UsageSource {
    UsageSource {
        provider: CompletionProvider::Spikonado,
        model: "gpt-6.1-sol".to_string(),
        fast,
        pricing: UsagePricing {
            cache_write_ttl: Some("30m".to_string()),
            direct_api: Some(DirectApiPricing {
                input: 2.0,
                cache_read: 0.1,
                cache_write: [("30m".to_string(), 2.5)].into(),
                output: 10.0,
                fast_multiplier: 2.0,
                long_context: long_context_threshold_tokens.map(|threshold_input_tokens| {
                    LongContextPricing {
                        threshold_input_tokens,
                        input_multiplier: 2.0,
                        output_multiplier: 1.5,
                    }
                }),
            }),
        },
    }
}

#[test]
fn reports_the_call_breakdown_in_the_convex_shape() {
    let usage = Usage::new()
        .input_tokens(300_000)
        .output_tokens(900)
        .cached_input_tokens(250_000)
        .cache_creation_input_tokens(10_000)
        .reasoning_tokens(400);

    let call = source(true, Some(272_000)).call_usage(usage).unwrap();

    assert_eq!(
        serde_json::to_value(call).unwrap(),
        json!({
            "provider": "spikonado",
            "model": "gpt-6.1-sol",
            "serviceTier": "fast",
            "longContext": true,
            "cacheWriteTtl": "30m",
            "inputTokens": 300_000,
            "cacheReadTokens": 250_000,
            "cacheWriteTokens": 10_000,
            "outputTokens": 900,
            "reasoningTokens": 400,
        })
    );
}

#[test]
fn prices_the_call_like_the_web_usage_page() {
    let usage = Usage::new()
        .input_tokens(300_000)
        .output_tokens(900)
        .cached_input_tokens(250_000)
        .cache_creation_input_tokens(10_000)
        .reasoning_tokens(400);
    let source = source(true, Some(272_000));
    let call = source.call_usage(usage).unwrap();

    let cost = source.cost_usd(&call).unwrap();
    assert!((cost - 0.547).abs() < 1e-9, "{cost}");

    let unpriced_ttl = UsageSource {
        pricing: UsagePricing {
            cache_write_ttl: Some("12h".to_string()),
            ..source.pricing.clone()
        },
        ..source
    };
    assert_eq!(
        unpriced_ttl.cost_usd(&unpriced_ttl.call_usage(usage).unwrap()),
        None
    );
}

#[test]
fn stays_in_the_standard_band_without_a_long_context_price() {
    let usage = Usage::new().input_tokens(300_000).output_tokens(10);

    let call = serde_json::to_value(source(false, None).call_usage(usage).unwrap()).unwrap();

    assert_eq!(call["longContext"], false);
    assert_eq!(call["serviceTier"], "standard");
}

#[test]
fn skips_calls_without_token_counts() {
    assert_eq!(source(false, None).call_usage(Usage::new()), None);
}
