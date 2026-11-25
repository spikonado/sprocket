use anyhow::anyhow;
use rig::ProviderError;
use rig::completion::{PromptError, Usage};
use rig::message::{AssistantContent, ToolName};
use serde_json::json;

use super::{
    GenerationCall, analytics_id, changed_defaults, generation_properties, is_sprocket_fixable,
    tools_called,
};
use crate::chatgpt::ChatGptNotConnected;
use crate::provider::provider_failures;
use crate::provider::test_support::coded_convex_error;
use crate::types::CompletionProvider;

#[test]
fn changed_defaults_lists_parameters_set_away_from_their_default() {
    let defaults = json!({ "chars": "", "yieldTimeMs": 10_000, "includeSettled": false });
    let args = r#"{"chars":"","yieldTimeMs":30000,"cmd":"ls"}"#;

    assert_eq!(
        changed_defaults(defaults.as_object(), args),
        ["yieldTimeMs"]
    );
}

#[test]
fn generation_properties_describe_the_call() {
    let mut usage = Usage::default();
    usage.input_tokens = Some(120);
    usage.output_tokens = Some(30);
    let call = GenerationCall {
        provider: CompletionProvider::Spikonado,
        model: "gpt-5",
        usage,
        finish_reason: None,
        error: None,
        context_handoff: true,
        provider_fallback: false,
    };

    let properties = generation_properties("run-1", "thread-1", &call, None);

    assert_eq!(properties["$ai_provider"], "spikonado");
    assert_eq!(properties["$ai_input_tokens"], 120);
    assert_eq!(properties["$ai_output_tokens"], 30);
    assert_eq!(properties["$ai_span_name"], "context_handoff");
    assert!(!properties.contains_key("$ai_cache_read_input_tokens"));

    let failed = GenerationCall {
        error: Some("connection reset".to_string()),
        ..call
    };
    let properties = generation_properties("run-1", "thread-1", &failed, None);

    assert_eq!(properties["$ai_is_error"], true);
    assert_eq!(properties["$ai_error"], "connection reset");
}

#[test]
fn tools_called_lists_each_call_in_order() {
    let call =
        |name: &str| AssistantContent::tool_call("", ToolName::new(name).unwrap(), json!({}));
    let content = [
        AssistantContent::text("checking"),
        call("exec_cmd"),
        call("apply_patch"),
        call("exec_cmd"),
    ];

    assert_eq!(
        tools_called(&content),
        ["exec_cmd", "apply_patch", "exec_cmd"]
    );
}

#[test]
fn analytics_id_matches_convex() {
    assert_eq!(
        analytics_id("thread-1"),
        "4b0a5fefc328e6b9257bc535e3c5d26fec36b52f92e277618bf5b30fc3885e58"
    );
}

#[test]
fn only_sprocket_failures_are_reportable() {
    assert!(is_sprocket_fixable(&anyhow!(
        "Agent stream ended without a final response."
    )));
    assert!(!is_sprocket_fixable(
        &anyhow!(PromptError::Report(ProviderError::Truncated.report()))
            .context("Context handoff failed.")
    ));
    assert!(!is_sprocket_fixable(&anyhow::Error::new(
        ChatGptNotConnected
    )));
    assert!(!is_sprocket_fixable(&coded_convex_error(
        "USAGE_LIMIT_REACHED"
    )));
    let not_configured = || {
        (
            CompletionProvider::Claude,
            coded_convex_error("PROVIDER_NOT_CONFIGURED"),
        )
    };
    assert!(!is_sprocket_fixable(&provider_failures(vec![
        not_configured(),
        (
            CompletionProvider::Chatgpt,
            anyhow!(PromptError::Report(ProviderError::Truncated.report())),
        ),
    ])));
    assert!(is_sprocket_fixable(&provider_failures(vec![
        not_configured(),
        (
            CompletionProvider::Openai,
            anyhow!("Agent stream ended without a final response."),
        ),
    ])));
}
