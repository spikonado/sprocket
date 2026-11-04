use anyhow::Context;

use crate::catalog::ModelCatalog;
use crate::types::CompletionProvider;

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

pub fn resolve_settings(
    catalog: &ModelCatalog,
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
    let model =
        find(model_id).with_context(|| format!("model {model_id} is not in the model catalog"))?;
    let provider = providers
        .iter()
        .copied()
        .find(|provider| provider.serves_vendor(&model.vendor))
        .with_context(|| {
            format!(
                "no enabled provider offers {model_id}; check your providers in Settings → Providers"
            )
        })?;
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
            true
        }
        Some(false) => false,
        None => saved.is_some_and(|saved| saved.fast) && model.supports_fast(),
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
