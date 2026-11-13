use super::*;
use crate::types::CompletionProvider::{Anthropic, Chatgpt, Openrouter, Spikonado, Vercel};

fn catalog() -> ModelCatalog {
    let mut catalog: ModelCatalog = serde_json::from_value(serde_json::json!({
        "defaultModelId": "default",
        "models": [
            {"id": "default", "label": "Default", "provider": "anthropic", "reasoningEfforts": ["medium", "high"], "defaultReasoningEffort": "high", "serviceTiers": ["standard", "fast"]},
            {"id": "pro", "label": "Pro", "provider": "anthropic", "reasoningEfforts": ["max"], "defaultReasoningEffort": "max", "serviceTiers": ["standard"]},
            {"id": "gpt", "label": "GPT", "provider": "openai", "reasoningEfforts": ["low", "xhigh"], "defaultReasoningEffort": "xhigh", "serviceTiers": ["standard", "fast"]}
        ]
    }))
    .unwrap();
    catalog.models[0].route.provider_model_ids = [
        ("anthropic", "claude-default".to_string()),
        ("openrouter", "anthropic/default".to_string()),
    ]
    .into();
    catalog
}

fn saved(model: &str, reasoning: &str, fast: bool) -> ModelSettings {
    ModelSettings {
        model: model.into(),
        reasoning: reasoning.into(),
        service_tier: ServiceTier::from_legacy(None, fast),
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
            service_tier: ServiceTier::Standard,
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
    assert_eq!(
        resolve(&[Vercel, Openrouter], None, model("default"))
            .unwrap()
            .provider,
        Openrouter
    );
    assert_eq!(
        resolve(&[Anthropic, Spikonado], None, model("gpt"))
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
            service_tier: ServiceTier::Fast,
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
    assert_eq!(resolved.service_tier, ServiceTier::Fast);
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
    assert_eq!(removed.service_tier, ServiceTier::Standard);

    let no_fast_model = resolve(
        &[Spikonado],
        Some(saved("pro", "max", true)),
        Default::default(),
    );
    assert_eq!(no_fast_model.unwrap().service_tier, ServiceTier::Standard);

    let stale_reasoning = resolve(
        &[Spikonado],
        Some(saved("pro", "low", false)),
        Default::default(),
    );
    assert_eq!(stale_reasoning.unwrap().reasoning, "max");
}

#[test]
fn unsupported_explicit_choices_fail() {
    let missing = resolve(&[Spikonado], None, model("missing")).unwrap_err();
    assert!(
        missing
            .to_string()
            .ends_with("choose one of: default, pro, gpt")
    );
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
    let reasoning = resolve(&[Spikonado], None, reasoning).unwrap_err();
    assert!(
        reasoning
            .to_string()
            .ends_with("choose one of: medium, high")
    );

    let fast = |model: &str| SettingsOverrides {
        model: Some(model.into()),
        service_tier: Some(ServiceTier::Fast),
        ..Default::default()
    };
    assert!(resolve(&[Spikonado], None, fast("pro")).is_err());
    assert_eq!(
        resolve(&[Anthropic], None, fast("default"))
            .unwrap()
            .service_tier,
        ServiceTier::Fast
    );
    assert_eq!(
        resolve(&[Spikonado], None, fast("gpt"))
            .unwrap()
            .service_tier,
        ServiceTier::Fast
    );
}

#[test]
fn ultrafast_follows_the_catalog_on_any_provider() {
    let mut catalog = catalog();
    let overrides = SettingsOverrides {
        model: Some("gpt".into()),
        service_tier: Some(ServiceTier::Ultrafast),
        ..Default::default()
    };
    assert!(resolve_settings(&catalog, &[Spikonado], None, &overrides).is_err());
    catalog.models[2].byok_service_tiers = vec!["ultrafast".into()];
    let resolved = resolve_settings(&catalog, &[Spikonado], None, &overrides).unwrap();
    assert_eq!(
        (resolved.provider, resolved.service_tier),
        (Spikonado, ServiceTier::Ultrafast)
    );
    let saved = ModelSettings {
        model: "gpt".into(),
        reasoning: "low".into(),
        service_tier: ServiceTier::Ultrafast,
    };
    assert_eq!(
        resolve_settings(
            &catalog,
            &[Chatgpt],
            Some(&saved),
            &SettingsOverrides::default()
        )
        .unwrap()
        .service_tier,
        ServiceTier::Ultrafast
    );
}
