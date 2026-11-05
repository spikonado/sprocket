use std::future::Future;
use std::time::Duration;

use tinker_convex::{ConvexErrorCode, convex_error_code};
use tinker_workspace::{WorkspaceCancellation, WorkspaceOperationCancelled};
use tokio::time::{sleep, timeout};

pub(crate) const SUBMISSION_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(20);
const SUBMISSION_POLL_INTERVAL: Duration = Duration::from_millis(250);

pub(crate) fn submission_is_waiting(error: &anyhow::Error) -> bool {
    convex_error_code(error) == Some(ConvexErrorCode::SubmissionWaiting)
}

pub(crate) async fn wait_until_ready<F, Fut>(
    cancellation: &WorkspaceCancellation,
    mut prepare: F,
) -> anyhow::Result<()>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = anyhow::Result<bool>>,
{
    loop {
        let ready = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(WorkspaceOperationCancelled.into()),
            result = timeout(SUBMISSION_ATTEMPT_TIMEOUT, prepare()) => {
                result.map_err(|_| anyhow::anyhow!("timed out preparing agent submission"))??
            }
        };
        if ready {
            return Ok(());
        }
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(WorkspaceOperationCancelled.into()),
            _ = sleep(SUBMISSION_POLL_INTERVAL) => {}
        }
    }
}

#[cfg(test)]
mod tests;
