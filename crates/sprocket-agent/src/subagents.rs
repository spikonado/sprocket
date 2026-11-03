use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use sprocket_transcript::RemoteTranscriptState;

use crate::types::CompletionProvider;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentSettings {
    pub model: String,
    pub reasoning: String,
    pub fast: bool,
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
