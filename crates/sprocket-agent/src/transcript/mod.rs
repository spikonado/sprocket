mod history;
mod store;
mod sync;
pub(crate) mod types;

pub(crate) use history::prompt_text_with_attachments;
pub use history::{agent_history_from_parts, current_run_has_finished_turns};
pub use store::{TranscriptStore, message_page_start};
pub use sync::{
    RemoteTranscriptState, apply_remote_state, fetch_missing_parts, fetch_parts_by_numbers,
    parse_remote_parts,
};
pub use types::{
    TRANSCRIPT_CHUNK_SIZE, TRANSCRIPT_PAGE_SIZE, TranscriptAttachmentMeta, TranscriptMessage,
    TranscriptPage, TranscriptPart,
};
