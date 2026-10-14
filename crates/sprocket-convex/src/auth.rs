use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::Context;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::Deserialize;
use tokio::sync::{Mutex, watch};
use tokio::task::JoinHandle;

use crate::{AuthSignedOut, AuthTokenFetcher};

/// Matches Convex JS `authRefreshTokenLeewaySeconds` default.
const REFRESH_LEEWAY_SECS: u64 = 10;
/// Matches Convex JS: tokens shorter than this cannot be rescheduled.
const MIN_TOKEN_LIFETIME_SECS: u64 = 2;
/// Matches Convex JS `MAXIMUM_REFRESH_DELAY` (setTimeout's 32-bit cap).
const MAXIMUM_REFRESH_DELAY: Duration = Duration::from_secs(20 * 24 * 60 * 60);
const INITIAL_RETRY_DELAY: Duration = Duration::from_secs(1);
const MAX_RETRY_DELAY: Duration = Duration::from_secs(30);
const AUTH_RECOVERY_TIMEOUT: Duration = Duration::from_secs(120);

pub(crate) type ApplyRefresh =
    Arc<dyn Fn(u64) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;
pub(crate) type AuthFailureHandler =
    Arc<dyn Fn(u64, String) -> Pin<Box<dyn Future<Output = bool> + Send>> + Send + Sync>;

struct AuthSlots {
    fetcher: Option<AuthTokenFetcher>,
    pending_user_token: Option<Result<String, AuthSignedOut>>,
}

pub(crate) struct AuthState {
    generation: watch::Sender<u64>,
    fetch_epoch: AtomicU64,
    slots: Mutex<AuthSlots>,
    refresh: std::sync::Mutex<Option<JoinHandle<()>>>,
    on_apply: std::sync::OnceLock<ApplyRefresh>,
    on_failure: std::sync::OnceLock<AuthFailureHandler>,
    failure: watch::Sender<Option<String>>,
}

