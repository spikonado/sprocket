use super::*;

fn catalog() -> ProviderCatalog {
    serde_json::from_value(serde_json::json!({
        "defaultModelId": "default",
        "defaultFast": false,
        "models": [
            {"id": "default", "label": "Default", "vendor": "openai", "supportsImages": false, "reasoningEfforts": ["medium", "high"],
             "defaultReasoningEffort": "high", "serviceTiers": ["standard", "fast"]},
            {"id": "pro", "label": "Pro", "vendor": "openai", "supportsImages": false, "reasoningEfforts": ["max"],
             "defaultReasoningEffort": "max", "serviceTiers": ["standard"]}
        ]
    }))
    .expect("catalog")
}

#[test]
fn omitted_values_resolve_to_provider_compatible_defaults() {
    let resolved =
        resolve_subagent_settings(&catalog(), &SubagentSettingsOverrides::default()).unwrap();
    assert_eq!(resolved.model, "default");
    assert_eq!(resolved.reasoning, "high");
    assert!(!resolved.fast);
}

#[test]
fn model_override_without_reasoning_uses_the_new_models_default() {
    let overrides = SubagentSettingsOverrides {
        model: Some("pro".into()),
        ..Default::default()
    };
    let resolved = resolve_subagent_settings(&catalog(), &overrides).unwrap();
    assert_eq!(resolved.reasoning, "max");
    assert!(!resolved.fast);
}

#[test]
fn retained_fast_is_turned_off_when_the_model_cannot_support_it() {
    let mut catalog = catalog();
    catalog.default_fast = true;
    let overrides = SubagentSettingsOverrides {
        model: Some("pro".into()),
        ..Default::default()
    };
    let resolved = resolve_subagent_settings(&catalog, &overrides).unwrap();
    assert!(!resolved.fast);
}

#[test]
fn explicit_unsupported_choices_fail_clearly() {
    let unknown_model = SubagentSettingsOverrides {
        model: Some("missing".into()),
        ..Default::default()
    };
    assert!(resolve_subagent_settings(&catalog(), &unknown_model).is_err());

    let bad_reasoning = SubagentSettingsOverrides {
        reasoning: Some("low".into()),
        ..Default::default()
    };
    let error = resolve_subagent_settings(&catalog(), &bad_reasoning).unwrap_err();
    assert!(error.to_string().contains("reasoning level low"));

    let bad_fast = SubagentSettingsOverrides {
        model: Some("pro".into()),
        fast: Some(true),
        ..Default::default()
    };
    let error = resolve_subagent_settings(&catalog(), &bad_fast).unwrap_err();
    assert!(error.to_string().contains("fast mode is unavailable"));
}

#[test]
fn explicit_fast_on_a_fast_capable_model_is_kept() {
    let overrides = SubagentSettingsOverrides {
        fast: Some(true),
        ..Default::default()
    };
    let resolved = resolve_subagent_settings(&catalog(), &overrides).unwrap();
    assert!(resolved.fast);
}

fn saved_settings() -> SubagentSettings {
    SubagentSettings {
        model: "default".into(),
        reasoning: "high".into(),
        fast: true,
        completion_provider: CompletionProvider::Spikonado,
    }
}

#[test]
fn follow_up_retains_the_saved_settings() {
    let saved = SubagentSettings {
        reasoning: "medium".into(),
        ..saved_settings()
    };
    let resolved = resolve_settings_for_target(&catalog(), &saved, &Default::default()).unwrap();
    assert_eq!(
        resolved,
        ResolvedSubagentSettings {
            model: "default".into(),
            reasoning: "medium".into(),
            fast: true,
        }
    );
}

#[test]
fn follow_up_model_change_without_reasoning_uses_the_new_models_default() {
    let overrides = SubagentSettingsOverrides {
        model: Some("pro".into()),
        ..Default::default()
    };
    let resolved = resolve_settings_for_target(&catalog(), &saved_settings(), &overrides).unwrap();
    assert_eq!(resolved.reasoning, "max");
    assert!(!resolved.fast);
}

#[test]
fn follow_up_retained_fast_survives_when_the_new_model_supports_it() {
    let resolved = resolve_settings_for_target(
        &catalog(),
        &SubagentSettings {
            model: "pro".into(),
            reasoning: "max".into(),
            ..saved_settings()
        },
        &SubagentSettingsOverrides {
            model: Some("default".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(
        resolved,
        ResolvedSubagentSettings {
            model: "default".into(),
            reasoning: "high".into(),
            fast: true,
        }
    );
}

#[test]
fn follow_up_keeps_retained_reasoning_when_the_model_does_not_change() {
    let overrides = SubagentSettingsOverrides {
        reasoning: Some("medium".into()),
        ..Default::default()
    };
    let resolved = resolve_settings_for_target(&catalog(), &saved_settings(), &overrides).unwrap();
    assert_eq!(resolved.model, "default");
    assert_eq!(resolved.reasoning, "medium");
}
