use super::{ZeroPollCooldown, ZeroPollCooldownError};
use std::time::Duration;

async fn observe(
    cooldown: &mut ZeroPollCooldown,
    pending: bool,
    read: Result<(), ZeroPollCooldownError>,
) -> Result<(), ZeroPollCooldownError> {
    cooldown
        .observe(pending, |error| error, async { read })
        .await
}

fn failed_read() -> Result<(), ZeroPollCooldownError> {
    Err(ZeroPollCooldownError {
        remaining_seconds: 0,
    })
}

#[tokio::test(start_paused = true)]
async fn only_successful_pending_reads_start_the_cooldown() {
    let mut cooldown = ZeroPollCooldown::default();
    observe(&mut cooldown, false, Ok(())).await.unwrap();
    observe(&mut cooldown, true, failed_read())
        .await
        .unwrap_err();
    assert_eq!(cooldown.last_success(), None);

    observe(&mut cooldown, true, Ok(())).await.unwrap();
    let first_success = cooldown.last_success();
    assert_eq!(
        observe(&mut cooldown, true, Ok(()))
            .await
            .unwrap_err()
            .message("Command is still running."),
        "Command is still running. Check again after 10s or use a higher `yieldTimeMs`."
    );
    observe(&mut cooldown, false, Ok(())).await.unwrap();
    tokio::time::advance(Duration::from_millis(9_001)).await;
    assert_eq!(
        observe(&mut cooldown, true, Ok(()))
            .await
            .unwrap_err()
            .message("Question is still pending."),
        "Question is still pending. Check again after 1s or use a higher `yieldTimeMs`."
    );
    assert_eq!(cooldown.last_success(), first_success);

    tokio::time::advance(Duration::from_millis(999)).await;
    observe(&mut cooldown, true, Ok(())).await.unwrap();
    assert_ne!(cooldown.last_success(), first_success);
    assert_eq!(
        observe(&mut cooldown, true, Ok(()))
            .await
            .unwrap_err()
            .remaining_seconds,
        10
    );
}