impl AuthState {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self {
            generation: watch::channel(0).0,
            fetch_epoch: AtomicU64::new(0),
            slots: Mutex::new(AuthSlots {
                fetcher: None,
                pending_user_token: None,
            }),
            refresh: std::sync::Mutex::new(None),
            on_apply: std::sync::OnceLock::new(),
            on_failure: std::sync::OnceLock::new(),
            failure: watch::channel(None).0,
        })
    }

    pub(crate) fn set_on_apply(&self, on_apply: ApplyRefresh) {
        let _ = self.on_apply.set(on_apply);
    }

    pub(crate) fn set_on_failure(&self, on_failure: AuthFailureHandler) {
        let _ = self.on_failure.set(on_failure);
    }

    pub(crate) fn report_failure(&self, error: String) {
        self.failure.send_replace(Some(error));
        self.abort_refresh();
    }

    pub(crate) async fn wait_for_failure(&self) -> String {
        self.failure
            .subscribe()
            .wait_for(Option::is_some)
            .await
            .expect("auth state owns the failure sender")
            .as_ref()
            .expect("failure is present")
            .clone()
    }

    pub(crate) fn shutdown(&self) {
        self.generation.send_modify(|generation| *generation += 1);
        self.fetch_epoch.fetch_add(1, Ordering::SeqCst);
        self.abort_refresh();
    }

    pub(crate) fn generation(&self) -> u64 {
        *self.generation.borrow()
    }

    pub(crate) async fn install(self: &Arc<Self>, fetcher: AuthTokenFetcher) -> u64 {
        self.shutdown();
        self.failure.send_replace(None);
        let generation = self.generation();
        let mut slots = self.slots.lock().await;
        slots.fetcher = Some(fetcher);
        slots.pending_user_token = None;
        generation
    }

    pub(crate) async fn clear(&self) {
        self.shutdown();
        let mut slots = self.slots.lock().await;
        slots.fetcher = None;
        slots.pending_user_token = None;
    }

    pub(crate) async fn resolve(
        self: &Arc<Self>,
        generation: u64,
        force_refresh: bool,
    ) -> anyhow::Result<String> {
        let mut generations = self.generation.subscribe();
        let mut last_error = None;
        let retry = async {
            let mut delay = INITIAL_RETRY_DELAY;
            loop {
                match self.resolve_once(generation, force_refresh).await {
                    Ok(token) => return Ok(token),
                    Err(error) if error.is::<AuthSignedOut>() => return Err(error),
                    Err(error) => last_error = Some(format!("{error:#}")),
                }
                // Convex 0.10.4 sends queued requests anonymously if its fetcher returns an error.
                tokio::time::sleep(delay).await;
                delay = (delay * 2).min(MAX_RETRY_DELAY);
            }
        };
        let result = tokio::select! {
            biased;
            _ = generations.wait_for(|current| *current != generation) => {
                anyhow::bail!("stale auth callback");
            }
            result = tokio::time::timeout(AUTH_RECOVERY_TIMEOUT, retry) => result,
        };
        match result {
            Ok(result) => result,
            Err(_) => {
                let error = recovery_timeout_error(last_error.as_deref());
                if let Some(on_failure) = self.on_failure.get()
                    && on_failure(generation, error).await
                {
                    // Only aborting the closed SDK worker may release this callback, even after clear_auth.
                    std::future::pending().await
                } else {
                    anyhow::bail!("stale auth callback");
                }
            }
        }
    }

    async fn resolve_once(
        self: &Arc<Self>,
        generation: u64,
        force_refresh: bool,
    ) -> anyhow::Result<String> {
        if self.generation() != generation {
            anyhow::bail!("stale auth callback");
        }

        let (fetcher, pending, epoch) = {
            let mut slots = self.slots.lock().await;
            if self.generation() != generation {
                anyhow::bail!("stale auth callback");
            }
            if force_refresh {
                slots.pending_user_token = None;
            }
            let pending = if force_refresh {
                None
            } else {
                slots.pending_user_token.take()
            };
            let epoch = if pending.is_some() {
                self.fetch_epoch.load(Ordering::SeqCst)
            } else {
                self.fetch_epoch.fetch_add(1, Ordering::SeqCst) + 1
            };
            (slots.fetcher.clone(), pending, epoch)
        };

        let result = if let Some(token) = pending {
            token.map_err(Into::into)
        } else {
            let fetcher = fetcher.context("auth fetcher missing")?;
            fetcher(force_refresh).await
        };
        if self.generation() != generation || self.fetch_epoch.load(Ordering::SeqCst) != epoch {
            anyhow::bail!("stale auth callback");
        }
        result
    }

    pub(crate) async fn arm(self: &Arc<Self>, generation: u64, token: &str) {
        if self.generation() != generation {
            return;
        }
        self.abort_refresh();
        self.fetch_epoch.fetch_add(1, Ordering::SeqCst);
        let Some(delay) = refresh_delay_for_token(token, SystemTime::now()) else {
            return;
        };
        let weak = Arc::downgrade(self);
        let handle = tokio::spawn(scheduled_refresh(
            weak,
            generation,
            delay.max(Duration::from_secs(1)),
        ));
        *lock_refresh(&self.refresh) = Some(handle);
    }

    fn abort_refresh(&self) {
        if let Some(handle) = lock_refresh(&self.refresh).take() {
            handle.abort();
        }
    }
}

