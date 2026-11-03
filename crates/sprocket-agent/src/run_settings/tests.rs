use super::*;
use crate::types::CompletionProvider::{Chatgpt, Spikonado};

fn catalog() -> ModelCatalog {
    serde_json::from_value(serde_json::json!({
        "defaultModelId": "default",
        "models": [
            {"id": "default", "label": "Default", "vendor": "anthropic", "supportsImages": true, "reasoningEfforts": ["medium", "high"], "defaultReasoningEffort": "high", "serviceTiers": ["standard", "fast"]},
            {"id": "pro", "label": "Pro", "vendor": "anthropic", "supportsImages": true, "reasoningEfforts": ["max"], "defaultReasoningEffort": "max", "serviceTiers": ["standard"]},
            {"id": "gpt", "label": "GPT", "vendor": "openai", "supportsImages": true, "reasoningEfforts": ["low", "xhigh"], "defaultReasoningEffort": "xhigh", "serviceTiers": ["standard", "fast"]}
        ]
    }))
    .unwrap()
}

fn saved(model: &str, reasoning: &str, fast: bool) -> ModelSettings {
    ModelSettings {
        model: model.into(),
        reasoning: reasoning.into(),
        fast,
    }
}

fn resolve(
    providers: &[CompletionProvider],
    saved: Option<ModelSettings>,
    overrides: SettingsOverrides,
) -> anyhow::Result<ResolvedSettings> {
    resolve_settings(&catalog(), providers, saved.as_ref(), &overrides)
}

fn model(id: &str) -> SettingsOverrides {
    SettingsOverrides {
        model: Some(id.into()),
        ..Default::default()
    }
}

#[test]
fn new_threads_use_the_catalog_default_on_the_first_serving_provider() {
    let resolved = resolve(&[Spikonado], None, Default::default()).unwrap();
    assert_eq!(
        resolved,
        ResolvedSettings {
            model: "default".into(),
            reasoning: "high".into(),
            fast: false,
            provider: Spikonado,
        }
    );
    assert_eq!(
        resolve(&[Chatgpt, Spikonado], None, model("gpt"))
            .unwrap()
            .provider,
        Chatgpt
    );
    assert_eq!(
        resolve(&[Chatgpt, Spikonado], None, model("default"))
            .unwrap()
            .provider,
        Spikonado
    );
}

#[test]
fn follow_ups_keep_saved_settings() {
    let resolved = resolve(
        &[Spikonado],
        Some(saved("default", "medium", true)),
        Default::default(),
    );
    assert_eq!(
        resolved.unwrap(),
        ResolvedSettings {
            model: "default".into(),
            reasoning: "medium".into(),
            fast: true,
            provider: Spikonado,
        }
    );
}

#[test]
fn a_model_change_resets_reasoning_and_keeps_supported_fast() {
    let resolved = resolve(
        &[Spikonado],
        Some(saved("default", "medium", true)),
        model("gpt"),
    );
    let resolved = resolved.unwrap();
    assert_eq!(resolved.reasoning, "xhigh");
    assert!(resolved.fast);
}

#[test]
fn unsupported_saved_settings_fall_back_quietly() {
    let removed = resolve(
        &[Spikonado],
        Some(saved("removed", "max", true)),
        Default::default(),
    );
    let removed = removed.unwrap();
    assert_eq!(
        (removed.model.as_str(), removed.reasoning.as_str()),
        ("default", "high")
    );
    assert!(!removed.fast);

    let no_fast_model = resolve(
        &[Spikonado],
        Some(saved("pro", "max", true)),
        Default::default(),
    );
    assert!(!no_fast_model.unwrap().fast);

    let stale_reasoning = resolve(
        &[Spikonado],
        Some(saved("pro", "low", false)),
        Default::default(),
    );
    assert_eq!(stale_reasoning.unwrap().reasoning, "max");
}

#[test]
fn unsupported_explicit_choices_fail() {
    assert!(resolve(&[Spikonado], None, model("missing")).is_err());
    let unserved = resolve(&[Chatgpt], None, model("default")).unwrap_err();
    assert!(
        unserved
            .to_string()
            .contains("no enabled provider offers default")
    );

    let reasoning = SettingsOverrides {
        reasoning: Some("low".into()),
        ..Default::default()
    };
    assert!(resolve(&[Spikonado], None, reasoning).is_err());

    let fast = |model: &str| SettingsOverrides {
        model: Some(model.into()),
        fast: Some(true),
        ..Default::default()
    };
    assert!(resolve(&[Spikonado], None, fast("pro")).is_err());
    assert!(resolve(&[Spikonado], None, fast("gpt")).unwrap().fast);
}
