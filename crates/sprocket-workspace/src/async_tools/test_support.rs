use std::time::Instant;

use super::ZeroPollCooldown;

impl ZeroPollCooldown {
    pub(crate) fn last_success(&self) -> Option<Instant> {
        self.last_success
    }
}