impl Drop for AuthState {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn lock_refresh(
    refresh: &std::sync::Mutex<Option<JoinHandle<()>>>,
) -> std::sync::MutexGuard<'_, Option<JoinHandle<()>>> {
    refresh
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

async fn scheduled_refresh(weak: Weak<AuthState>, generation: u64, delay: Duration) {
    tokio::time::sleep(delay).await;
    let (fetcher, epoch) = {
        let Some(auth) = weak.upgrade() else {
            return;
        };
        if auth.generation() != generation {
            return;
        }
        // Capture, don't bump: bumping here would make a concurrent SDK
        // reconnect fetch look stale and skip Authenticate.
        let epoch = auth.fetch_epoch.load(Ordering::SeqCst);
        let fetcher = auth.slots.lock().await.fetcher.clone();
        (fetcher, epoch)
    };
    let Some(fetcher) = fetcher else {
        return;
    };
    let mut last_error = None;
    let refresh = async {
        let mut retry_delay = INITIAL_RETRY_DELAY;
        loop {
            match fetcher(true).await {
                Ok(token) => return Some(Ok(token)),
                Err(error) if error.is::<AuthSignedOut>() => return Some(Err(AuthSignedOut)),
                Err(error) => last_error = Some(format!("{error:#}")),
            }
            tokio::time::sleep(retry_delay).await;
            retry_delay = (retry_delay * 2).min(MAX_RETRY_DELAY);
            let auth = weak.upgrade()?;
            if auth.generation() != generation || auth.fetch_epoch.load(Ordering::SeqCst) != epoch {
                return None;
            }
        }
    };
    let token = match tokio::time::timeout(AUTH_RECOVERY_TIMEOUT, refresh).await {
        Ok(Some(token)) => token,
        Ok(None) => return,
        Err(_) => {
            if let Some(auth) = weak.upgrade()
                && auth.generation() == generation
                && auth.fetch_epoch.load(Ordering::SeqCst) == epoch
                && let Some(on_failure) = auth.on_failure.get()
            {
                on_failure(generation, recovery_timeout_error(last_error.as_deref())).await;
            }
            return;
        }
    };
    let Some(auth) = weak.upgrade() else {
        return;
    };
    if auth.generation() != generation || auth.fetch_epoch.load(Ordering::SeqCst) != epoch {
        return;
    }
    auth.slots.lock().await.pending_user_token = Some(token);
    let on_apply = auth.on_apply.get().cloned();
    drop(auth);
    if let Some(on_apply) = on_apply {
        on_apply(generation).await;
    }
}

fn recovery_timeout_error(last_error: Option<&str>) -> String {
    format!(
        "Convex authentication did not recover within {} seconds: {}",
        AUTH_RECOVERY_TIMEOUT.as_secs(),
        last_error.unwrap_or("token fetch did not complete")
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct JwtLifetime {
    iat: u64,
    exp: u64,
}

#[derive(Deserialize)]
struct JwtDates {
    iat: Option<u64>,
    exp: Option<u64>,
}

fn decode_jwt_lifetime(token: &str) -> Option<JwtLifetime> {
    let payload = token.split('.').nth(1)?;
    let decoded = URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?;
    let dates: JwtDates = serde_json::from_slice(&decoded).ok()?;
    Some(JwtLifetime {
        iat: dates.iat?,
        exp: dates.exp?,
    })
}

fn refresh_delay_for_token(token: &str, now: SystemTime) -> Option<Duration> {
    refresh_delay(decode_jwt_lifetime(token)?, now)
}

fn refresh_delay(lifetime: JwtLifetime, now: SystemTime) -> Option<Duration> {
    let full_secs = lifetime.exp.saturating_sub(lifetime.iat);
    if full_secs <= MIN_TOKEN_LIFETIME_SECS {
        return None;
    }
    let now_secs = now.duration_since(UNIX_EPOCH).ok()?.as_secs();
    let remaining_secs = lifetime.exp.saturating_sub(now_secs);
    // Fresh tokens: Convex JS uses `exp - iat` as validity starting now (clock-skew
    // safe). Cached tokens: remaining wall time is shorter and must win.
    let validity_secs = full_secs.min(remaining_secs);
    let delay_secs = validity_secs.saturating_sub(REFRESH_LEEWAY_SECS);
    Some(Duration::from_secs(delay_secs).min(MAXIMUM_REFRESH_DELAY))
}

#[cfg(test)]
mod tests;
