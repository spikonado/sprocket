use super::*;

fn catalog() -> Catalog {
    serde_json::from_value(serde_json::json!({
        "protocolVersion": 1, "defaultModelId": "default", "defaultReasoningEffort": "high",
        "models": [
            {"id": "default", "label": "Default", "reasoningEfforts": ["medium", "high"], "defaultReasoningEffort": "high", "serviceTiers": ["standard", "fast"]},
            {"id": "pro", "label": "Pro", "reasoningEfforts": ["max"], "defaultReasoningEffort": "max", "serviceTiers": ["standard"]},
            {"id": "pro-fast", "label": "Pro Fast", "reasoningEfforts": ["xhigh"], "defaultReasoningEffort": "xhigh", "serviceTiers": ["standard", "fast"]}
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
        thread: None,
    }
}

fn thread_context(selected_model: &str, reasoning_effort: &str, fast_mode: bool) -> RunContext {
    RunContext {
        gateway_url: String::new(),
        thread: Some(thread_settings(selected_model, reasoning_effort, fast_mode)),
    }
}

fn thread_settings(
    selected_model: &str,
    reasoning_effort: &str,
    fast_mode: bool,
) -> ThreadSettings {
    ThreadSettings {
        repository_key: "repo".into(),
        selected_model: selected_model.into(),
        reasoning_effort: reasoning_effort.into(),
        fast_mode,
    }
}

#[test]
fn defaults_do_not_enable_fast_and_invalid_overrides_never_fall_back() {
    let context = fresh_context();
    let mut request = run_request();
    assert!(!select(catalog(), &context, &request).unwrap().fast);
    request.model = Some("missing".into());
    assert!(select(catalog(), &context, &request).is_err());
    request.model = None;
    request.reasoning = Some("unsupported".into());
    assert!(select(catalog(), &context, &request).is_err());
}

#[test]
fn lists_the_full_catalog_with_the_gateway_default() {
    let response = list_models(&catalog()).unwrap();
    assert_eq!(response.default_model_id, "default");
    assert_eq!(
        response.models,
        [
            CliModel {
                id: "default".into(),
                label: "Default".into(),
                reasoning_efforts: vec!["medium".into(), "high".into()],
                default_reasoning_effort: "high".into(),
            },
            CliModel {
                id: "pro".into(),
                label: "Pro".into(),
                reasoning_efforts: vec!["max".into()],
                default_reasoning_effort: "max".into(),
            },
            CliModel {
                id: "pro-fast".into(),
                label: "Pro Fast".into(),
                reasoning_efforts: vec!["xhigh".into()],
                default_reasoning_effort: "xhigh".into(),
            }
        ]
    );
}

#[test]
fn selects_and_inherits_formerly_locked_models() {
    let mut request = run_request();
    request.model = Some("pro".into());
    let settings = select(catalog(), &fresh_context(), &request).unwrap();
    assert_eq!(settings.model, "pro");
    assert_eq!(settings.reasoning, "max");

    let settings = select(
        catalog(),
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
        catalog,
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
    let settings = select(catalog(), &context, &request).unwrap();
    assert_eq!(settings.model, "default");
    assert_eq!(settings.reasoning, "medium");
    assert!(settings.fast);

    request.model = Some("removed".into());
    assert!(select(catalog(), &context, &request).is_err());
}

#[test]
fn selects_and_inherits_fast_mode_on_supported_models() {
    let mut request = run_request();
    request.fast = Some(true);
    assert!(select(catalog(), &fresh_context(), &request).unwrap().fast);
    request.model = Some("pro-fast".into());
    assert!(select(catalog(), &fresh_context(), &request).unwrap().fast);
    let settings = select(
        catalog(),
        &thread_context("pro-fast", "xhigh", true),
        &run_request(),
    )
    .unwrap();
    assert_eq!(settings.model, "pro-fast");
    assert!(settings.fast);
}

#[test]
fn fast_mode_requires_model_support() {
    let mut request = run_request();
    request.model = Some("pro".into());
    request.fast = Some(true);
    assert!(select(catalog(), &fresh_context(), &request).is_err());
    assert!(
        select(
            catalog(),
            &thread_context("pro", "max", true),
            &run_request()
        )
        .is_err()
    );
    request.fast = Some(false);
    let settings = select(catalog(), &thread_context("pro", "max", true), &request).unwrap();
    assert!(!settings.fast);
}

#[test]
fn model_override_uses_the_selected_models_reasoning_default() {
    let settings = select(
        catalog(),
        &RunContext {
            gateway_url: String::new(),
            thread: Some(thread_settings("default", "high", false)),
        },
        &CliRunRequest {
            client_id: "client".into(),
            prompt: "task".into(),
            directory: "/tmp".into(),
            thread_id: Some("thread".into()),
            model: Some("pro".into()),
            reasoning: None,
            fast: None,
        },
    )
    .unwrap();

    assert_eq!(settings.model, "pro");
    assert_eq!(settings.reasoning, "max");
}

#[test]
fn catalog_default_model_must_exist() {
    let catalog: Catalog = serde_json::from_value(serde_json::json!({
        "protocolVersion": 1, "defaultModelId": "missing", "defaultReasoningEffort": "high",
        "models": [
            {"id": "default", "label": "Default", "reasoningEfforts": ["high"], "defaultReasoningEffort": "high", "serviceTiers": ["standard"]}
        ]
    }))
    .unwrap();

    assert!(list_models(&catalog).is_err());
    assert!(select(catalog, &fresh_context(), &run_request()).is_err());
}
