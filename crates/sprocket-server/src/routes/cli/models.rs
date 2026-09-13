use std::collections::HashMap;
use std::time::Duration;

use anyhow::Context;
use serde::Deserialize;

use super::{CliRunRequest, RunContext};
use crate::cli_protocol::{CliModel, CliModelsResponse};

#[derive(Deserialize)]
struct Response {
    sprocket: Catalog,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Catalog {
    protocol_version: u32,
    default_model_id: String,
    default_reasoning_effort: String,
    models: Vec<Model>,
    tier_allowed_models: HashMap<String, Vec<String>>,
    tier_allowed_service_tiers: HashMap<String, Vec<String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Model {
    id: String,
    label: String,
    reasoning_efforts: Vec<String>,
    default_reasoning_effort: String,
    service_tiers: Vec<String>,
}

pub(super) struct Settings {
    pub model: String,
    pub reasoning: String,
    pub fast: bool,
}

pub(super) async fn resolve(
    context: &RunContext,
    request: &CliRunRequest,
) -> anyhow::Result<Settings> {
    let catalog = fetch(&context.gateway_url).await?;
    select(catalog, context, request)
}

pub(super) async fn available(context: &RunContext) -> anyhow::Result<CliModelsResponse> {
    available_for_tier(fetch(&context.gateway_url).await?, &context.tier)
}

async fn fetch(gateway_url: &str) -> anyhow::Result<Catalog> {
    let response: Response = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()?
        .get(format!(
            "{}/api/v1/models",
            gateway_url.trim_end_matches('/')
        ))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await
        .context("invalid model catalog")?;
    validate(&response.sprocket)?;
    Ok(response.sprocket)
}

fn validate(catalog: &Catalog) -> anyhow::Result<()> {
    anyhow::ensure!(
        catalog.protocol_version == 1,
        "unsupported model catalog protocol"
    );
    Ok(())
}

fn available_for_tier(catalog: Catalog, tier: &str) -> anyhow::Result<CliModelsResponse> {
    validate(&catalog)?;
    let allowed = allowed_models(&catalog, tier)?;
    let default_model_id = default_model_for_tier(&catalog, allowed)?.id.clone();
    let models: Vec<CliModel> = catalog
        .models
        .iter()
        .filter(|model| allowed.contains(&model.id))
        .map(|model| CliModel {
            id: model.id.clone(),
            label: model.label.clone(),
            reasoning_efforts: model.reasoning_efforts.clone(),
            default_reasoning_effort: model.default_reasoning_effort.clone(),
        })
        .collect();
    Ok(CliModelsResponse {
        default_model_id,
        models,
    })
}

fn allowed_models<'a>(catalog: &'a Catalog, tier: &str) -> anyhow::Result<&'a [String]> {
    catalog
        .tier_allowed_models
        .get(tier)
        .map(Vec::as_slice)
        .context("model catalog does not define this account tier")
}

fn default_model_for_tier<'a>(
    catalog: &'a Catalog,
    allowed: &[String],
) -> anyhow::Result<&'a Model> {
    catalog
        .models
        .iter()
        .find(|model| model.id == catalog.default_model_id && allowed.contains(&model.id))
        .or_else(|| {
            allowed
                .iter()
                .find_map(|id| catalog.models.iter().find(|model| model.id == *id))
        })
        .context("no models are available for this account")
}

