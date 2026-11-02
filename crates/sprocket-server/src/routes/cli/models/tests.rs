use super::*;
use sprocket_agent::CompletionProvider::{Chatgpt, Spikonado};

fn catalog() -> ProviderCatalog {
    serde_json::from_value(serde_json::json!({
        "defaultModelId": "default", "defaultFast": false,
        "models": [
            {"id": "default", "label": "Default", "vendor": "anthropic", "supportsImages": true, "reasoningEfforts": ["medium", "high"], "defaultReasoningEffort": "high", "serviceTiers": ["standard", "fast"]},
            {"id": "pro", "label": "Pro", "vendor": "anthropic", "supportsImages": true, "reasoningEfforts": ["max"], "defaultReasoningEffort": "max", "serviceTiers": ["standard"]},
            {"id": "gpt", "label": "GPT", "vendor": "openai", "supportsImages": true, "reasoningEfforts": ["xhigh"], "defaultReasoningEffort": "xhigh", "serviceTiers": ["standard", "fast"]}
        ]
    })).unwrap()
}

fn run_request() -> CliRunRequest {
    CliRunRequest {
        client_id: "client".into(),
        prompt: "task".into(),
        directory: "/tmp".into(),
        thread_id: None,
        model: None,
        reasoning: None,
        fast: None,
    }
}

fn fresh_context() -> RunContext {
    RunContext {
        gateway_url: String::new(),
        providers: vec![Spikonado],
        thread: None,
    }
}

fn thread_context(selected_model: &str, reasoning_effort: &str, fast_mode: bool) -> RunContext {
    RunContext {
        thread: Some(ThreadSettings {
            repository_key: "repo".into(),
            selected_model: selected_model.into(),
            reasoning_effort: reasoning_effort.into(),
            fast_mode,
        }),
        ..fresh_context()
    }
}

#[test]
fn defaults_do_not_enable_fast_and_invalid_overrides_never_fall_back() {
    let context = fresh_context();
    let mut request = run_request();
    assert!(!select(&catalog(), &context, &request).unwrap().fast);
    request.model = Some("missing".into());
    let error = select(&catalog(), &context, &request).unwrap_err();
    assert!(error.to_string().contains("enabled providers (spikonado)"));
    request.model = None;
    request.reasoning = Some("unsupported".into());
    assert!(select(&catalog(), &context, &request).is_err());
}

#[test]
fn uses_the_first_listed_provider_that_serves_the_model() {
    let mut context = thread_context("gpt", "xhigh", false);
    context.providers = vec![Chatgpt, Spikonado];
    assert_eq!(
        select(&catalog(), &context, &run_request())
            .unwrap()
            .provider,
        Chatgpt
    );
    let mut request = run_request();
    request.model = Some("default".into());
    assert_eq!(
        select(&catalog(), &context, &request).unwrap().provider,
        Spikonado
    );
}

#[test]
fn fast_mode_stays_off_on_providers_without_a_fast_tier() {
    let mut context = thread_context("gpt", "xhigh", true);
    context.providers = vec![Chatgpt];
    assert!(!select(&catalog(), &context, &run_request()).unwrap().fast);
    let mut request = run_request();
    request.fast = Some(true);
    assert!(select(&catalog(), &context, &request).is_err());
}

#[test]
fn selects_and_inherits_saved_models() {
    let mut request = run_request();
    request.model = Some("pro".into());
    let settings = select(&catalog(), &fresh_context(), &request).unwrap();
    assert_eq!(settings.model, "pro");
    assert_eq!(settings.reasoning, "max");

    let settings = select(
        &catalog(),
        &thread_context("pro", "max", false),
        &run_request(),
    )
    .unwrap();
    assert_eq!(settings.model, "pro");
    assert_eq!(settings.reasoning, "max");
    assert!(!settings.fast);
}

#[test]
fn stale_saved_models_resume_with_fresh_default_settings() {
    let mut catalog = catalog();
    catalog.models[0].default_reasoning_effort = "medium".into();
    catalog.models[0].service_tiers = vec!["standard".into()];
    let settings = select(
        &catalog,
        &thread_context("removed", "max", true),
        &run_request(),
    )
    .unwrap();
    assert_eq!(settings.model, "default");
    assert_eq!(settings.reasoning, "medium");
    assert!(!settings.fast);
}

#[test]
fn stale_model_fallback_preserves_explicit_options() {
    let context = thread_context("removed", "max", true);
    let mut request = run_request();
    request.reasoning = Some("medium".into());
    request.fast = Some(true);
    let settings = select(&catalog(), &context, &request).unwrap();
    assert_eq!(settings.model, "default");
    assert_eq!(settings.reasoning, "medium");
    assert!(settings.fast);

    request.model = Some("removed".into());
    assert!(select(&catalog(), &context, &request).is_err());
}

#[test]
fn selects_and_inherits_fast_mode_on_supported_models() {
    let mut request = run_request();
    request.fast = Some(true);
    assert!(select(&catalog(), &fresh_context(), &request).unwrap().fast);
    request.model = Some("gpt".into());
    assert!(select(&catalog(), &fresh_context(), &request).unwrap().fast);
    let settings = select(
        &catalog(),
        &thread_context("gpt", "xhigh", true),
        &run_request(),
    )
    .unwrap();
    assert_eq!(settings.model, "gpt");
    assert!(settings.fast);
}

#[test]
fn fast_mode_requires_model_support() {
    let mut request = run_request();
    request.model = Some("pro".into());
    request.fast = Some(true);
    assert!(select(&catalog(), &fresh_context(), &request).is_err());
    assert!(
        select(
            &catalog(),
            &thread_context("pro", "max", true),
            &run_request()
        )
        .is_err()
    );
    request.fast = Some(false);
    let settings = select(&catalog(), &thread_context("pro", "max", true), &request).unwrap();
    assert!(!settings.fast);
}

#[test]
fn model_override_uses_the_selected_models_reasoning_default() {
    let mut request = run_request();
    request.model = Some("pro".into());
    let settings = select(
        &catalog(),
        &thread_context("default", "high", false),
        &request,
    )
    .unwrap();

    assert_eq!(settings.model, "pro");
    assert_eq!(settings.reasoning, "max");
}
