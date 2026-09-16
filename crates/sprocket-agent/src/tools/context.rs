use std::path::PathBuf;

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

#[derive(Clone)]
pub(super) struct AgentToolContext {
    pub(super) runtime: RuntimeClient,
    pub(super) run_id: String,
    pub(super) claim_id: String,
    pub(super) workspace_root: PathBuf,
    pub(super) transcript_dir: PathBuf,
    pub(super) artifact_bindings: crate::artifact_bindings::ArtifactBindings,
    pub(super) thread_id: String,
    pub(super) supports_images: bool,
    pub(super) tool_call_tracker: ToolCallTracker,
    pub(super) command_sessions: CommandSessionManager,
}

impl AgentToolContext {
    pub(super) fn new(
        runtime: RuntimeClient,
        run_id: String,
        claim_id: String,
        workspace_root: PathBuf,
        transcript_dir: PathBuf,
        artifact_bindings: crate::artifact_bindings::ArtifactBindings,
        thread_id: String,
        supports_images: bool,
        tool_call_tracker: ToolCallTracker,
        command_sessions: CommandSessionManager,
    ) -> Self {
        Self {
            runtime,
            run_id,
            claim_id,
            workspace_root,
            transcript_dir,
            artifact_bindings,
            thread_id,
            supports_images,
            tool_call_tracker,
            command_sessions,
        }
    }
}

pub(super) fn tool_error(error: anyhow::Error) -> ToolExecutionError {
    if error.is::<WorkspaceOperationCancelled>() {
        cancelled_error()
    } else {
        tool_failure(format!("{error:#}"))
    }
}
