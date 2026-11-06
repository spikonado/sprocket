use std::collections::BTreeSet;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use sprocket_convex::RunStatus;
use sprocket_transcript::RemoteTranscriptState;

use crate::types::CompletionProvider;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentSettings {
    pub model: String,
    pub reasoning: String,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub fast: bool,
    #[serde(skip_serializing)]
    pub completion_provider: CompletionProvider,
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
    pub status: RunStatus,
    pub settings: SubagentSettings,
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
    pub status: RunStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
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
    pub status: RunStatus,
    #[serde(default)]
    pub last_error: Option<String>,
    pub active: bool,
    pub pending_questions: Vec<SubagentQuestion>,
    pub transcript: RemoteTranscriptState,
    /// The latest run, or the requested target run.
    #[serde(default)]
    pub run_id: Option<String>,
    /// Runs whose prompts the caller's thread sent.
    #[serde(default)]
    pub caller_prompt_run_ids: BTreeSet<String>,
}

pub struct SubagentLaunchRequest {
    pub user_id: String,
    pub thread_id: String,
    pub submission_id: String,
    /// Child execution secret; never the parent run's secret.
    pub execution_secret: String,
    pub workspace_path: String,
    pub selected_model: String,
    pub completion_provider: CompletionProvider,
    pub reasoning_effort: String,
    pub fast_mode: bool,
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

pub trait SubagentLauncher: Send + Sync {
    fn launch(
        &self,
        request: SubagentLaunchRequest,
    ) -> Pin<Box<dyn Future<Output = anyhow::Result<()>> + Send + '_>>;
}

pub type SharedSubagentLauncher = Arc<dyn SubagentLauncher>;
