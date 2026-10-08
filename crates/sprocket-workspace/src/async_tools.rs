//! Shared timing policy for asynchronous tool actions and observations.

use std::time::Duration;

use tokio::time::Instant;

pub const DEFAULT_YIELD_MS: u64 = 10_000;
pub const MAX_YIELD_MS: u64 = 270_000;
pub const MIN_POLL_YIELD_MS: u64 = 10_000;
const ZERO_POLL_COOLDOWN: Duration = Duration::from_secs(10);

#[derive(Clone, Copy, Debug)]
pub enum YieldMode {
    Action,
    Poll,
}

impl YieldMode {
    pub fn normalize(self, yield_time_ms: u64) -> u64 {
        match self {
            Self::Action => yield_time_ms.min(MAX_YIELD_MS),
            Self::Poll if yield_time_ms == 0 => 0,
            Self::Poll => yield_time_ms.clamp(MIN_POLL_YIELD_MS, MAX_YIELD_MS),
        }
    }
}

/// Tracks successful immediate observations of a pending resource.
///
/// Keep this state under the resource's observation lock. Check completion first,
/// then check the cooldown before consuming pending output, and record success
/// only after the observation succeeds. Completed and waiting reads bypass it.
#[derive(Debug, Default)]
pub struct ZeroPollCooldown {
    last_success: Option<Instant>,
}

impl ZeroPollCooldown {
    pub fn check(&self) -> Result<(), ZeroPollCooldownError> {
        if let Some(last_success) = self.last_success {
            let elapsed = last_success.elapsed();
            if elapsed < ZERO_POLL_COOLDOWN {
                let remaining = ZERO_POLL_COOLDOWN - elapsed;
                return Err(ZeroPollCooldownError {
                    remaining_seconds: remaining.as_secs()
                        + u64::from(remaining.subsec_nanos() > 0),
                });
            }
        }
        Ok(())
    }

    pub fn record_success(&mut self) {
        self.last_success = Some(Instant::now());
    }

    #[cfg(test)]
    pub(crate) fn last_success(&self) -> Option<Instant> {
        self.last_success
    }
}

#[derive(Debug, thiserror::Error)]
#[error("zero poll is on cooldown for {remaining_seconds}s")]
pub struct ZeroPollCooldownError {
    remaining_seconds: u64,
}

impl ZeroPollCooldownError {
    pub fn message(&self, pending_message: &str) -> String {
        format!(
            "{pending_message} Check again after {}s or use a higher `yieldTimeMs`.",
            self.remaining_seconds
        )
    }
}

#[cfg(test)]
mod tests {
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
}