fn select(
    catalog: Catalog,
    context: &RunContext,
    request: &CliRunRequest,
) -> anyhow::Result<Settings> {
    validate(&catalog)?;
    let inherited_model = request.model.clone().or_else(|| {
        context
            .thread
            .as_ref()
            .map(|thread| thread.selected_model.clone())
    });
    let allowed = allowed_models(&catalog, &context.tier)?;
    let uses_tier_fallback =
        inherited_model.is_none() && !allowed.contains(&catalog.default_model_id);
    let model = match inherited_model {
        Some(model) => model,
        None => default_model_for_tier(&catalog, allowed)?.id.clone(),
    };
    let fast = request
        .fast
        .or_else(|| context.thread.as_ref().map(|thread| thread.fast_mode))
        .unwrap_or(false);
    let entry = catalog
        .models
        .iter()
        .find(|entry| entry.id == model)
        .with_context(|| format!("unknown model {model}"))?;
    anyhow::ensure!(
        allowed.contains(&model),
        "model {model} is unavailable for this account"
    );
    let reasoning = request
        .reasoning
        .clone()
        .or_else(|| {
            context
                .thread
                .as_ref()
                .map(|thread| thread.reasoning_effort.clone())
        })
        .unwrap_or_else(|| {
            if uses_tier_fallback {
                entry.default_reasoning_effort.clone()
            } else {
                catalog.default_reasoning_effort.clone()
            }
        });
    anyhow::ensure!(
        entry.reasoning_efforts.contains(&reasoning),
        "reasoning level {reasoning} is unavailable for {model}"
    );
    if fast {
        anyhow::ensure!(
            entry.service_tiers.iter().any(|tier| tier == "fast")
                && catalog
                    .tier_allowed_service_tiers
                    .get(&context.tier)
                    .is_some_and(|tiers| tiers.iter().any(|tier| tier == "fast")),
            "fast mode is unavailable for this model or account"
        );
    }
    Ok(Settings {
        model,
        reasoning,
        fast,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalog() -> Catalog {
        serde_json::from_value(serde_json::json!({
            "protocolVersion": 1, "defaultModelId": "default", "defaultReasoningEffort": "high",
            "models": [
                {"id": "default", "label": "Default", "reasoningEfforts": ["medium", "high"], "defaultReasoningEffort": "high", "serviceTiers": ["standard", "fast"]},
                {"id": "paid", "label": "Paid", "reasoningEfforts": ["max"], "defaultReasoningEffort": "max", "serviceTiers": ["standard"]},
                {"id": "paid-first", "label": "Paid First", "reasoningEfforts": ["xhigh"], "defaultReasoningEffort": "xhigh", "serviceTiers": ["standard"]}
            ],
            "tierAllowedModels": {"free": ["default"], "paid": ["stale", "paid-first", "paid"]}, "tierAllowedServiceTiers": {"free": ["standard"]}
        })).unwrap()
    }

    #[test]
    fn defaults_do_not_enable_fast_and_invalid_overrides_never_fall_back() {
        let context = RunContext {
            user_id: "user".into(),
            gateway_url: String::new(),
            tier: "free".into(),
            thread: None,
        };
        let mut request = CliRunRequest {
            client_id: "client".into(),
            prompt: "task".into(),
            directory: "/tmp".into(),
            thread_id: None,
            model: None,
            reasoning: None,
            fast: None,
        };
        assert!(!select(catalog(), &context, &request).unwrap().fast);
        request.fast = Some(true);
        assert!(select(catalog(), &context, &request).is_err());
        request.fast = None;
        request.model = Some("missing".into());
        assert!(select(catalog(), &context, &request).is_err());
        request.model = None;
        request.reasoning = Some("unsupported".into());
        assert!(select(catalog(), &context, &request).is_err());
    }

    #[test]
    fn tier_filtering_uses_the_same_default_for_listing_and_runs() {
        let response = available_for_tier(catalog(), "free").unwrap();
        assert_eq!(response.default_model_id, "default");
        assert_eq!(
            response.models,
            [CliModel {
                id: "default".into(),
                label: "Default".into(),
                reasoning_efforts: vec!["medium".into(), "high".into()],
                default_reasoning_effort: "high".into(),
            }]
        );
        let paid = available_for_tier(catalog(), "paid").unwrap();
        assert_eq!(paid.default_model_id, "paid-first");

        let settings = select(
            catalog(),
            &RunContext {
                user_id: "user".into(),
                gateway_url: String::new(),
                tier: "paid".into(),
                thread: None,
            },
            &CliRunRequest {
                client_id: "client".into(),
                prompt: "task".into(),
                directory: "/tmp".into(),
                thread_id: None,
                model: None,
                reasoning: None,
                fast: None,
            },
        )
        .unwrap();
        assert_eq!(settings.model, "paid-first");
        assert_eq!(settings.reasoning, "xhigh");

        assert!(available_for_tier(catalog(), "unknown").is_err());
    }
}
