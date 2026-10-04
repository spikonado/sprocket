use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::catalog::ProviderCatalog;
use crate::transcript::RemoteTranscriptState;
use crate::types::CompletionProvider;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentSettings {
    pub model: String,
    pub reasoning: String,
    pub fast: bool,
    pub completion_provider: CompletionProvider,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentSettingsOverrides {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fast: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentQuestionOption {
    pub id: String,
    pub label: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentQuestion {
    pub question_id: String,
    pub question: String,
    pub options: Vec<SubagentQuestionOption>,
    #[serde(default, deserialize_with = "deserialize_optional_convex_u64")]
    pub timeout_at: Option<u64>,
}

fn deserialize_optional_convex_u64<'de, D>(deserializer: D) -> Result<Option<u64>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<f64>::deserialize(deserializer)?
        .map(|value| {
            if !value.is_finite() || value < 0.0 || value >= u64::MAX as f64 {
                return Err(serde::de::Error::custom("invalid convex timestamp"));
            }
            Ok(value as u64)
        })
        .transpose()
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentThreadSnapshot {
    pub settings: SubagentSettings,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSubagentRunResponse {
    pub thread_id: String,
    pub run_id: String,
    pub status: String,
    pub settings: SubagentSettings,
    /// Previous child run for follow-up/continuation launches; none for a new child.
    #[serde(default)]
    pub continuation_of_run_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentListPage {
    pub page: Vec<SubagentChildSummary>,
    pub is_done: bool,
    pub continue_cursor: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentChildSummary {
    pub thread_id: String,
    #[serde(default)]
    pub title: Option<String>,
    pub status: String,
    #[serde(default)]
    pub last_error: Option<String>,
    #[serde(default)]
    pub parent_thread_id: Option<String>,
    pub settings: SubagentSettings,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentCommittedAnswer {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub option_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub option_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentContinuation {
    pub run_id: String,
    pub prompt: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentControlResponse {
    #[serde(default)]
    pub stopped_run_id: Option<String>,
    #[serde(default)]
    pub answer: Option<SubagentCommittedAnswer>,
    #[serde(default)]
    pub already_answered: bool,
    #[serde(default)]
    pub continuation: Option<SubagentContinuation>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SubagentMonitorInfo {
    pub thread_id: String,
    pub user_id: String,
    pub status: String,
    #[serde(default)]
    pub last_error: Option<String>,
    pub active: bool,
    pub pending_questions: Vec<SubagentQuestion>,
    pub transcript: RemoteTranscriptState,
}

/// Child settings resolved before any durable write.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedSubagentSettings {
    pub model: String,
    pub reasoning: String,
    pub fast: bool,
}

/// Catalog defaults for omitted model/reasoning/fast; unsupported explicit
/// choices are errors.
pub fn resolve_subagent_settings(
    catalog: &ProviderCatalog,
    overrides: &SubagentSettingsOverrides,
) -> anyhow::Result<ResolvedSubagentSettings> {
    let model_id = overrides
        .model
        .as_deref()
        .unwrap_or(&catalog.default_model_id);
    resolve_settings(
        catalog,
        model_id,
        overrides.reasoning.as_deref(),
        overrides.fast,
        catalog.default_fast,
    )
}

/// Keep saved model/reasoning/fast unless overridden. A model change without
/// reasoning uses the new model's default; retained fast turns off when
/// unsupported. Explicit unsupported choices are errors.
pub fn resolve_settings_for_target(
    catalog: &ProviderCatalog,
    saved: &SubagentSettings,
    overrides: &SubagentSettingsOverrides,
) -> anyhow::Result<ResolvedSubagentSettings> {
    let model_id = overrides.model.as_deref().unwrap_or(&saved.model);
    let model_changed = model_id != saved.model;
    let reasoning = overrides
        .reasoning
        .as_deref()
        .or_else(|| (!model_changed).then_some(saved.reasoning.as_str()));
    resolve_settings(catalog, model_id, reasoning, overrides.fast, saved.fast)
}

fn resolve_settings(
    catalog: &ProviderCatalog,
    model_id: &str,
    reasoning: Option<&str>,
    fast: Option<bool>,
    default_fast: bool,
) -> anyhow::Result<ResolvedSubagentSettings> {
    let model = catalog
        .models
        .iter()
        .find(|model| model.id == model_id)
        .ok_or_else(|| {
            anyhow::anyhow!("model {model_id} is unavailable for the current completion provider")
        })?;
    let reasoning = reasoning.unwrap_or(&model.default_reasoning_effort);
    if !model
        .reasoning_efforts
        .iter()
        .any(|effort| effort == reasoning)
    {
        anyhow::bail!("reasoning level {reasoning} is unavailable for {model_id}");
    }
    let supports_fast = model.supports_fast();
    if fast == Some(true) && !supports_fast {
        anyhow::bail!("fast mode is unavailable for {model_id}");
    }
    Ok(ResolvedSubagentSettings {
        model: model_id.to_string(),
        reasoning: reasoning.to_string(),
        fast: fast.unwrap_or(default_fast) && supports_fast,
    })
}

/// Inputs to attach a native execution to a child run committed by createOrSend.
pub struct SubagentLaunchRequest {
    pub user_id: String,
    pub thread_id: String,
    /// Idempotency key of the durable child run.
    pub submission_id: String,
    /// Child execution secret; never the parent run's secret.
    pub execution_secret: String,
    pub prompt: String,
    /// Caller workspace root; the child runs in the same workspace.
    pub workspace_path: String,
    pub selected_model: String,
    pub completion_provider: CompletionProvider,
    pub reasoning_effort: String,
    pub fast_mode: bool,
    /// Previous child run on follow-up/continuation; none for a new child.
    pub continuation_of_run_id: Option<String>,
}

impl std::fmt::Debug for SubagentLaunchRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SubagentLaunchRequest")
            .field("user_id", &self.user_id)
            .field("thread_id", &self.thread_id)
            .field("submission_id", &self.submission_id)
            .finish_non_exhaustive()
    }
}

/// Server-owned launch hook for agent tools. The agent crate does not depend
/// on the server crate.
pub trait SubagentLauncher: Send + Sync {
    fn launch(
        &self,
        request: SubagentLaunchRequest,
    ) -> Pin<Box<dyn Future<Output = anyhow::Result<()>> + Send + '_>>;
}

pub type SharedSubagentLauncher = Arc<dyn SubagentLauncher>;

#[cfg(test)]
mod tests {
    use super::*;

    fn catalog() -> ProviderCatalog {
        serde_json::from_value(serde_json::json!({
            "defaultModelId": "default",
            "defaultFast": false,
            "models": [
                {"id": "default", "label": "Default", "supportsImages": false, "reasoningEfforts": ["medium", "high"],
                 "defaultReasoningEffort": "high", "serviceTiers": ["standard", "fast"]},
                {"id": "pro", "label": "Pro", "supportsImages": false, "reasoningEfforts": ["max"],
                 "defaultReasoningEffort": "max", "serviceTiers": ["standard"]}
            ]
        }))
        .expect("catalog")
    }

    #[test]
    fn omitted_values_resolve_to_provider_compatible_defaults() {
        let resolved =
            resolve_subagent_settings(&catalog(), &SubagentSettingsOverrides::default()).unwrap();
        assert_eq!(resolved.model, "default");
        assert_eq!(resolved.reasoning, "high");
        assert!(!resolved.fast);
    }

    #[test]
    fn model_override_without_reasoning_uses_the_new_models_default() {
        let overrides = SubagentSettingsOverrides {
            model: Some("pro".into()),
            ..Default::default()
        };
        let resolved = resolve_subagent_settings(&catalog(), &overrides).unwrap();
        assert_eq!(resolved.reasoning, "max");
        assert!(!resolved.fast);
    }

    #[test]
    fn retained_fast_is_turned_off_when_the_model_cannot_support_it() {
        let mut catalog = catalog();
        catalog.default_fast = true;
        let overrides = SubagentSettingsOverrides {
            model: Some("pro".into()),
            ..Default::default()
        };
        let resolved = resolve_subagent_settings(&catalog, &overrides).unwrap();
        assert!(!resolved.fast);
    }

    #[test]
    fn explicit_unsupported_choices_fail_clearly() {
        let unknown_model = SubagentSettingsOverrides {
            model: Some("missing".into()),
            ..Default::default()
        };
        assert!(resolve_subagent_settings(&catalog(), &unknown_model).is_err());

        let bad_reasoning = SubagentSettingsOverrides {
            reasoning: Some("low".into()),
            ..Default::default()
        };
        let error = resolve_subagent_settings(&catalog(), &bad_reasoning).unwrap_err();
        assert!(error.to_string().contains("reasoning level low"));

        let bad_fast = SubagentSettingsOverrides {
            model: Some("pro".into()),
            fast: Some(true),
            ..Default::default()
        };
        let error = resolve_subagent_settings(&catalog(), &bad_fast).unwrap_err();
        assert!(error.to_string().contains("fast mode is unavailable"));
    }

    #[test]
    fn explicit_fast_on_a_fast_capable_model_is_kept() {
        let overrides = SubagentSettingsOverrides {
            fast: Some(true),
            ..Default::default()
        };
        let resolved = resolve_subagent_settings(&catalog(), &overrides).unwrap();
        assert!(resolved.fast);
    }

    fn saved_settings() -> SubagentSettings {
        SubagentSettings {
            model: "default".into(),
            reasoning: "high".into(),
            fast: true,
            completion_provider: CompletionProvider::Spikonado,
        }
    }

    #[test]
    fn follow_up_retains_the_saved_settings() {
        let saved = SubagentSettings {
            reasoning: "medium".into(),
            ..saved_settings()
        };
        let resolved =
            resolve_settings_for_target(&catalog(), &saved, &Default::default()).unwrap();
        assert_eq!(
            resolved,
            ResolvedSubagentSettings {
                model: "default".into(),
                reasoning: "medium".into(),
                fast: true,
            }
        );
    }

    #[test]
    fn follow_up_model_change_without_reasoning_uses_the_new_models_default() {
        let overrides = SubagentSettingsOverrides {
            model: Some("pro".into()),
            ..Default::default()
        };
        let resolved =
            resolve_settings_for_target(&catalog(), &saved_settings(), &overrides).unwrap();
        assert_eq!(resolved.reasoning, "max");
        assert!(!resolved.fast);
    }

    #[test]
    fn follow_up_retained_fast_survives_when_the_new_model_supports_it() {
        let resolved = resolve_settings_for_target(
            &catalog(),
            &SubagentSettings {
                model: "pro".into(),
                reasoning: "max".into(),
                ..saved_settings()
            },
            &SubagentSettingsOverrides {
                model: Some("default".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            resolved,
            ResolvedSubagentSettings {
                model: "default".into(),
                reasoning: "high".into(),
                fast: true,
            }
        );
    }

    #[test]
    fn follow_up_keeps_retained_reasoning_when_the_model_does_not_change() {
        let overrides = SubagentSettingsOverrides {
            reasoning: Some("medium".into()),
            ..Default::default()
        };
        let resolved =
            resolve_settings_for_target(&catalog(), &saved_settings(), &overrides).unwrap();
        assert_eq!(resolved.model, "default");
        assert_eq!(resolved.reasoning, "medium");
    }

    #[test]
    fn follow_up_explicit_unsupported_choices_fail_clearly() {
        let bad_reasoning = SubagentSettingsOverrides {
            reasoning: Some("low".into()),
            ..Default::default()
        };
        let error =
            resolve_settings_for_target(&catalog(), &saved_settings(), &bad_reasoning).unwrap_err();
        assert!(error.to_string().contains("reasoning level low"));

        let bad_fast = SubagentSettingsOverrides {
            model: Some("pro".into()),
            fast: Some(true),
            ..Default::default()
        };
        let error =
            resolve_settings_for_target(&catalog(), &saved_settings(), &bad_fast).unwrap_err();
        assert!(error.to_string().contains("fast mode is unavailable"));
    }

    #[test]
    fn question_decodes_convex_timestamps() {
        let question: SubagentQuestion = serde_json::from_value(serde_json::json!({
                "questionId": "jd7q",
                "question": "Pick one",
                "options": [{"id": "a", "label": "A"}],
                "timeoutAt": 1_700_000_000_000.5
        }))
        .expect("question");
        assert_eq!(question.timeout_at, Some(1_700_000_000_000));
    }
}
