use super::ZeroPollCooldown;
use std::time::Duration;

#[tokio::test(start_paused = true)]
async fn checks_do_not_start_or_extend_the_cooldown() {
    let mut cooldown = ZeroPollCooldown::default();
    cooldown.check().unwrap();
    cooldown.check().unwrap();
    assert_eq!(cooldown.last_success(), None);

    cooldown.record_success();
    let first_success = cooldown.last_success();
    assert_eq!(
        cooldown
            .check()
            .unwrap_err()
            .message("Command is still running."),
        "Command is still running. Check again after 10s or use a higher `yieldTimeMs`."
    );
    tokio::time::advance(Duration::from_millis(9_001)).await;
    assert_eq!(
        cooldown
            .check()
            .unwrap_err()
            .message("Question is still pending."),
        "Question is still pending. Check again after 1s or use a higher `yieldTimeMs`."
    );
    assert_eq!(cooldown.last_success(), first_success);
    tokio::time::advance(Duration::from_millis(999)).await;
    cooldown.check().unwrap();
    assert_eq!(cooldown.last_success(), first_success);

    cooldown.record_success();
    assert_ne!(cooldown.last_success(), first_success);
    assert_eq!(cooldown.check().unwrap_err().remaining_seconds, 10);
}
