mod attachment_store;
mod attachments;
mod download;
#[cfg(test)]
mod download_tests;
mod live;
pub mod monitor;
mod read_index;
mod replica;
pub mod sections;
mod store;
mod sync;
mod types;
#[cfg(test)]
mod work_tests;

pub use attachments::{AttachmentUnavailable, cache_attachment, cache_prompt_attachments};
pub use download::DownloadOrder;
pub use live::{
    LiveAssistantPart, LiveAssistantParts, LiveCompletionHub, LiveCompletionOverlay,
    LiveCompletionSubscription, LiveCompletionWatchEvent, join_assistant_text_parts,
};
pub use replica::WorkReplica;
pub use store::TranscriptStore;
pub use sync::{RemoteTranscriptState, apply_remote_state, parse_remote_page, parse_remote_parts};
pub use types::{
    TRANSCRIPT_CHUNK_SIZE, TranscriptAttachmentMeta, TranscriptCompletionBody, TranscriptPart,
    TranscriptPartKind, TranscriptPromptBody, TranscriptState, TranscriptToolBody,
};
