//! Cooldown for immediate observations of pending asynchronous resources.

use std::time::Duration;

use tokio::time::Instant;

const ZERO_POLL_COOLDOWN: Duration = Duration::from_secs(10);

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
mod test_support;
#[cfg(test)]
mod tests;
