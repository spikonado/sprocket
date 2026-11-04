use anyhow::Context;
use convex::{ConvexError, FunctionResult, Value};
use serde::{Deserialize, de::Deserializer};

/// Codes from `apps/web/convex/lib/agentErrorCodes.json`.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ConvexErrorCode {
    RunCancelled,
    RunNoLongerActive,
    CompletionStreamSuperseded,
    SubmissionWaiting,
    SubmissionOwnedByAnotherExecutor,
    MachineNotActive,
}

/// A Convex function failure. Its `Display` is the cleaned message.
#[derive(Debug)]
pub struct ConvexFunctionError {
    pub code: Option<ConvexErrorCode>,
    message: String,
}

impl std::fmt::Display for ConvexFunctionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ConvexFunctionError {}

/// The code of the first Convex function failure in `error`'s chain.
pub fn convex_error_code(error: &anyhow::Error) -> Option<ConvexErrorCode> {
    error
        .chain()
        .find_map(|cause| cause.downcast_ref::<ConvexFunctionError>())
        .and_then(|failure| failure.code)
}

/// Decode a Convex `FunctionResult` into `T`, converting Values through plain JSON.
///
/// Error messages are cleaned of Convex transport noise (request-id masking lines,
/// `Uncaught` prefixes, stack frames) so callers can surface them to users or tools
/// without extra stripping. `ConvexError` `data` is preferred over `message`
/// because production redacts `message`. Failures are `ConvexFunctionError`s.
/// The `function` argument is only attached when a successful Value fails to
/// deserialize into `T`.
pub fn decode_function_result<T: for<'de> Deserialize<'de>>(
    result: FunctionResult,
    function: &str,
) -> anyhow::Result<T> {
    decode(result, function, false)
}

pub fn decode_labeled_function_result<T: for<'de> Deserialize<'de>>(
    result: FunctionResult,
    function: &str,
) -> anyhow::Result<T> {
    decode(result, function, true)
}

fn decode<T: for<'de> Deserialize<'de>>(
    result: FunctionResult,
    function: &str,
    labeled: bool,
) -> anyhow::Result<T> {
    let (code, message) = match result {
        FunctionResult::Value(value) => {
            let json_value = value_to_plain_json(value);
            return serde_json::from_value(json_value.clone()).with_context(|| {
                format!("failed to decode response from {function}; payload: {json_value}")
            });
        }
        FunctionResult::ErrorMessage(message) => (None, clean_function_error_message(&message)),
        FunctionResult::ConvexError(error) => (
            error_code(&error),
            clean_function_error_message(convex_error_text(&error)),
        ),
    };
    let message = if labeled {
        format!("{function}: {message}")
    } else {
        message
    };
    Err(ConvexFunctionError { code, message }.into())
}

/// Application payload for a `ConvexError`. Production redacts `message` to a
/// `[Request ID ...] Server Error` line; `data` (a string, or the `message` of
/// a coded error) is what the function threw and is what tools should see.
fn convex_error_text(error: &ConvexError) -> &str {
    match &error.data {
        Value::String(text) if !text.trim().is_empty() => text,
        Value::Object(fields) => match fields.get("message") {
            Some(Value::String(text)) if !text.trim().is_empty() => text,
            _ => error.message.as_str(),
        },
        _ => error.message.as_str(),
    }
}

fn error_code(error: &ConvexError) -> Option<ConvexErrorCode> {
    let Value::Object(fields) = &error.data else {
        return None;
    };
    let Some(Value::String(code)) = fields.get("code") else {
        return None;
    };
    serde_json::from_value(serde_json::Value::String(code.clone())).ok()
}

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
        return "The server failed without a readable error.".to_string();
    }
    content.join(" ")
}

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
