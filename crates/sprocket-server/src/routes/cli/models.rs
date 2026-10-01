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
    list_models(&fetch(&context.gateway_url).await?)
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
    anyhow::ensure!(
        catalog
            .models
            .iter()
            .any(|model| model.id == catalog.default_model_id),
        "default model {} is missing from the catalog",
        catalog.default_model_id
    );
    Ok(())
}

fn list_models(catalog: &Catalog) -> anyhow::Result<CliModelsResponse> {
    validate(catalog)?;
    let models: Vec<CliModel> = catalog
        .models
        .iter()
        .map(|model| CliModel {
            id: model.id.clone(),
            label: model.label.clone(),
            reasoning_efforts: model.reasoning_efforts.clone(),
            default_reasoning_effort: model.default_reasoning_effort.clone(),
        })
        .collect();
    Ok(CliModelsResponse {
        default_model_id: catalog.default_model_id.clone(),
        models,
    })
}

fn select(
    catalog: Catalog,
    context: &RunContext,
    request: &CliRunRequest,
) -> anyhow::Result<Settings> {
    validate(&catalog)?;
    let model_overridden = request.model.is_some();
    let model = request
        .model
        .clone()
        .or_else(|| {
            context
                .thread
                .as_ref()
                .map(|thread| thread.selected_model.clone())
        })
        .unwrap_or_else(|| catalog.default_model_id.clone());
    let fast = request
        .fast
        .or_else(|| context.thread.as_ref().map(|thread| thread.fast_mode))
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
            if model_overridden {
                None
            } else {
                context
                    .thread
                    .as_ref()
                    .map(|thread| thread.reasoning_effort.clone())
            }
        })
        .unwrap_or_else(|| {
            if model_overridden {
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
            entry.service_tiers.iter().any(|tier| tier == "fast"),
            "fast mode is unavailable for {model}"
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
    ) -> super::super::ThreadSettings {
        super::super::ThreadSettings {
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
    fn released_gateway_eligibility_fields_are_ignored() {
        let catalog: Catalog = serde_json::from_value(serde_json::json!({
            "protocolVersion": 1, "defaultModelId": "default", "defaultReasoningEffort": "high",
            "models": [
                {"id": "default", "label": "Default", "reasoningEfforts": ["high"], "defaultReasoningEffort": "high", "serviceTiers": ["standard"]},
                {"id": "pro", "label": "Pro", "reasoningEfforts": ["max"], "defaultReasoningEffort": "max", "serviceTiers": ["standard", "fast"]}
            ],
            "tierAllowedModels": {"free": ["default"]},
            "tierAllowedServiceTiers": {"free": ["standard"]}
        }))
        .unwrap();

        let response = list_models(&catalog).unwrap();
        assert_eq!(response.models.len(), 2);

        let mut request = run_request();
        request.model = Some("pro".into());
        request.fast = Some(true);
        let settings = select(catalog, &fresh_context(), &request).unwrap();
        assert_eq!(settings.model, "pro");
        assert!(settings.fast);
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
}
