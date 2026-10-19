use std::time::Duration;

use anyhow::Context;
use serde::Deserialize;

use crate::cli_protocol::{CliModel, CliModelsResponse, CliRunRequest};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RunContext {
    pub gateway_url: String,
    pub thread: Option<ThreadSettings>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ThreadSettings {
    pub repository_key: String,
    pub selected_model: String,
    pub reasoning_effort: String,
    pub fast_mode: bool,
}

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
    let mut model = request
        .model
        .clone()
        .or_else(|| {
            context
                .thread
                .as_ref()
                .map(|thread| thread.selected_model.clone())
        })
        .unwrap_or_else(|| catalog.default_model_id.clone());
    let model_fallback = !model_overridden && !catalog.models.iter().any(|entry| entry.id == model);
    if model_fallback {
        model = catalog.default_model_id.clone();
    }
    let fast = request
        .fast
        .or_else(|| {
            context
                .thread
                .as_ref()
                .filter(|_| !model_fallback)
                .map(|thread| thread.fast_mode)
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
            if model_overridden || model_fallback {
                None
            } else {
                context
                    .thread
                    .as_ref()
                    .map(|thread| thread.reasoning_effort.clone())
            }
        })
        .unwrap_or_else(|| {
            if model_overridden || model_fallback {
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
mod tests;
