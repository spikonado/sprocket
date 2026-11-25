use std::future::Future;

use rig::tool::{ToolErrorKind, ToolExecutionError};
use serde_json::{Value, json};
use sprocket_workspace::async_tools::PollWindow;

use crate::types::CompletionProvider;

pub(super) const DEFAULT_YIELD_MS: u64 = 10_000;
pub(super) const MIN_POLL_YIELD_MS: u64 = 10_000;
const CACHE_EXPIRY_MARGIN_MS: u64 = 30_000;
const UNDOCUMENTED_CACHE_RETENTION_MS: u64 = 300_000;

#[derive(Clone, Copy, Debug)]
pub(super) enum YieldMode {
    Action,
    Poll,
}

impl YieldMode {
    pub(super) fn normalize(self, yield_time_ms: u64, max_yield_ms: u64) -> u64 {
        match self {
            Self::Action => yield_time_ms.min(max_yield_ms),
            Self::Poll if yield_time_ms == 0 => 0,
            Self::Poll => yield_time_ms.min(max_yield_ms).max(MIN_POLL_YIELD_MS),
        }
    }
}

/// The longest tool wait that keeps `provider`'s prompt cache warm.
/// `cache_write_ttl` is the catalog's gateway TTL. The gateway leaves OpenAI
/// at its API default, so direct OpenAI requests share it. The ChatGPT
/// backend, OpenCode, Morph and Gemini's implicit cache document no retention.
pub(crate) fn max_yield_ms(provider: CompletionProvider, cache_write_ttl: Option<&str>) -> u64 {
    let retention_ms = match provider {
        CompletionProvider::Spikonado
        | CompletionProvider::Openai
        | CompletionProvider::Anthropic
        | CompletionProvider::Vercel
        | CompletionProvider::Openrouter
        | CompletionProvider::Vertex => cache_write_ttl.and_then(ttl_ms),
        CompletionProvider::Chatgpt
        | CompletionProvider::Opencode
        | CompletionProvider::OpencodeGo
        | CompletionProvider::Muse
        | CompletionProvider::Morph
        | CompletionProvider::Google => None,
        // Claude Code writes its prompt cache at a one-hour TTL.
        CompletionProvider::Claude => Some(3_600_000),
    };
    retention_ms
        .unwrap_or(UNDOCUMENTED_CACHE_RETENTION_MS)
        .saturating_sub(CACHE_EXPIRY_MARGIN_MS)
        .max(MIN_POLL_YIELD_MS)
}

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

/// Polls every target in one shared window. The first target to return closes
/// the window, so the others stop waiting and report what they have. Each
/// entry is the target's `id` fields plus its result or `error`.
pub(super) async fn poll_targets<'a, T, F, Fut>(
    window: &PollWindow,
    targets: &'a [T],
    id: impl Fn(&T) -> Value,
    poll: F,
) -> Result<Value, ToolExecutionError>
where
    F: Fn(&'a T) -> Fut,
    Fut: Future<Output = Result<Value, ToolExecutionError>>,
{
    let results = futures::future::join_all(targets.iter().map(|target| {
        let polled = poll(target);
        async move {
            let result = polled.await;
            window.close();
            result
        }
    }))
    .await;
    targets
        .iter()
        .zip(results)
        .map(|(target, result)| {
            let mut entry = id(target);
            match result {
                Ok(Value::Object(fields)) => entry.as_object_mut().unwrap().extend(fields),
                Ok(other) => entry["result"] = other,
                Err(error) if error.kind() == ToolErrorKind::Cancelled => return Err(error),
                Err(error) => entry["error"] = json!(error.to_string()),
            }
            Ok(entry)
        })
        .collect::<Result<Vec<_>, _>>()
        .map(Value::Array)
}

#[cfg(test)]
mod tests;
