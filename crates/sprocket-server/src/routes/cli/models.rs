use anyhow::Context;
use serde::Deserialize;
use sprocket_agent::{CompletionProvider, ProviderCatalog, catalog_for_providers};

use crate::cli_protocol::{CliModel, CliModelsResponse, CliRunRequest};

pub(super) struct RunContext {
    pub gateway_url: String,
    /// Enabled, set-up providers in the user's order.
    pub providers: Vec<CompletionProvider>,
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

#[derive(Debug)]
pub(super) struct Settings {
    pub model: String,
    pub provider: CompletionProvider,
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
    select(&fetch(context).await?, context, request)
}

pub(super) async fn available(context: &RunContext) -> anyhow::Result<CliModelsResponse> {
    Ok(list_models(&fetch(context).await?))
}

async fn fetch(context: &RunContext) -> anyhow::Result<ProviderCatalog> {
    anyhow::ensure!(
        !context.providers.is_empty(),
        "no enabled provider is set up; enable Spikonado or connect a provider in Settings > Providers"
    );
    catalog_for_providers(&context.gateway_url, &context.providers).await
}

fn list_models(catalog: &ProviderCatalog) -> CliModelsResponse {
    CliModelsResponse {
        default_model_id: catalog.default_model_id.clone(),
        models: catalog
            .models
            .iter()
            .map(|model| CliModel {
                id: model.id.clone(),
                label: model.label.clone(),
                reasoning_efforts: model.reasoning_efforts.clone(),
                default_reasoning_effort: model.default_reasoning_effort.clone(),
            })
            .collect(),
    }
}

/// Mirrors the web composer: `catalog` holds only models `context.providers` serve, a saved
/// model they no longer serve falls back to the default, and the run uses the first provider
/// that serves the model.
fn select(
    catalog: &ProviderCatalog,
    context: &RunContext,
    request: &CliRunRequest,
) -> anyhow::Result<Settings> {
    let served = |id: &str| catalog.models.iter().any(|model| model.id == id);
    let thread = context.thread.as_ref();
    let model_fallback =
        request.model.is_none() && thread.is_some_and(|thread| !served(&thread.selected_model));
    let model_id = match (&request.model, thread) {
        (Some(model), _) => model,
        (None, Some(thread)) if !model_fallback => &thread.selected_model,
        _ => &catalog.default_model_id,
    };
    let model = catalog
        .models
        .iter()
        .find(|model| &model.id == model_id)
        .with_context(|| {
            let providers: Vec<_> = context.providers.iter().map(|p| p.as_str()).collect();
            format!(
                "model {model_id} is unavailable from your enabled providers ({}); run sprocket models to list the ones they serve",
                providers.join(", ")
            )
        })?;
    let provider = context
        .providers
        .iter()
        .copied()
        .find(|provider| provider.serves_vendor(&model.vendor))
        .with_context(|| format!("no enabled provider serves {model_id}"))?;
    let inherited = thread.filter(|_| !model_fallback);
    let reasoning = request
        .reasoning
        .clone()
        .or_else(|| {
            inherited
                .filter(|_| request.model.is_none())
                .map(|thread| thread.reasoning_effort.clone())
        })
        .unwrap_or_else(|| model.default_reasoning_effort.clone());
    anyhow::ensure!(
        model.reasoning_efforts.contains(&reasoning),
        "reasoning level {reasoning} is unavailable for {model_id}"
    );
    let fast = request
        .fast
        .or_else(|| {
            inherited
                .filter(|_| provider.serves_fast_mode())
                .map(|thread| thread.fast_mode)
        })
        .unwrap_or(false);
    if fast {
        anyhow::ensure!(
            provider.serves_fast_mode(),
            "fast mode needs the Spikonado provider; {model_id} runs on {}",
            provider.as_str()
        );
        anyhow::ensure!(
            model.supports_fast(),
            "fast mode is unavailable for {model_id}"
        );
    }
    Ok(Settings {
        model: model.id.clone(),
        provider,
        reasoning,
        fast,
    })
}

#[cfg(test)]
mod tests;
