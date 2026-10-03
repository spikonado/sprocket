use serde_json::{Value, json};
use sprocket_workspace::async_tools::{
    DEFAULT_YIELD_MS, MAX_YIELD_MS, MIN_POLL_YIELD_MS, YieldMode,
};

pub(super) fn default_yield_ms() -> u64 {
    DEFAULT_YIELD_MS
}

pub(super) fn is_default_yield_ms(yield_time_ms: &u64) -> bool {
    *yield_time_ms == DEFAULT_YIELD_MS
}

/// Use the same wait policy in provider schemas and resource execution.
pub(super) fn yield_time_schema(mode: YieldMode, description: &str) -> Value {
    let mut schema = json!({
        "type": "integer",
        "default": DEFAULT_YIELD_MS,
        "description": description,
    });
    match mode {
        YieldMode::Action => {
            schema["minimum"] = json!(0);
            schema["maximum"] = json!(MAX_YIELD_MS);
        }
        YieldMode::Poll => {
            schema["anyOf"] = json!([
                { "type": "integer", "enum": [0] },
                { "type": "integer", "minimum": MIN_POLL_YIELD_MS, "maximum": MAX_YIELD_MS }
            ]);
        }
    }
    schema
}
