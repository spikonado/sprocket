use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use anyhow::anyhow;
use tokio::time::{Instant, sleep};

use super::{
    RUN_ABANDONED_BY_AGENT, RUN_CLAIM_EXPIRY_SAFETY_MARGIN, RUN_CLAIM_LEASE_DURATION,
    RUN_CLAIM_RENEW_ATTEMPT_TIMEOUT, RUN_CLAIM_RENEW_INTERVAL, drive_claim_lease, renew_claim_with,
};

/// Regression: a starved renewal tick (CPU saturation, slow reconnect)
/// must not fail an otherwise healthy run.
#[tokio::test(start_paused = true)]
async fn scheduling_stall_after_a_successful_renewal_does_not_fail_the_run() {
    let renewals = AtomicUsize::new(0);
    let result = drive_claim_lease(
        "run-stalled-tick",
        Instant::now(),
        |_lease_deadline| {
            let attempt = renewals.fetch_add(1, Ordering::SeqCst);
            let request_started_at = Instant::now();
            async move {
                if attempt == 0 {
                    sleep(RUN_CLAIM_RENEW_INTERVAL + Duration::from_secs(25)).await;
                }
                Ok((true, request_started_at))
            }
        },
        async {
            sleep(Duration::from_secs(50)).await;
            "done"
        },
    )
    .await;
    assert_eq!(result.ok(), Some("done"));
    assert!(renewals.load(Ordering::SeqCst) >= 2);
}

/// The local deadline is only an estimate; a renewal tick pushed past it
/// must still be attempted.
#[tokio::test(start_paused = true)]
async fn renewal_is_attempted_after_the_estimated_lease_deadline() {
    let renewals = AtomicUsize::new(0);
    let result = drive_claim_lease(
        "run-past-estimated-deadline",
        Instant::now(),
        |_lease_deadline| {
            let attempt = renewals.fetch_add(1, Ordering::SeqCst);
            let request_started_at = Instant::now();
            async move {
                if attempt == 0 {
                    sleep(RUN_CLAIM_LEASE_DURATION + Duration::from_secs(10)).await;
                }
                Ok((true, request_started_at))
            }
        },
        async {
            sleep(Duration::from_secs(100)).await;
            "done"
        },
    )
    .await;
    assert_eq!(result.ok(), Some("done"));
    assert!(renewals.load(Ordering::SeqCst) >= 2);
}

#[tokio::test(start_paused = true)]
async fn renewal_failures_retry_until_the_lease_window_closes() {
    let attempts = AtomicUsize::new(0);
    let started_at = Instant::now();
    let result = renew_claim_with("run-flaky", started_at + RUN_CLAIM_LEASE_DURATION, || {
        attempts.fetch_add(1, Ordering::SeqCst);
        async {
            sleep(RUN_CLAIM_RENEW_ATTEMPT_TIMEOUT).await;
            Err(anyhow!("claim renewal timed out"))
        }
    })
    .await;
    let error = result.unwrap_err().to_string();
    assert!(error.contains("initial attempt failed"), "{error}");
    // Keeps renewing while another attempt can still land before the
    // lease deadline, then stops.
    assert!(attempts.load(Ordering::SeqCst) >= 3);
    assert!(
        Instant::now()
            >= started_at + RUN_CLAIM_LEASE_DURATION
                - RUN_CLAIM_RENEW_ATTEMPT_TIMEOUT
                - RUN_CLAIM_EXPIRY_SAFETY_MARGIN
    );
    assert!(Instant::now() <= started_at + RUN_CLAIM_LEASE_DURATION);
}

#[tokio::test(start_paused = true)]
async fn lost_lease_is_not_retried() {
    let attempts = AtomicUsize::new(0);
    let result = renew_claim_with(
        "run-lost",
        Instant::now() + RUN_CLAIM_LEASE_DURATION,
        || {
            attempts.fetch_add(1, Ordering::SeqCst);
            async { Ok((false, Instant::now())) }
        },
    )
    .await;
    assert_eq!(result.ok().map(|(renewed, _)| renewed), Some(false));
    assert_eq!(attempts.load(Ordering::SeqCst), 1);
}

#[tokio::test(start_paused = true)]
async fn drive_fails_the_run_when_the_lease_is_lost() {
    let result: anyhow::Result<()> = drive_claim_lease(
        "run-taken-over",
        Instant::now(),
        |_lease_deadline| async { Ok((false, Instant::now())) },
        std::future::pending(),
    )
    .await;
    let error = result.unwrap_err();
    assert_eq!(error.to_string(), RUN_ABANDONED_BY_AGENT);
    assert!(format!("{error:#}").contains("was lost"));
}

#[tokio::test(start_paused = true)]
async fn renewal_failure_is_abandonment_and_keeps_the_diagnostic() {
    let result: anyhow::Result<()> = drive_claim_lease(
        "run-disconnected",
        Instant::now(),
        |_lease_deadline| async { Err(anyhow!("claim renewal timed out")) },
        std::future::pending(),
    )
    .await;
    let error = result.unwrap_err();
    assert_eq!(error.to_string(), RUN_ABANDONED_BY_AGENT);
    assert!(format!("{error:#}").contains("claim renewal timed out"));
}

#[tokio::test(start_paused = true)]
async fn operation_failure_is_not_classified_as_abandonment() {
    let result = drive_claim_lease(
        "run-provider-error",
        Instant::now(),
        |_lease_deadline| async { Ok((true, Instant::now())) },
        async { Err::<(), _>(anyhow!("provider failure")) },
    )
    .await;
    assert_eq!(result.unwrap().unwrap_err().to_string(), "provider failure");
}
