pub(crate) fn coded_convex_error(code: &str) -> anyhow::Error {
    let data = [("code", code), ("message", "Convex failure.")]
        .into_iter()
        .map(|(key, value)| (key.to_string(), value.into()))
        .collect();
    sprocket_convex::decode_function_result::<()>(
        convex::FunctionResult::ConvexError(convex::ConvexError {
            message: String::new(),
            data: convex::Value::Object(data),
        }),
        "agentRuntime:registerCompletionAttempt",
    )
    .unwrap_err()
    .context("completion provider failed")
}
