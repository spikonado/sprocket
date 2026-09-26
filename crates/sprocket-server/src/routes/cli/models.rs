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

pub(super) fn gateway_url() -> anyhow::Result<String> {
    let url = std::env::var("PUBLIC_MODEL_GATEWAY_URL")
        .ok()
        .filter(|url| !url.trim().is_empty())
        .or_else(|| {
            crate::repo_env::compile_time_env_var("PUBLIC_MODEL_GATEWAY_URL").map(str::to_owned)
        })
        .filter(|url| !url.trim().is_empty())
        .context("PUBLIC_MODEL_GATEWAY_URL must be set for model discovery")?;
    Ok(url.trim().trim_end_matches('/').to_owned())
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
    let default_model_id = resolve_model_for_tier(&catalog, tier)?;
    let models: Vec<CliModel> = catalog
        .models
        .iter()
        .filter(|model| model_is_allowed(&catalog, tier, &model.id))
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

// Mirrors the UI's resolveModelForTier: prefer the catalog default when the tier allows it,
// then the tier's first allowed model, then the catalog default.
fn resolve_model_for_tier(catalog: &Catalog, tier: &str) -> anyhow::Result<String> {
    if model_is_allowed(catalog, tier, &catalog.default_model_id) {
        return Ok(catalog.default_model_id.clone());
    }
    let allowed = catalog
        .tier_allowed_models
        .get(tier)
        .context("no models are available for this account")?;
    allowed
        .first()
        .cloned()
        .context("no models are available for this account")
}

// Tiers missing from the catalog allow every model, matching the UI's isModelAllowedForTier.
fn model_is_allowed(catalog: &Catalog, tier: &str, model: &str) -> bool {
    catalog
        .tier_allowed_models
        .get(tier)
        .is_none_or(|allowed| allowed.iter().any(|id| id == model))
}

// Tiers missing from the catalog allow fast mode, matching the UI's fastModeAccessForModelAndTier.
fn fast_mode_is_allowed(catalog: &Catalog, tier: &str, model: &Model) -> bool {
    model
        .service_tiers
        .iter()
        .any(|service_tier| service_tier == "fast")
        && catalog
            .tier_allowed_service_tiers
            .get(tier)
            .is_none_or(|tiers| tiers.iter().any(|service_tier| service_tier == "fast"))
}

fn select(
    catalog: Catalog,
    context: &RunContext,
    request: &CliRunRequest,
) -> anyhow::Result<Settings> {
    validate(&catalog)?;
    let model_overridden = request.model.is_some();
    let inherited_model = request.model.clone().or_else(|| {
        context
            .thread
            .as_ref()
            .map(|thread| thread.selected_model.clone())
    });
    let (model, coerced) = match inherited_model {
        Some(model) if model_is_allowed(&catalog, &context.tier, &model) => (model, false),
        Some(model) if model_overridden => {
            anyhow::bail!("model {model} is unavailable for this account")
        }
        // Like the UI's resolveModelForTier, fall back to the tier's first allowed model
        // when the inherited model is locked.
        _ => (resolve_model_for_tier(&catalog, &context.tier)?, true),
    };
    // Like the UI, coercion to a different model drops the thread's fast mode setting;
    // only an explicit --fast asks for it on the replacement model.
    let fast = request
        .fast
        .or_else(|| {
            if coerced {
                None
            } else {
                context.thread.as_ref().map(|thread| thread.fast_mode)
            }
        })
        .unwrap_or(false);
    let entry = catalog
        .models
        .iter()
        .find(|entry| entry.id == model)
        .with_context(|| format!("unknown model {model}"))?;
    let reasoning = request
        .reasoning
        .clone()
        .or_else(|| {
            if model_overridden || coerced {
                None
            } else {
                context
                    .thread
                    .as_ref()
                    .map(|thread| thread.reasoning_effort.clone())
            }
        })
        .unwrap_or_else(|| {
            if model_overridden || coerced {
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
            fast_mode_is_allowed(&catalog, &context.tier, entry),
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
        // The tier's first allowed model wins even when it is stale, matching the UI's
        // resolveModelForTier.
        assert_eq!(paid.default_model_id, "stale");

        // Stale allowed ids not present in the catalog surface as an error.
        assert!(
            select(
                catalog(),
                &RunContext {
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
            .is_err()
        );

        // Tiers missing from the catalog allow everything, like the UI.
        let enterprise = available_for_tier(catalog(), "enterprise").unwrap();
        assert_eq!(enterprise.default_model_id, "default");
        assert_eq!(enterprise.models.len(), catalog().models.len());
    }

    #[test]
    fn locked_inherited_model_falls_back_to_the_tiers_first_allowed_model() {
        let settings = select(
            catalog(),
            &RunContext {
                gateway_url: String::new(),
                tier: "free".into(),
                thread: Some(super::super::ThreadSettings {
                    repository_key: "repo".into(),
                    selected_model: "paid".into(),
                    reasoning_effort: "max".into(),
                    fast_mode: false,
                }),
            },
            &CliRunRequest {
                client_id: "client".into(),
                prompt: "task".into(),
                directory: "/tmp".into(),
                thread_id: Some("thread".into()),
                model: None,
                reasoning: None,
                fast: None,
            },
        )
        .unwrap();

        assert_eq!(settings.model, "default");
        // Coerced to a model with a different effort set, so the inherited effort is
        // dropped for the model's own default.
        assert_eq!(settings.reasoning, "high");
    }

    #[test]
    fn locked_explicit_model_is_an_error() {
        let result = select(
            catalog(),
            &RunContext {
                gateway_url: String::new(),
                tier: "free".into(),
                thread: None,
            },
            &CliRunRequest {
                client_id: "client".into(),
                prompt: "task".into(),
                directory: "/tmp".into(),
                thread_id: None,
                model: Some("paid".into()),
                reasoning: None,
                fast: None,
            },
        );

        assert!(result.is_err());
    }

    #[test]
    fn coercion_drops_the_inherited_fast_mode_like_the_ui() {
        let settings = select(
            catalog(),
            &RunContext {
                gateway_url: String::new(),
                tier: "free".into(),
                thread: Some(super::super::ThreadSettings {
                    repository_key: "repo".into(),
                    selected_model: "paid".into(),
                    reasoning_effort: "max".into(),
                    fast_mode: true,
                }),
            },
            &CliRunRequest {
                client_id: "client".into(),
                prompt: "task".into(),
                directory: "/tmp".into(),
                thread_id: Some("thread".into()),
                model: None,
                reasoning: None,
                fast: None,
            },
        )
        .unwrap();

        assert_eq!(settings.model, "default");
        assert!(!settings.fast);

        // An explicit --fast still applies to the replacement model.
        let request = CliRunRequest {
            client_id: "client".into(),
            prompt: "task".into(),
            directory: "/tmp".into(),
            thread_id: Some("thread".into()),
            model: None,
            reasoning: None,
            fast: Some(true),
        };
        let context = RunContext {
            gateway_url: String::new(),
            tier: "free".into(),
            thread: Some(super::super::ThreadSettings {
                repository_key: "repo".into(),
                selected_model: "paid".into(),
                reasoning_effort: "max".into(),
                fast_mode: true,
            }),
        };
        // The free tier allows no fast service tier, so --fast still errors.
        assert!(select(catalog(), &context, &request).is_err());
    }

    #[test]
    fn tiers_missing_from_the_catalog_allow_every_model_and_fast_mode() {
        let settings = select(
            catalog(),
            &RunContext {
                gateway_url: String::new(),
                tier: "enterprise".into(),
                thread: None,
            },
            &CliRunRequest {
                client_id: "client".into(),
                prompt: "task".into(),
                directory: "/tmp".into(),
                thread_id: None,
                model: Some("default".into()),
                reasoning: None,
                fast: Some(true),
            },
        )
        .unwrap();

        assert_eq!(settings.model, "default");
        assert!(settings.fast);
    }

    #[test]
    fn model_override_uses_the_selected_models_reasoning_default() {
        let settings = select(
            catalog(),
            &RunContext {
                gateway_url: String::new(),
                tier: "paid".into(),
                thread: Some(super::super::ThreadSettings {
                    repository_key: "repo".into(),
                    selected_model: "default".into(),
                    reasoning_effort: "high".into(),
                    fast_mode: false,
                }),
            },
            &CliRunRequest {
                client_id: "client".into(),
                prompt: "task".into(),
                directory: "/tmp".into(),
                thread_id: Some("thread".into()),
                model: Some("paid".into()),
                reasoning: None,
                fast: None,
            },
        )
        .unwrap();

        assert_eq!(settings.model, "paid");
        assert_eq!(settings.reasoning, "max");
    }
}
