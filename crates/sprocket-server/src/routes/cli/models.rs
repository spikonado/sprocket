use anyhow::Context;
use serde::Deserialize;
use sprocket_agent::{
    CompletionProvider, ModelSettings, ResolvedSettings, SettingsOverrides, catalog_for_providers,
    resolve_settings,
};

use crate::cli_protocol::{CliModel, CliModelsResponse, CliRunRequest};

pub(super) struct RunContext {
    pub gateway_url: String,
    /// Enabled providers in the user's order.
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
) -> anyhow::Result<ResolvedSettings> {
    let saved = context.thread.as_ref().map(|thread| ModelSettings {
        model: thread.selected_model.clone(),
        reasoning: thread.reasoning_effort.clone(),
        fast: thread.fast_mode,
    });
    let overrides = SettingsOverrides {
        model: request.model.clone(),
        reasoning: request.reasoning.clone(),
        fast: request.fast,
    };
    resolve_settings(
        &catalog_for_providers(&context.gateway_url, &context.providers).await?,
        &context.providers,
        saved.as_ref(),
        &overrides,
    )
}

pub(super) async fn available(context: &RunContext) -> anyhow::Result<CliModelsResponse> {
    let catalog = catalog_for_providers(&context.gateway_url, &context.providers).await?;
    Ok(CliModelsResponse {
        default_model_id: catalog.default_model_id,
        models: catalog
            .models
            .into_iter()
            .map(|model| CliModel {
                id: model.id,
                label: model.label,
                reasoning_efforts: model.reasoning_efforts,
                default_reasoning_effort: model.default_reasoning_effort,
            })
            .collect(),
    })
}
