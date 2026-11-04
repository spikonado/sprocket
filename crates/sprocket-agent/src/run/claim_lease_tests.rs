use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use anyhow::anyhow;
use tokio::time::{Instant, sleep};

use super::{
    ClaimLease, ClaimLeaseLost, RUN_CLAIM_EXPIRY_SAFETY_MARGIN, RUN_CLAIM_RENEW_ATTEMPT_TIMEOUT,
    drive_claim_lease, renew_claim_with,
};

const LEASE_MS: u64 = 120_000;
const LEASE: Duration = Duration::from_millis(LEASE_MS);

fn lease_from_now() -> ClaimLease {
    ClaimLease::new(Instant::now(), LEASE_MS)
}

#[tokio::test(start_paused = true)]
async fn scheduling_stall_after_a_successful_renewal_does_not_fail_the_run() {
    let renewals = AtomicUsize::new(0);
    let result = drive_claim_lease(
        "run-stalled-tick",
        lease_from_now(),
        |_lease_deadline| {
            let attempt = renewals.fetch_add(1, Ordering::SeqCst);
            let renewed = lease_from_now();
            async move {
                if attempt == 0 {
                    sleep(LEASE / 3 + Duration::from_secs(25)).await;
                }
                Ok(Some(renewed))
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

#[tokio::test(start_paused = true)]
async fn renewal_is_attempted_after_the_estimated_lease_deadline() {
    let renewals = AtomicUsize::new(0);
    let result = drive_claim_lease(
        "run-past-estimated-deadline",
        lease_from_now(),
        |_lease_deadline| {
            let attempt = renewals.fetch_add(1, Ordering::SeqCst);
            let renewed = lease_from_now();
            async move {
                if attempt == 0 {
                    sleep(LEASE + Duration::from_secs(10)).await;
                }
                Ok(Some(renewed))
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
async fn renewals_follow_the_lease_duration_the_server_grants() {
    let renewals = AtomicUsize::new(0);
    let started_at = Instant::now();
    let result = drive_claim_lease(
        "run-short-lease",
        ClaimLease::new(started_at, 3_000),
        |_lease_deadline| {
            renewals.fetch_add(1, Ordering::SeqCst);
            let renewed = ClaimLease::new(Instant::now(), 3_000);
            async move { Ok(Some(renewed)) }
        },
        async {
            sleep(Duration::from_millis(10_500)).await;
            "done"
        },
    )
    .await;
    assert_eq!(result.ok(), Some("done"));
    assert_eq!(renewals.load(Ordering::SeqCst), 10);
}

#[tokio::test(start_paused = true)]
async fn renewal_failures_retry_until_the_lease_window_closes() {
    let attempts = AtomicUsize::new(0);
    let started_at = Instant::now();
    let result = renew_claim_with("run-flaky", started_at + LEASE, || {
        attempts.fetch_add(1, Ordering::SeqCst);
        async {
            sleep(RUN_CLAIM_RENEW_ATTEMPT_TIMEOUT).await;
            Err(anyhow!("claim renewal timed out"))
        }
    })
    .await;
    let error = result.unwrap_err().to_string();
    assert!(error.contains("initial attempt failed"), "{error}");
    assert!(attempts.load(Ordering::SeqCst) >= 3);
    assert!(
        Instant::now()
            >= started_at + LEASE
                - RUN_CLAIM_RENEW_ATTEMPT_TIMEOUT
                - RUN_CLAIM_EXPIRY_SAFETY_MARGIN
    );
    assert!(Instant::now() <= started_at + LEASE);
}

#[tokio::test(start_paused = true)]
async fn lost_lease_is_not_retried() {
    let attempts = AtomicUsize::new(0);
    let result = renew_claim_with("run-lost", Instant::now() + LEASE, || {
        attempts.fetch_add(1, Ordering::SeqCst);
        async { Ok(None) }
    })
    .await;
    assert!(result.unwrap().is_none());
    assert_eq!(attempts.load(Ordering::SeqCst), 1);
}

#[tokio::test(start_paused = true)]
async fn drive_fails_the_run_when_the_lease_is_lost() {
    let result: Result<(), ClaimLeaseLost> = drive_claim_lease(
        "run-taken-over",
        lease_from_now(),
        |_lease_deadline| async { Ok(None) },
        std::future::pending(),
    )
    .await;
    assert!(result.unwrap_err().to_string().contains("was lost"));
}

#[tokio::test(start_paused = true)]
async fn drive_fails_the_run_when_renewal_fails() {
    let result: Result<(), ClaimLeaseLost> = drive_claim_lease(
        "run-disconnected",
        lease_from_now(),
        |_lease_deadline| async { Err(anyhow!("claim renewal timed out")) },
        std::future::pending(),
    )
    .await;
    assert_eq!(result.unwrap_err().to_string(), "claim renewal timed out");
}

#[tokio::test(start_paused = true)]
async fn operation_failure_is_returned_inside_ok() {
    let result = drive_claim_lease(
        "run-provider-error",
        lease_from_now(),
        |_lease_deadline| async { Ok(Some(lease_from_now())) },
        async { Err::<(), _>(anyhow!("provider failure")) },
    )
    .await;
    assert_eq!(result.unwrap().unwrap_err().to_string(), "provider failure");
}
