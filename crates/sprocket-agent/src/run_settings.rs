use anyhow::Context;

use crate::catalog::ProviderCatalog;
use crate::types::CompletionProvider;

/// A thread's saved model, reasoning, and fast mode.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelSettings {
    pub model: String,
    pub reasoning: String,
    pub fast: bool,
}

#[derive(Clone, Debug, Default)]
pub struct SettingsOverrides {
    pub model: Option<String>,
    pub reasoning: Option<String>,
    pub fast: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedSettings {
    pub model: String,
    pub reasoning: String,
    pub fast: bool,
    pub provider: CompletionProvider,
}

/// Settings for a new run, as the web composer picks them. `catalog` holds the models
/// `providers` (enabled, in the user's order) serve. Saved settings carry over unless
/// unsupported, a saved model no longer served falls back to the default, and explicit
/// unsupported choices are errors. The run starts on the first provider serving the model;
/// run-start failover moves past providers that can't start.
pub fn resolve_settings(
    catalog: &ProviderCatalog,
    providers: &[CompletionProvider],
    saved: Option<&ModelSettings>,
    overrides: &SettingsOverrides,
) -> anyhow::Result<ResolvedSettings> {
    let find = |id: &str| catalog.models.iter().find(|model| model.id == id);
    let saved = saved.filter(|saved| find(&saved.model).is_some());
    let model_id = overrides
        .model
        .as_deref()
        .or(saved.map(|saved| saved.model.as_str()))
        .unwrap_or(catalog.default_model_id.as_str());
    let model = find(model_id).with_context(|| {
        let providers: Vec<_> = providers.iter().map(|provider| provider.as_str()).collect();
        format!(
            "model {model_id} is unavailable from the enabled providers ({})",
            providers.join(", ")
        )
    })?;
    let provider = providers
        .iter()
        .copied()
        .find(|provider| provider.serves_vendor(&model.vendor))
        .with_context(|| format!("no enabled provider serves {model_id}"))?;
    let reasoning = match &overrides.reasoning {
        Some(reasoning) => {
            anyhow::ensure!(
                model.reasoning_efforts.contains(reasoning),
                "reasoning level {reasoning} is unavailable for {model_id}"
            );
            reasoning
        }
        None => saved
            .filter(|saved| saved.model == model.id)
            .map(|saved| &saved.reasoning)
            .filter(|reasoning| model.reasoning_efforts.contains(reasoning))
            .unwrap_or(&model.default_reasoning_effort),
    };
    let fast = match overrides.fast {
        Some(true) => {
            anyhow::ensure!(
                model.supports_fast(),
                "fast mode is unavailable for {model_id}"
            );
            anyhow::ensure!(
                provider.serves_fast_mode(),
                "fast mode needs the Spikonado provider; {model_id} runs on {}",
                provider.as_str()
            );
            true
        }
        Some(false) => false,
        None => {
            saved.is_some_and(|saved| saved.fast)
                && model.supports_fast()
                && provider.serves_fast_mode()
        }
    };
    Ok(ResolvedSettings {
        model: model.id.clone(),
        reasoning: reasoning.clone(),
        fast,
        provider,
    })
}

#[cfg(test)]
mod tests;
