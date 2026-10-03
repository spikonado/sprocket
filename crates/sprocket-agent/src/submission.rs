use std::future::Future;
use std::time::Duration;

use sprocket_workspace::{WorkspaceCancellation, WorkspaceOperationCancelled};
use tokio::time::{sleep, timeout};

pub(crate) const SUBMISSION_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(20);
const SUBMISSION_POLL_INTERVAL: Duration = Duration::from_millis(250);
const SUBMISSION_WAITING: &str = "SPROCKET_SUBMISSION_WAITING";

pub(crate) fn submission_is_waiting(error: &anyhow::Error) -> bool {
    error
        .chain()
        .any(|cause| cause.to_string() == SUBMISSION_WAITING)
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
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test(start_paused = true)]
    async fn waits_without_a_submission_deadline_until_cleanup_finishes() {
        let attempts = AtomicUsize::new(0);
        wait_until_ready(&WorkspaceCancellation::new(), || async {
            Ok(attempts.fetch_add(1, Ordering::SeqCst) == 200)
        })
        .await
        .unwrap();
        assert_eq!(attempts.load(Ordering::SeqCst), 201);
    }

    #[tokio::test]
    async fn cancellation_drops_pending_preparation() {
        let cancellation = WorkspaceCancellation::new();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel::<()>();
        let mut started_tx = Some(started_tx);
        let waiting_cancellation = cancellation.clone();
        let task = tokio::spawn(async move {
            wait_until_ready(&waiting_cancellation, || {
                let started_tx = started_tx.take();
                async move {
                    if let Some(tx) = started_tx {
                        let _ = tx.send(());
                    }
                    std::future::pending::<anyhow::Result<bool>>().await
                }
            })
            .await
        });
        started_rx.await.unwrap();
        cancellation.cancel();
        assert!(
            task.await
                .unwrap()
                .unwrap_err()
                .is::<WorkspaceOperationCancelled>()
        );
    }

    #[tokio::test(start_paused = true)]
    async fn stalled_preparation_has_a_bounded_rpc_deadline() {
        let error = wait_until_ready(&WorkspaceCancellation::new(), || async {
            std::future::pending::<anyhow::Result<bool>>().await
        })
        .await
        .unwrap_err();
        assert!(error.to_string().contains("timed out preparing"));
    }
}
