use anyhow::anyhow;
use rig::ProviderError;
use rig::completion::{PromptError, Usage};
use rig::message::{AssistantContent, ToolName};
use serde_json::json;

use super::{
    HandoffOutcome, HandoffTrigger, ModelCall, PendingHandoff, changed_defaults,
    handoff_properties, is_sprocket_fixable, model_call_properties, tools_called,
};
use crate::chatgpt::ChatGptNotConnected;
use crate::provider::provider_failures;
use crate::provider::test_support::coded_convex_error;
use crate::types::{CompletionProvider, ContextBudget, UsagePricing};
use crate::usage::UsageSource;

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
fn model_call_properties_describe_the_call() {
    let source = UsageSource {
        provider: CompletionProvider::Spikonado,
        model: "gpt-5".to_string(),
        fast: false,
        pricing: UsagePricing::default(),
    };
    let usage = source
        .call_usage(Usage::new().input_tokens(120).output_tokens(30))
        .unwrap();
    let call = ModelCall {
        provider: CompletionProvider::Spikonado,
        model: "gpt-5",
        usage: Some(&usage),
        cost_usd: Some(0.25),
        finish_reason: None,
        error: None,
        context_handoff: true,
        provider_fallback: false,
    };

    let properties = model_call_properties(&call, None);

    assert_eq!(properties["provider"], "spikonado");
    assert_eq!(properties["input_tokens"], 120);
    assert_eq!(properties["output_tokens"], 30);
    assert_eq!(properties["cost_usd"], 0.25);
    assert_eq!(properties["context_handoff"], true);
    assert_eq!(properties["is_error"], false);

    let failed = ModelCall {
        usage: None,
        cost_usd: None,
        error: Some("connection reset".to_string()),
        ..call
    };
    let properties = model_call_properties(&failed, None);

    assert_eq!(properties["is_error"], true);
    assert_eq!(properties["error"], "connection reset");
}

#[test]
fn handoff_properties_total_the_writing_calls() {
    let source = UsageSource {
        provider: CompletionProvider::Claude,
        model: "claude-opus".to_string(),
        fast: false,
        pricing: UsagePricing::default(),
    };
    let usage = source
        .call_usage(Usage::new().input_tokens(200_000).output_tokens(3_000))
        .unwrap();
    let call = |cost_usd| ModelCall {
        provider: source.provider,
        model: &source.model,
        usage: Some(&usage),
        cost_usd,
        finish_reason: None,
        error: None,
        context_handoff: true,
        provider_fallback: false,
    };
    let mut handoff = PendingHandoff::new(HandoffTrigger::ContextLimit, 190_000);
    handoff.record_call(&call(Some(0.5)));
    handoff.record_call(&ModelCall {
        usage: None,
        ..call(None)
    });
    handoff.record_call(&call(Some(0.25)));
    let budget = ContextBudget {
        context_window_tokens: 200_000,
        auto_handoff_token_limit: 180_000,
    };

    let properties = handoff_properties(
        &handoff,
        &budget,
        &HandoffOutcome::Resumed {
            document_bytes: 4_096,
        },
    );

    assert_eq!(properties["trigger"], "context_limit");
    assert_eq!(properties["outcome"], "resumed");
    assert_eq!(properties["model_calls"], 3);
    assert_eq!(properties["cost_usd"], 0.75);
    assert_eq!(properties["provider"], "claude");

    handoff.record_call(&call(None));
    let error = anyhow!("the agent called a tool").context("Context handoff failed");
    let properties =
        handoff_properties(&handoff, &budget, &HandoffOutcome::Failed { error: &error });

    assert!(!properties.contains_key("cost_usd"));
    assert_eq!(
        properties["error"],
        "Context handoff failed: the agent called a tool"
    );
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
