use sprocket_transcript::{TranscriptPart, TranscriptState};

use super::agent_history_with_workspace_context;
use crate::types::AgentHistoryMessage;
use crate::workspace_context::RecordedWorkspaceContext;

pub(crate) fn agent_history_from_parts(
    state: &TranscriptState,
    parts: &[TranscriptPart],
    skip_run_id: Option<&str>,
) -> Vec<AgentHistoryMessage> {
    agent_history_with_workspace_context(
        state,
        parts,
        skip_run_id,
        &RecordedWorkspaceContext::default(),
    )
    .0
}
