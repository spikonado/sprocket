//! Shared Convex RPC decode helpers for agent and server.
//!
//! - [`decode_function_result`] cleans transport noise and returns the readable
//!   sentence. Prefer this when the error is shown to a model or end user.
//! - [`decode_labeled_function_result`] does the same, then prefixes RPC failures
//!   with the Convex function path. Prefer this in server/ops paths that need to
//!   know which call failed.
//! - [`deserialize_convex_u64`] / [`deserialize_convex_u32`] decode Convex wire
//!   numbers (`f64`) into integers. Do not use them on non-Convex JSON.

use anyhow::{Context, anyhow};
use convex::{ConvexError, FunctionResult, Value};
use serde::{Deserialize, de::Deserializer};

/// Decode a Convex `FunctionResult` into `T`, converting Values through plain JSON.
///
/// Error messages are cleaned of Convex transport noise (request-id masking lines,
/// `Uncaught` prefixes, stack frames) so callers can surface them to users or tools
/// without extra stripping. `ConvexError` string `data` is preferred over `message`
/// because production redacts `message`. The `function` argument is only attached
/// when a successful Value fails to deserialize into `T`.
pub fn decode_function_result<T: for<'de> Deserialize<'de>>(
    result: FunctionResult,
    function: &str,
) -> anyhow::Result<T> {
    match result {
        FunctionResult::Value(value) => {
            let json_value = value_to_plain_json(value);
            serde_json::from_value(json_value.clone()).with_context(|| {
                format!("failed to decode response from {function}; payload: {json_value}")
            })
        }
        FunctionResult::ErrorMessage(message) => {
            Err(anyhow!(clean_function_error_message(&message)))
        }
        FunctionResult::ConvexError(error) => Err(anyhow!(clean_function_error_message(
            convex_error_text(&error)
        ))),
    }
}

/// Like [`decode_function_result`], but prefixes cleaned RPC failures with
/// `{function}: ` so logs and watchers can identify the call.
pub fn decode_labeled_function_result<T: for<'de> Deserialize<'de>>(
    result: FunctionResult,
    function: &str,
) -> anyhow::Result<T> {
    match result {
        FunctionResult::Value(_) => decode_function_result(result, function),
        FunctionResult::ErrorMessage(message) => Err(anyhow!(
            "{function}: {}",
            clean_function_error_message(&message)
        )),
        FunctionResult::ConvexError(error) => Err(anyhow!(
            "{function}: {}",
            clean_function_error_message(convex_error_text(&error))
        )),
    }
}

/// Application payload for a `ConvexError`. Production redacts `message` to a
/// `[Request ID ...] Server Error` line; string `data` is what the function
/// threw and is what tools should see.
fn convex_error_text(error: &ConvexError) -> &str {
    match &error.data {
        Value::String(text) if !text.trim().is_empty() => text,
        _ => error.message.as_str(),
    }
}

/// Strips the transport noise Convex wraps around failed function calls:
/// production masking lines ("[Request ID ...] Server Error"), `Uncaught`
/// prefixes, and stack frames.
fn clean_function_error_message(raw: &str) -> String {
    let mut content: Vec<&str> = Vec::new();
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("[Request ID") {
            continue;
        }
        if line.starts_with([' ', '\t']) && trimmed.starts_with("at ") {
            continue;
        }
        let mut message = trimmed;
        while let Some(inner) = message
            .strip_prefix("Uncaught ConvexError: ")
            .or_else(|| message.strip_prefix("Uncaught Error: "))
        {
            message = inner;
        }
        content.push(message);
    }
    if content.is_empty() {
        // Production masking left nothing readable behind; the request id
        // stays available in the Convex dashboard logs.
        return "The server failed without a readable error.".to_string();
    }
    content.join(" ")
}

/// Convert a Convex `Value` into plain `serde_json::Value` for deserialization.
fn value_to_plain_json(value: Value) -> serde_json::Value {
    match value {
        Value::Null => serde_json::Value::Null,
        Value::Int64(number) => serde_json::json!(number),
        Value::Float64(number) => float_to_json(number),
        Value::Boolean(boolean) => serde_json::json!(boolean),
        Value::String(text) => serde_json::json!(text),
        Value::Bytes(bytes) => serde_json::json!(bytes),
        Value::Array(values) => serde_json::Value::Array(
            values
                .into_iter()
                .map(value_to_plain_json)
                .collect::<Vec<_>>(),
        ),
        Value::Object(fields) => serde_json::Value::Object(
            fields
                .into_iter()
                .map(|(key, value)| (key, value_to_plain_json(value)))
                .collect(),
        ),
    }
}

/// Convex stores every number as a float. Integers must decode back to `5`,
/// not `5.0`, so replayed model history matches the bytes the model saw.
fn float_to_json(number: f64) -> serde_json::Value {
    const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
    if number.fract() == 0.0 && number.abs() <= MAX_SAFE_INTEGER {
        serde_json::json!(number as i64)
    } else {
        serde_json::json!(number)
    }
}

/// Deserialize a Convex number (`f64` on the wire) into a non-negative `u64`.
pub fn deserialize_convex_u64<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: Deserializer<'de>,
{
    let value = f64::deserialize(deserializer)?;
    if !value.is_finite() || value < 0.0 || value.fract() != 0.0 {
        return Err(serde::de::Error::custom(format!(
            "expected a non-negative integer-compatible Convex number, got {value}"
        )));
    }
    Ok(value as u64)
}

/// Deserialize a Convex number (`f64` on the wire) into a `u32`.
pub fn deserialize_convex_u32<'de, D>(deserializer: D) -> Result<u32, D::Error>
where
    D: Deserializer<'de>,
{
    let value = f64::deserialize(deserializer)?;
    if !value.is_finite() || value < 0.0 || value.fract() != 0.0 || value > u32::MAX as f64 {
        return Err(serde::de::Error::custom(format!(
            "expected a u32-compatible Convex number, got {value}"
        )));
    }
    Ok(value as u32)
}

#[cfg(test)]
mod tests;
