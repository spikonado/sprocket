use std::time::Duration;

use anyhow::{Context, anyhow};
use serde::{Deserialize, Serialize};

use crate::types::{
    CatalogModelCapabilities, CompletionProvider, ContextBudget, ProviderHandoff, RunSnapshot,
    gateway_api_v1_url,
};

const GATEWAY_PROTOCOL_VERSION: u64 = 1;
const CATALOG_TIMEOUT: Duration = Duration::from_secs(15);

fn catalog_client(gateway_url: &str) -> anyhow::Result<reqwest::Client> {
    let mut builder = reqwest::Client::builder().timeout(CATALOG_TIMEOUT);
    if let Some(host) = reqwest::Url::parse(gateway_url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned))
    {
        builder = builder.retry(reqwest::retry::for_host(host).classify_fn(|req_rep| {
            if *req_rep.method() != reqwest::Method::GET {
                return req_rep.success();
            }
            if req_rep.error().is_some() {
                return req_rep.retryable();
            }
            match req_rep.status().map(|status| status.as_u16()) {
                Some(429 | 502 | 503 | 504) => req_rep.retryable(),
                _ => req_rep.success(),
            }
        }));
    }
    builder
        .build()
        .context("failed to build AI gateway catalog HTTP client")
}

#[derive(Debug, serde::Deserialize)]
struct GatewayModelsResponse {
    sprocket: GatewaySprocketCatalog,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GatewaySprocketCatalog {
    protocol_version: u64,
    default_model_id: String,
    default_service_tier: String,
    models: Vec<GatewayCatalogModel>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GatewayCatalogModel {
    id: String,
    label: String,
    provider: String,
    supports_images: bool,
    #[serde(default)]
    supports_required_tool_choice: bool,
    reasoning_efforts: Vec<String>,
    default_reasoning_effort: String,
    service_tiers: Vec<String>,
    context_window_tokens: u64,
    #[serde(rename = "autoCompactTokenLimit")]
    auto_handoff_token_limit: u64,
}

/// The live gateway catalog entries for one completion provider, matching the
/// UI's provider filter (`spikonado` sees every model; `openai`/`chatgpt` see
/// only models whose catalog vendor is `openai`).
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCatalog {
    pub default_model_id: String,
    pub default_fast: bool,
    pub models: Vec<ProviderCatalogModel>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCatalogModel {
    pub id: String,
    pub label: String,
    pub supports_images: bool,
    pub reasoning_efforts: Vec<String>,
    pub default_reasoning_effort: String,
    pub service_tiers: Vec<String>,
}

impl ProviderCatalogModel {
    pub fn supports_fast(&self) -> bool {
        self.service_tiers.iter().any(|tier| tier == "fast")
    }
}

async fn fetch_catalog(gateway_url: &str) -> anyhow::Result<GatewaySprocketCatalog> {
    let url = format!("{}/models", gateway_api_v1_url(gateway_url));
    let response = catalog_client(gateway_url)?
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .context("failed to fetch AI gateway catalog")?;
    if !response.status().is_success() {
        anyhow::bail!("AI gateway catalog returned {}", response.status());
    }
    let payload: GatewayModelsResponse = response
        .json()
        .await
        .context("AI gateway catalog was not valid JSON")?;
    if payload.sprocket.protocol_version != GATEWAY_PROTOCOL_VERSION {
        anyhow::bail!(
            "unsupported AI gateway protocol version {}",
            payload.sprocket.protocol_version
        );
    }
    Ok(payload.sprocket)
}

/// Fetch the full provider-compatible catalog with defaults. The default
/// model follows the UI fallback: the catalog default when compatible,
/// otherwise the first compatible model.
pub async fn catalog_for_provider(
    gateway_url: &str,
    provider: CompletionProvider,
) -> anyhow::Result<ProviderCatalog> {
    let catalog = fetch_catalog(gateway_url).await?;
    let models: Vec<ProviderCatalogModel> = catalog
        .models
        .into_iter()
        .filter(|model| provider == CompletionProvider::Spikonado || model.provider == "openai")
        .map(|model| ProviderCatalogModel {
            id: model.id,
            label: model.label,
            supports_images: model.supports_images,
            reasoning_efforts: model.reasoning_efforts,
            default_reasoning_effort: model.default_reasoning_effort,
            service_tiers: model.service_tiers,
        })
        .collect();
    let default_model_id = if models
        .iter()
        .any(|model| model.id == catalog.default_model_id)
    {
        catalog.default_model_id
    } else {
        models
            .first()
            .map(|model| model.id.clone())
            .ok_or_else(|| anyhow!("no models are available for the current completion provider"))?
    };
    Ok(ProviderCatalog {
        default_model_id,
        default_fast: catalog.default_service_tier == "fast",
        models,
    })
}

fn select_catalog_model(
    catalog: &GatewaySprocketCatalog,
    model_id: &str,
) -> anyhow::Result<CatalogModelCapabilities> {
    let model = catalog
        .models
        .iter()
        .find(|model| model.id == model_id)
        .ok_or_else(|| anyhow!("model {model_id} is not in the AI gateway catalog"))?;
    Ok(CatalogModelCapabilities {
        label: model.label.clone(),
        vendor: model.provider.clone(),
        context_budget: ContextBudget {
            context_window_tokens: model.context_window_tokens,
            auto_handoff_token_limit: model.auto_handoff_token_limit,
        },
        supports_images: model.supports_images,
        supports_required_tool_choice: model.supports_required_tool_choice,
    })
}

pub(crate) async fn catalog_models_for_run(
    gateway_url: &str,
    run: &RunSnapshot,
    handoff: Option<ProviderHandoff>,
) -> anyhow::Result<(
    CatalogModelCapabilities,
    anyhow::Result<Option<(ProviderHandoff, CatalogModelCapabilities)>>,
)> {
    let catalog = fetch_catalog(gateway_url).await?;
    let selected = select_catalog_model(&catalog, &run.selected_model)?;
    let handoff = match handoff {
        Some(handoff) => {
            select_handoff_model(&catalog, handoff, run.completion_provider, &selected.vendor)
        }
        None => Ok(None),
    };
    Ok((selected, handoff))
}

fn select_handoff_model(
    catalog: &GatewaySprocketCatalog,
    mut handoff: ProviderHandoff,
    target_provider: CompletionProvider,
    target_vendor: &str,
) -> anyhow::Result<Option<(ProviderHandoff, CatalogModelCapabilities)>> {
    let removed = !catalog
        .models
        .iter()
        .any(|model| model.id == handoff.selected_model);
    if removed {
        let eligible = |model: &&GatewayCatalogModel| {
            handoff.completion_provider == CompletionProvider::Spikonado
                || model.provider == "openai"
        };
        let model = catalog
            .models
            .iter()
            .filter(eligible)
            .find(|model| model.id == catalog.default_model_id)
            .or_else(|| catalog.models.iter().find(eligible))
            .ok_or_else(|| {
                anyhow!("no models are available for the previous completion provider")
            })?;
        handoff.selected_model = model.id.clone();
        if !model.reasoning_efforts.contains(&handoff.reasoning_effort) {
            handoff.reasoning_effort = model.default_reasoning_effort.clone();
        }
        handoff.fast_mode &= model.service_tiers.iter().any(|tier| tier == "fast");
    }
    let capabilities = select_catalog_model(catalog, &handoff.selected_model)?;
    // A fallback cannot establish the historical vendor, so summarize instead of replaying it.
    Ok((removed
        || handoff.completion_provider != target_provider
        || capabilities.vendor != target_vendor)
        .then_some((handoff, capabilities)))
}

#[cfg(test)]
mod tests {
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
                        "autoCompactTokenLimit": 80000
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
        let vision = select_catalog_model(&catalog_payload().sprocket, "vision-model")
            .expect("vision model");
        assert!(vision.supports_images);
        assert!(vision.supports_required_tool_choice);
        assert_eq!(vision.label, "Vision Model");
        assert_eq!(vision.vendor, "openai");
        assert_eq!(vision.context_budget.context_window_tokens, 100_000);
        assert_eq!(vision.context_budget.auto_handoff_token_limit, 80_000);

        let long_context = select_catalog_model(&catalog_payload().sprocket, "long-context-model")
            .expect("long-context model");
        assert!(!long_context.supports_images);
        assert_eq!(long_context.vendor, "other");
        assert!(!long_context.supports_required_tool_choice);
        assert_eq!(long_context.context_budget.context_window_tokens, 1_000_000);
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
}
