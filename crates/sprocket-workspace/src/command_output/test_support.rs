use std::path::Path;

use anyhow::Result;

use super::{CapturedOutput, CommandOutputLimits};

impl CapturedOutput {
    pub(crate) async fn create(log_root: &Path, max_chars: usize) -> Result<Self> {
        Self::create_with_limits(
            log_root,
            CommandOutputLimits {
                max_output_chars: max_chars,
                ..CommandOutputLimits::default()
            },
        )
        .await
    }
}
