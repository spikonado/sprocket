use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

#[test]
fn recognizes_waiting_after_decoding_a_nested_action_error() {
    let error = sprocket_convex::decode_function_result::<()>(
        convex::FunctionResult::ErrorMessage(
            concat!(
                "[Request ID: example] Server Error\n",
                "Uncaught ConvexError: Uncaught ConvexError: SPROCKET_SUBMISSION_WAITING\n",
                "    at handler (agentRuntime.ts:200:2)"
            )
            .to_string(),
        ),
        "agentRuntime:createGatewayRun",
    )
    .unwrap_err();
    assert!(submission_is_waiting(
        &error.context("failed to create run")
    ));
    assert!(!submission_is_waiting(&anyhow::anyhow!(
        "SPROCKET_SUBMISSION_WAITING: unrelated failure"
    )));
}

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
