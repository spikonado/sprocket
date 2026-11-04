use std::future::Future;
use std::time::Duration;

use tokio::time::Instant;

const ZERO_POLL_COOLDOWN: Duration = Duration::from_secs(10);

#[derive(Debug, Default)]
pub struct ZeroPollCooldown {
    last_success: Option<Instant>,
}

impl ZeroPollCooldown {
    /// Runs `read`, rejecting it while `pending` reads are on cooldown. Only a
    /// successful pending read starts the cooldown.
    pub async fn observe<T, E>(
        &mut self,
        pending: bool,
        on_cooldown: impl FnOnce(ZeroPollCooldownError) -> E,
        read: impl Future<Output = Result<T, E>>,
    ) -> Result<T, E> {
        if !pending {
            return read.await;
        }
        self.check().map_err(on_cooldown)?;
        let value = read.await?;
        self.last_success = Some(Instant::now());
        Ok(value)
    }

    fn check(&self) -> Result<(), ZeroPollCooldownError> {
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
