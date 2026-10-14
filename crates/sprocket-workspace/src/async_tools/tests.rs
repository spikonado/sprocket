use super::{MAX_YIELD_MS, MIN_POLL_YIELD_MS, YieldMode, ZeroPollCooldown};
use std::time::Duration;

#[test]
fn action_and_poll_yields_share_a_cap_but_have_different_minimums() {
    for yield_time_ms in [0, 1, MIN_POLL_YIELD_MS - 1, MIN_POLL_YIELD_MS] {
        assert_eq!(YieldMode::Action.normalize(yield_time_ms), yield_time_ms);
    }
    assert_eq!(YieldMode::Poll.normalize(0), 0);
    assert_eq!(YieldMode::Poll.normalize(1), MIN_POLL_YIELD_MS);
    assert_eq!(YieldMode::Poll.normalize(MAX_YIELD_MS), MAX_YIELD_MS);
    for mode in [YieldMode::Action, YieldMode::Poll] {
        assert_eq!(mode.normalize(u64::MAX), MAX_YIELD_MS);
    }
}

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
