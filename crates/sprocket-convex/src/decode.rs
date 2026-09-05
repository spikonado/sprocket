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
use convex::{FunctionResult, Value};
use serde::{Deserialize, de::Deserializer};

/// Decode a Convex `FunctionResult` into `T`, converting Values through plain JSON.
///
/// Error messages are cleaned of Convex transport noise (request-id masking lines,
/// `Uncaught` prefixes, stack frames) so callers can surface them to users or tools
/// without extra stripping. The `function` argument is only attached when a
/// successful Value fails to deserialize into `T`.
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
        FunctionResult::ConvexError(error) => {
            Err(anyhow!(clean_function_error_message(&error.message)))
        }
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
            clean_function_error_message(&error.message)
        )),
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
        let message = trimmed
            .strip_prefix("Uncaught ConvexError: ")
            .or_else(|| trimmed.strip_prefix("Uncaught Error: "))
            .unwrap_or(trimmed);
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
        Value::Float64(number) => serde_json::json!(number),
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
mod tests {
    use super::*;

    #[test]
    fn cleans_masking_lines_prefixes_and_stack_frames() {
        let raw = concat!(
            "[Request ID: 84f5068c0836218d] Server Error\n",
            "Uncaught ConvexError: The webpage is too complex and could not be parsed as Markdown.\n",
            "    at handler (../src/convex/webTools.ts:130:2)"
        );
        assert_eq!(
            clean_function_error_message(raw),
            "The webpage is too complex and could not be parsed as Markdown."
        );
    }

    #[test]
    fn keeps_plain_messages_untouched() {
        assert_eq!(
            clean_function_error_message("Mandate not found."),
            "Mandate not found."
        );
    }

    #[test]
    fn strips_uncaught_error_prefixes() {
        assert_eq!(
            clean_function_error_message("Uncaught Error: Prava request failed (500): boom"),
            "Prava request failed (500): boom"
        );
    }

    #[test]
    fn falls_back_when_production_masks_the_whole_error() {
        assert_eq!(
            clean_function_error_message("[Request ID: 0d45611fde71c0f2] Server Error"),
            "The server failed without a readable error."
        );
    }

    #[test]
    fn value_to_plain_json_round_trips_object_fields() {
        let value = Value::Object(
            [("n".to_string(), Value::Float64(3.0))]
                .into_iter()
                .collect(),
        );
        assert_eq!(value_to_plain_json(value), serde_json::json!({ "n": 3.0 }));
    }

    #[test]
    fn labeled_errors_include_the_function_path() {
        let err = decode_labeled_function_result::<serde_json::Value>(
            FunctionResult::ErrorMessage("Uncaught Error: boom".to_string()),
            "transcript:getState",
        )
        .expect_err("should fail");
        assert_eq!(err.to_string(), "transcript:getState: boom");
    }

    #[test]
    fn deserialize_convex_u64_accepts_integer_floats() {
        #[derive(Deserialize)]
        struct Row {
            #[serde(deserialize_with = "deserialize_convex_u64")]
            n: u64,
        }
        let row: Row = serde_json::from_value(serde_json::json!({ "n": 12.0 })).unwrap();
        assert_eq!(row.n, 12);
    }

    #[test]
    fn deserialize_convex_u64_rejects_fractions() {
        #[derive(Deserialize)]
        struct Row {
            #[serde(deserialize_with = "deserialize_convex_u64")]
            n: u64,
        }
        assert!(serde_json::from_value::<Row>(serde_json::json!({ "n": 1.5 })).is_err());
    }

    #[test]
    fn deserialize_convex_u32_rejects_overflow() {
        #[derive(Deserialize)]
        struct Row {
            #[serde(deserialize_with = "deserialize_convex_u32")]
            n: u32,
        }
        assert!(
            serde_json::from_value::<Row>(serde_json::json!({ "n": (u32::MAX as f64) + 1.0 }))
                .is_err()
        );
    }
}
