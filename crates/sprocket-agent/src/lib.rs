pub mod artifact_bindings;
mod attachments;
mod catalog;
mod context_handoff;
mod convex;
mod hooks;
mod live;
mod output;
mod provider;
mod reasoning;
mod run;
mod tools;
mod transcript;
mod types;

pub use attachments::{AttachmentUnavailable, cache_attachment, download_attachment_to_file};
pub use live::{
    LiveAssistantPart, LiveCompletionHub, LiveCompletionOverlay, LiveCompletionSubscription,
    LiveCompletionWatchEvent,
};
pub use output::{RunOutcome, RunOutput};
pub use run::{AgentRun, finalize_failed_start, run_agent, start_agent_run};
pub use sprocket_convex::AuthTokenFetcher;
pub use transcript::sections;
pub use transcript::{
    RemoteTranscriptState, TRANSCRIPT_CHUNK_SIZE, TRANSCRIPT_PAGE_SIZE, TranscriptAttachmentMeta,
    TranscriptPart, TranscriptPartKind, TranscriptState, TranscriptStore, apply_remote_state,
    fetch_missing_parts, parse_remote_parts,
};
pub use transcript::{SectionPartition, WorkReplica, WorkSnapshot};
pub use types::RunAgentRequest;
