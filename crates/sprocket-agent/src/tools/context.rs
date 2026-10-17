use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use rig::tool::ToolExecutionError;
use sprocket_workspace::{CommandSessionManager, WorkspaceOperationCancelled};

use crate::convex::RuntimeClient;
use crate::hooks::ToolCallTracker;

/// Builds the model-visible failure for an agent tool. Constructing rig's
/// canonical error directly means its default `map_error` downcast preserves
/// the message instead of redacting it to "the tool failed".
pub(super) fn tool_failure(message: impl Into<String>) -> ToolExecutionError {
    ToolExecutionError::other(message.into())
}

pub(super) fn cancelled_error() -> ToolExecutionError {
    ToolExecutionError::cancelled("Tool execution was cancelled.")
}

/// The thread's current working directory, shared by every tool in a run.
#[derive(Clone)]
pub(crate) struct WorkingDirectory(Arc<RwLock<PathBuf>>);

impl WorkingDirectory {
    pub(super) fn new(path: PathBuf) -> Self {
        Self(Arc::new(RwLock::new(path)))
    }

    pub(crate) fn get(&self) -> PathBuf {
        self.0
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    pub(super) fn set(&self, path: PathBuf) {
        *self
            .0
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = path;
    }
}

#[derive(Clone)]
pub(super) struct AgentToolContext {
    pub(super) runtime: RuntimeClient,
    pub(super) run_id: String,
    pub(super) claim_id: String,
    pub(super) user_id: String,
    pub(super) workspace_root: PathBuf,
    pub(super) cwd: WorkingDirectory,
    pub(super) transcript_dir: PathBuf,
    pub(super) gateway_url: String,
    pub(super) transcript_store: Option<Arc<sprocket_transcript::TranscriptStore>>,
    pub(super) artifact_bindings: sprocket_workspace::artifact_bindings::ArtifactBindings,
    pub(super) supports_images: bool,
    pub(super) tool_call_tracker: ToolCallTracker,
    pub(super) command_sessions: CommandSessionManager,
    pub(super) question_polls: super::questions::QuestionPolls,
    pub(super) subagent_polls: super::subagents::SubagentPolls,
    pub(super) subagent_launcher: Option<crate::subagents::SharedSubagentLauncher>,
}

impl AgentToolContext {
    pub(super) fn workspace_relative_path(&self, path: &str) -> String {
        rebase_onto_cwd(&self.workspace_root, &self.cwd.get(), path)
    }
}

/// Rebases a relative path onto the cwd, keeping it relative to the
/// workspace root when it stays inside so stored paths remain portable.
fn rebase_onto_cwd(workspace_root: &Path, cwd: &Path, path: &str) -> String {
    if cwd == workspace_root || Path::new(path).is_absolute() {
        return path.to_string();
    }
    let joined = cwd.join(path);
    joined
        .strip_prefix(workspace_root)
        .unwrap_or(&joined)
        .to_string_lossy()
        .into_owned()
}

pub(super) fn tool_error(error: anyhow::Error) -> ToolExecutionError {
    if error.is::<WorkspaceOperationCancelled>() {
        cancelled_error()
    } else {
        tool_failure(format!("{error:#}"))
    }
}

#[cfg(test)]
mod tests;
