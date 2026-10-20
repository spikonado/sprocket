use super::*;

fn catalog_payload() -> GatewayModelsResponse {
    serde_json::from_value(serde_json::json!({
        "sprocket": {
            "protocolVersion": 1,
            "defaultModelId": "vision-model",
            "defaultServiceTier": "standard",
            "models": [
                {
                    "id": "vision-model",
                    "label": "Vision Model",
                    "provider": "openai",
                    "reasoningEfforts": ["medium", "high"],
                    "defaultReasoningEffort": "high",
                    "serviceTiers": ["standard", "fast"],
                    "supportsImages": true,
                    "supportsRequiredToolChoice": true,
                    "contextWindowTokens": 100000,
                    "autoCompactTokenLimit": 80000,
                    "directApiPricing": {
                        "input": 2,
                        "cacheRead": 0.1,
                        "cacheWrite": 2.5,
                        "output": 10,
                        "fastMultiplier": 2,
                        "longContext": {
                            "thresholdInputTokens": 272000,
                            "inputMultiplier": 2,
                            "outputMultiplier": 1.5
                        }
                    }
                },
                {
                    "id": "long-context-model",
                    "label": "Long Context Model",
                    "provider": "other",
                    "reasoningEfforts": ["none"],
                    "defaultReasoningEffort": "none",
                    "serviceTiers": ["standard"],
                    "supportsImages": false,
                    "contextWindowTokens": 1000000,
                    "autoCompactTokenLimit": 900000
                }
            ]
        }
    }))
    .expect("catalog payload")
}

#[test]
fn reports_selected_model_metadata_from_one_payload() {
    let vision =
        select_catalog_model(&catalog_payload().sprocket, "vision-model").expect("vision model");
    assert!(vision.supports_images);
    assert!(vision.supports_required_tool_choice);
    assert_eq!(vision.label, "Vision Model");
    assert_eq!(vision.vendor, "openai");
    assert_eq!(vision.context_budget.context_window_tokens, 100_000);
    assert_eq!(vision.context_budget.auto_handoff_token_limit, 80_000);
    assert_eq!(vision.long_context_threshold_tokens, Some(272_000));

    let long_context = select_catalog_model(&catalog_payload().sprocket, "long-context-model")
        .expect("long-context model");
    assert!(!long_context.supports_images);
    assert_eq!(long_context.vendor, "other");
    assert!(!long_context.supports_required_tool_choice);
    assert_eq!(long_context.context_budget.context_window_tokens, 1_000_000);
    assert_eq!(long_context.long_context_threshold_tokens, None);
}

#[test]
fn missing_catalog_model_is_an_error() {
    let error = select_catalog_model(&catalog_payload().sprocket, "no-such-model")
        .expect_err("unknown model")
        .to_string();
    assert!(error.contains("no-such-model"));
}

#[test]
fn removed_handoff_model_uses_an_available_model_on_the_previous_provider() {
    for provider in [
        CompletionProvider::Spikonado,
        CompletionProvider::Chatgpt,
        CompletionProvider::Openai,
    ] {
        let (handoff, capabilities) = select_handoff_model(
            &catalog_payload().sprocket,
            ProviderHandoff {
                completion_provider: provider,
                selected_model: "retired-model".to_string(),
                reasoning_effort: "max".to_string(),
                fast_mode: true,
            },
            provider,
            "openai",
        )
        .expect("available handoff fallback")
        .expect("unknown historical vendor requires a handoff");
        assert_eq!(handoff.completion_provider, provider);
        assert_eq!(handoff.selected_model, "vision-model");
        assert_eq!(handoff.reasoning_effort, "high");
        assert_eq!(capabilities.vendor, "openai");
    }
}

#[test]
fn removed_handoff_model_filters_the_default_for_the_previous_provider() {
    for provider in [
        CompletionProvider::Spikonado,
        CompletionProvider::Chatgpt,
        CompletionProvider::Openai,
    ] {
        let mut catalog = catalog_payload().sprocket;
        catalog.default_model_id = "long-context-model".to_string();
        let (handoff, capabilities) = select_handoff_model(
            &catalog,
            ProviderHandoff {
                completion_provider: provider,
                selected_model: "retired-model".to_string(),
                reasoning_effort: "high".to_string(),
                fast_mode: true,
            },
            provider,
            "other",
        )
        .expect("provider-compatible handoff fallback")
        .expect("unknown historical vendor requires a handoff");
        assert_eq!(handoff.completion_provider, provider);
        if provider == CompletionProvider::Spikonado {
            assert_eq!(handoff.selected_model, "long-context-model");
            assert_eq!(handoff.reasoning_effort, "none");
            assert!(!handoff.fast_mode);
            assert_eq!(capabilities.vendor, "other");
        } else {
            assert_eq!(handoff.selected_model, "vision-model");
            assert_eq!(handoff.reasoning_effort, "high");
            assert!(handoff.fast_mode);
            assert_eq!(capabilities.vendor, "openai");
        }
    }
}

#[test]
fn listed_handoff_model_keeps_its_settings_when_the_vendor_changes() {
    let (handoff, capabilities) = select_handoff_model(
        &catalog_payload().sprocket,
        ProviderHandoff {
            completion_provider: CompletionProvider::Spikonado,
            selected_model: "long-context-model".to_string(),
            reasoning_effort: "none".to_string(),
            fast_mode: false,
        },
        CompletionProvider::Spikonado,
        "openai",
    )
    .expect("original handoff model")
    .expect("vendor change requires a handoff");
    assert_eq!(handoff.selected_model, "long-context-model");
    assert_eq!(handoff.reasoning_effort, "none");
    assert!(!handoff.fast_mode);
    assert_eq!(capabilities.vendor, "other");
}

#[test]
fn same_vendor_keeps_history_only_on_the_same_provider() {
    for target_provider in [CompletionProvider::Spikonado, CompletionProvider::Openai] {
        let handoff = select_handoff_model(
            &catalog_payload().sprocket,
            ProviderHandoff {
                completion_provider: CompletionProvider::Spikonado,
                selected_model: "vision-model".to_string(),
                reasoning_effort: "medium".to_string(),
                fast_mode: true,
            },
            target_provider,
            "openai",
        )
        .expect("listed source model");
        assert_eq!(
            handoff.is_some(),
            target_provider != CompletionProvider::Spikonado
        );
    }
}
