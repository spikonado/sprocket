use std::time::Duration;

use anyhow::{Context, anyhow};
use serde::Deserialize;

use crate::types::{
    CatalogModelCapabilities, CompletionProvider, ContextBudget, ModelRoute, ProviderHandoff,
    RunSnapshot, UsagePricing, gateway_api_v1_url,
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
    models: Vec<GatewayCatalogModel>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GatewayCatalogModel {
    id: String,
    label: String,
    #[serde(flatten)]
    route: ModelRoute,
    supports_images: bool,
    reasoning_efforts: Vec<String>,
    default_reasoning_effort: String,
    service_tiers: Vec<String>,
    context_window_tokens: u64,
    #[serde(rename = "autoCompactTokenLimit")]
    auto_handoff_token_limit: u64,
    #[serde(default)]
    cache_write_ttl: Option<String>,
    #[serde(default)]
    direct_api_pricing: Option<GatewayDirectApiPricing>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GatewayDirectApiPricing {
    long_context: Option<GatewayLongContextPricing>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GatewayLongContextPricing {
    threshold_input_tokens: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelCatalog {
    pub default_model_id: String,
    pub models: Vec<CatalogModel>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogModel {
    pub id: String,
    pub label: String,
    #[serde(flatten)]
    pub route: ModelRoute,
    pub reasoning_efforts: Vec<String>,
    pub default_reasoning_effort: String,
    pub service_tiers: Vec<String>,
}

impl CatalogModel {
    pub fn supports_fast(&self) -> bool {
        lists_fast_tier(&self.service_tiers)
    }
}

fn lists_fast_tier(service_tiers: &[String]) -> bool {
    service_tiers.iter().any(|tier| tier == "fast")
}

pub(crate) struct SubagentModelChoice {
    pub(crate) id: String,
    pub(crate) reasoning_efforts: Vec<String>,
    pub(crate) fast: bool,
}

fn subagent_model_choices(catalog: &GatewaySprocketCatalog) -> Vec<SubagentModelChoice> {
    catalog
        .models
        .iter()
        .map(|model| SubagentModelChoice {
            id: model.id.clone(),
            reasoning_efforts: model.reasoning_efforts.clone(),
            fast: lists_fast_tier(&model.service_tiers),
        })
        .collect()
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
    let mut payload: GatewayModelsResponse = response
        .json()
        .await
        .context("AI gateway catalog was not valid JSON")?;
    if payload.sprocket.protocol_version != GATEWAY_PROTOCOL_VERSION {
        anyhow::bail!(
            "unsupported AI gateway protocol version {}",
            payload.sprocket.protocol_version
        );
    }
    crate::models_dev::resolve(
        payload
            .sprocket
            .models
            .iter_mut()
            .map(|model| &mut model.route),
    )
    .await;
    Ok(payload.sprocket)
}

pub async fn model_catalog(gateway_url: &str) -> anyhow::Result<ModelCatalog> {
    let catalog = fetch_catalog(gateway_url).await?;
    Ok(ModelCatalog {
        default_model_id: catalog.default_model_id,
        models: catalog
            .models
            .into_iter()
            .map(|model| CatalogModel {
                id: model.id,
                label: model.label,
                route: model.route,
                reasoning_efforts: model.reasoning_efforts,
                default_reasoning_effort: model.default_reasoning_effort,
                service_tiers: model.service_tiers,
            })
            .collect(),
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
        route: model.route.clone(),
        context_budget: ContextBudget {
            context_window_tokens: model.context_window_tokens,
            auto_handoff_token_limit: model.auto_handoff_token_limit,
        },
        supports_images: model.supports_images,
        supports_fast: lists_fast_tier(&model.service_tiers),
        usage_pricing: UsagePricing {
            long_context_threshold_tokens: model
                .direct_api_pricing
                .as_ref()
                .and_then(|pricing| pricing.long_context.as_ref())
                .map(|long_context| long_context.threshold_input_tokens),
            cache_write_ttl: model.cache_write_ttl.clone(),
        },
    })
}

pub(crate) async fn catalog_models_for_run(
    gateway_url: &str,
    run: &RunSnapshot,
    handoff: Option<ProviderHandoff>,
) -> anyhow::Result<(
    CatalogModelCapabilities,
    anyhow::Result<Option<(ProviderHandoff, CatalogModelCapabilities)>>,
    Vec<SubagentModelChoice>,
)> {
    let catalog = fetch_catalog(gateway_url).await?;
    let selected = select_catalog_model(&catalog, &run.selected_model)?;
    let handoff = match handoff {
        Some(handoff) => select_handoff_model(
            &catalog,
            handoff,
            run.completion_provider,
            &selected.route.vendor,
        ),
        None => Ok(None),
    };
    Ok((selected, handoff, subagent_model_choices(&catalog)))
}

fn select_handoff_model(
    catalog: &GatewaySprocketCatalog,
    mut handoff: ProviderHandoff,
    target_provider: CompletionProvider,
    target_vendor: &str,
) -> anyhow::Result<Option<(ProviderHandoff, CatalogModelCapabilities)>> {
    let replaced_by_fallback = !catalog
        .models
        .iter()
        .any(|model| model.id == handoff.selected_model);
    if replaced_by_fallback {
        let eligible =
            |model: &&GatewayCatalogModel| handoff.completion_provider.serves(&model.route);
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
    }
    let capabilities = select_catalog_model(catalog, &handoff.selected_model)?;
    handoff.fast_mode &= capabilities.supports_fast;
    Ok((replaced_by_fallback
        || handoff.completion_provider != target_provider
        || capabilities.route.vendor != target_vendor)
        .then_some((handoff, capabilities)))
}

#[cfg(test)]
mod tests;
