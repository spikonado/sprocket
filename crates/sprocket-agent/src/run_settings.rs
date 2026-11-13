use anyhow::Context;

use crate::catalog::ModelCatalog;
use crate::types::{CompletionProvider, ServiceTier};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelSettings {
    pub model: String,
    pub reasoning: String,
    pub service_tier: ServiceTier,
}

#[derive(Clone, Debug, Default)]
pub struct SettingsOverrides {
    pub model: Option<String>,
    pub reasoning: Option<String>,
    pub service_tier: Option<ServiceTier>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedSettings {
    pub model: String,
    pub reasoning: String,
    pub service_tier: ServiceTier,
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
    let model = find(model_id).with_context(|| {
        let ids: Vec<&str> = catalog
            .models
            .iter()
            .map(|model| model.id.as_str())
            .collect();
        format!(
            "model {model_id} is not in the model catalog; choose one of: {}",
            ids.join(", ")
        )
    })?;
    let provider = providers
        .iter()
        .copied()
        .find(|provider| provider.serves(&model.route))
        .with_context(|| {
            format!(
                "no enabled provider offers {model_id}; check your providers in Settings → Providers"
            )
        })?;
    let reasoning = match &overrides.reasoning {
        Some(reasoning) => {
            anyhow::ensure!(
                model.reasoning_efforts.contains(reasoning),
                "reasoning level {reasoning} is unavailable for {model_id}; choose one of: {}",
                model.reasoning_efforts.join(", ")
            );
            reasoning
        }
        None => saved
            .filter(|saved| saved.model == model.id)
            .map(|saved| &saved.reasoning)
            .filter(|reasoning| model.reasoning_efforts.contains(reasoning))
            .unwrap_or(&model.default_reasoning_effort),
    };
    let service_tier = match overrides.service_tier {
        Some(tier) => {
            anyhow::ensure!(
                model.supports_tier(provider, tier),
                "service tier {} is unavailable for {model_id} with {}",
                tier.as_str(),
                provider.as_str()
            );
            tier
        }
        None => saved
            .map(|saved| saved.service_tier)
            .filter(|tier| model.supports_tier(provider, *tier))
            .unwrap_or_default(),
    };
    Ok(ResolvedSettings {
        model: model.id.clone(),
        reasoning: reasoning.clone(),
        service_tier,
        provider,
    })
}

#[cfg(test)]
mod tests;
