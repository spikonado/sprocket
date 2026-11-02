use std::path::Path;

use anyhow::Result;

use super::{CapturedOutput, CommandOutputLimits, UnreturnedOutput, read_output_events};

impl CapturedOutput {
    pub(crate) async fn create(log_root: &Path, max_chars: usize) -> Result<Self> {
        Self::create_with_limits(log_root, max_chars, CommandOutputLimits::default()).await
    }

    pub(crate) async fn read_events(
        &self,
        from_sequence: u64,
        final_stream: bool,
    ) -> UnreturnedOutput {
        read_output_events(
            Path::new(&self.events_path),
            from_sequence,
            self.full_preview.max_chars,
            final_stream,
        )
        .await
        .unwrap()
    }
}
