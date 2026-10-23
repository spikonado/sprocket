use serde_json::{Value, json};

use crate::types::CompletionProvider;

pub(super) const DEFAULT_YIELD_MS: u64 = 10_000;
pub(super) const MIN_POLL_YIELD_MS: u64 = 10_000;
/// Waits end this long before the prompt cache expires, so the next request still reads it.
const CACHE_EXPIRY_MARGIN_MS: u64 = 30_000;
/// Assumed when a provider documents no retention.
const UNDOCUMENTED_CACHE_RETENTION_MS: u64 = 300_000;

#[derive(Clone, Copy, Debug)]
pub(super) enum YieldMode {
    Action,
    Poll,
}

impl YieldMode {
    /// `max_yield_ms` must be at least `MIN_POLL_YIELD_MS`.
    pub(super) fn normalize(self, yield_time_ms: u64, max_yield_ms: u64) -> u64 {
        match self {
            Self::Action => yield_time_ms.min(max_yield_ms),
            Self::Poll if yield_time_ms == 0 => 0,
            Self::Poll => yield_time_ms.clamp(MIN_POLL_YIELD_MS, max_yield_ms),
        }
    }
}

/// The longest tool wait that keeps `provider`'s prompt cache warm.
/// `cache_write_ttl` is the catalog's gateway TTL. The gateway leaves OpenAI
/// at its API default, so direct OpenAI requests share it. The ChatGPT
/// backend documents no retention.
pub(crate) fn max_yield_ms(provider: CompletionProvider, cache_write_ttl: Option<&str>) -> u64 {
    let retention_ms = match provider {
        CompletionProvider::Spikonado | CompletionProvider::Openai => {
            cache_write_ttl.and_then(ttl_ms)
        }
        CompletionProvider::Chatgpt => None,
    };
    retention_ms
        .unwrap_or(UNDOCUMENTED_CACHE_RETENTION_MS)
        .saturating_sub(CACHE_EXPIRY_MARGIN_MS)
        .max(MIN_POLL_YIELD_MS)
}

/// Parses catalog TTLs such as `"5m"`, `"30m"`, and `"1h"`.
fn ttl_ms(ttl: &str) -> Option<u64> {
    let (count, unit_ms) = if let Some(hours) = ttl.strip_suffix('h') {
        (hours, 3_600_000)
    } else {
        (ttl.strip_suffix('m')?, 60_000)
    };
    count.parse::<u64>().ok()?.checked_mul(unit_ms)
}

pub(super) fn default_yield_ms() -> u64 {
    DEFAULT_YIELD_MS
}

pub(super) fn is_default_yield_ms(yield_time_ms: &u64) -> bool {
    *yield_time_ms == DEFAULT_YIELD_MS
}

/// Use the same wait policy in provider schemas and resource execution.
pub(super) fn yield_time_schema(mode: YieldMode, max_yield_ms: u64, description: &str) -> Value {
    let mut schema = json!({
        "type": "integer",
        "default": DEFAULT_YIELD_MS,
        "description": description,
    });
    match mode {
        YieldMode::Action => {
            schema["minimum"] = json!(0);
            schema["maximum"] = json!(max_yield_ms);
        }
        YieldMode::Poll => {
            schema["anyOf"] = json!([
                { "type": "integer", "enum": [0] },
                { "type": "integer", "minimum": MIN_POLL_YIELD_MS, "maximum": max_yield_ms }
            ]);
        }
    }
    schema
}

#[cfg(test)]
mod tests;
