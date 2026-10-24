use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use sprocket_transcript::RemoteTranscriptState;

use crate::catalog::ProviderCatalog;
use crate::types::CompletionProvider;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentSettings {
    pub model: String,
    pub reasoning: String,
    pub fast: bool,
    pub completion_provider: CompletionProvider,
}

#[derive(Clone, Debug, Default)]
pub struct SubagentSettingsOverrides {
    pub model: Option<String>,
    pub reasoning: Option<String>,
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
}

#[derive(Clone, Debug, Deserialize)]
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

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentChildSummary {
    pub thread_id: String,
    #[serde(default)]
    pub title: Option<String>,
    pub status: String,
    #[serde(default)]
    pub last_error: Option<String>,
    pub parent_thread_id: String,
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
            anyhow::anyhow!("model {model_id} is unavailable from the enabled providers")
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
mod tests;
