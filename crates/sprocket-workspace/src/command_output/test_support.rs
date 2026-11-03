use std::path::Path;

use anyhow::Result;

use super::{CapturedOutput, CommandOutputLimits, UnreturnedOutput, read_log_from};

impl CapturedOutput {
    pub(crate) async fn create(log_root: &Path, max_chars: usize) -> Result<Self> {
        Self::create_with_limits(log_root, max_chars, CommandOutputLimits::default()).await
    }

    pub(crate) async fn read_log(&self, from_offset: u64, final_stream: bool) -> UnreturnedOutput {
        read_log_from(
            Path::new(&self.log_path),
            from_offset,
            self.full_preview.max_chars,
            final_stream,
        )
        .await
        .unwrap()
    }
}
