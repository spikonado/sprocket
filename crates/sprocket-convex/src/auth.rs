use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::Context;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::Deserialize;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use crate::{AuthSignedOut, AuthTokenFetcher};

/// Matches Convex JS `authRefreshTokenLeewaySeconds` default.
const REFRESH_LEEWAY_SECS: u64 = 10;
/// Matches Convex JS: tokens shorter than this cannot be rescheduled.
const MIN_TOKEN_LIFETIME_SECS: u64 = 2;
/// Matches Convex JS `MAXIMUM_REFRESH_DELAY` (setTimeout's 32-bit cap).
const MAXIMUM_REFRESH_DELAY: Duration = Duration::from_secs(20 * 24 * 60 * 60);

pub(crate) type ApplyRefresh =
    Arc<dyn Fn(u64) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;

struct AuthSlots {
    fetcher: Option<AuthTokenFetcher>,
    pending_user_token: Option<Result<String, AuthSignedOut>>,
}

pub(crate) struct AuthState {
    generation: AtomicU64,
    fetch_epoch: AtomicU64,
    slots: Mutex<AuthSlots>,
    refresh: std::sync::Mutex<Option<JoinHandle<()>>>,
    on_apply: std::sync::OnceLock<ApplyRefresh>,
}

impl AuthState {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self {
            generation: AtomicU64::new(0),
            fetch_epoch: AtomicU64::new(0),
            slots: Mutex::new(AuthSlots {
                fetcher: None,
                pending_user_token: None,
            }),
            refresh: std::sync::Mutex::new(None),
            on_apply: std::sync::OnceLock::new(),
        })
    }

    pub(crate) fn set_on_apply(&self, on_apply: ApplyRefresh) {
        let _ = self.on_apply.set(on_apply);
    }

    pub(crate) fn shutdown(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.fetch_epoch.fetch_add(1, Ordering::SeqCst);
        self.abort_refresh();
    }

    pub(crate) fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    pub(crate) async fn install(self: &Arc<Self>, fetcher: AuthTokenFetcher) -> u64 {
        self.abort_refresh();
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.fetch_epoch.fetch_add(1, Ordering::SeqCst);
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
        if self.generation.load(Ordering::SeqCst) != generation {
            anyhow::bail!("stale auth callback");
        }

        let (fetcher, pending, epoch) = {
            let mut slots = self.slots.lock().await;
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

        let token = if let Some(token) = pending {
            token?
        } else {
            let fetcher = fetcher.context("auth fetcher missing")?;
            let token = fetcher(force_refresh).await?;
            if self.generation.load(Ordering::SeqCst) != generation
                || self.fetch_epoch.load(Ordering::SeqCst) != epoch
            {
                anyhow::bail!("stale auth callback");
            }
            token
        };

        Ok(token)
    }

    pub(crate) async fn arm(self: &Arc<Self>, generation: u64, token: &str) {
        if self.generation.load(Ordering::SeqCst) != generation {
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
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.fetch_epoch.fetch_add(1, Ordering::SeqCst);
        if let Some(handle) = self
            .refresh
            .get_mut()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
        {
            handle.abort();
        }
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
        if auth.generation.load(Ordering::SeqCst) != generation {
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
    let mut retry_delay = Duration::from_secs(1);
    let token = loop {
        match fetcher(true).await {
            Ok(token) => break Ok(token),
            Err(error) if error.is::<AuthSignedOut>() => break Err(AuthSignedOut),
            Err(_) => {}
        }
        tokio::time::sleep(retry_delay).await;
        retry_delay = (retry_delay * 2).min(Duration::from_secs(30));
        let Some(auth) = weak.upgrade() else {
            return;
        };
        if auth.generation() != generation || auth.fetch_epoch.load(Ordering::SeqCst) != epoch {
            return;
        }
    };
    let Some(auth) = weak.upgrade() else {
        return;
    };
    if auth.generation.load(Ordering::SeqCst) != generation
        || auth.fetch_epoch.load(Ordering::SeqCst) != epoch
    {
        return;
    }
    auth.slots.lock().await.pending_user_token = Some(token);
    let on_apply = auth.on_apply.get().cloned();
    drop(auth);
    if let Some(on_apply) = on_apply {
        on_apply(generation).await;
    }
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
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::time::Duration;

    use serde_json::json;
    use tokio::sync::{mpsc, oneshot};
    use tokio::time;

    fn encode_json(value: serde_json::Value) -> String {
        URL_SAFE_NO_PAD.encode(value.to_string().as_bytes())
    }

    fn jwt(iat: u64, exp: u64) -> String {
        format!(
            "{}.{}.sig",
            encode_json(json!({ "alg": "none", "typ": "JWT" })),
            encode_json(json!({ "iat": iat, "exp": exp })),
        )
    }

    fn unix(now: SystemTime) -> u64 {
        now.duration_since(UNIX_EPOCH).expect("unix time").as_secs()
    }

    fn counting_fetcher(fetches: Arc<Mutex<Vec<bool>>>, token: String) -> AuthTokenFetcher {
        Arc::new(move |force_refresh| {
            let fetches = Arc::clone(&fetches);
            let token = token.clone();
            Box::pin(async move {
                fetches.lock().await.push(force_refresh);
                Ok(token)
            })
        })
    }

    #[test]
    fn refresh_delay_uses_remaining_lifetime_for_cached_tokens() {
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000);
        let delay = refresh_delay(
            JwtLifetime {
                iat: 900,
                exp: 1_040,
            },
            now,
        )
        .expect("schedulable");
        // remaining 40s, leeway 10s -> 30s, not the 140s full lifetime.
        assert_eq!(delay, Duration::from_secs(30));
    }

    #[test]
    fn refresh_delay_uses_full_lifetime_when_token_is_fresh() {
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000);
        let delay = refresh_delay(
            JwtLifetime {
                iat: 1_000,
                exp: 1_130,
            },
            now,
        )
        .expect("schedulable");
        assert_eq!(delay, Duration::from_secs(120));
    }

    #[test]
    fn refresh_delay_is_immediate_inside_leeway() {
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000);
        let delay = refresh_delay(
            JwtLifetime {
                iat: 990,
                exp: 1_005,
            },
            now,
        )
        .expect("schedulable");
        assert_eq!(delay, Duration::ZERO);
    }

    #[test]
    fn refresh_delay_skips_tokens_that_do_not_live_long_enough() {
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000);
        assert_eq!(
            refresh_delay(
                JwtLifetime {
                    iat: 1_000,
                    exp: 1_002,
                },
                now,
            ),
            None
        );
    }

    #[test]
    fn refresh_delay_caps_at_maximum() {
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000);
        let delay = refresh_delay(
            JwtLifetime {
                iat: 1_000,
                exp: 1_000 + 40 * 24 * 60 * 60,
            },
            now,
        )
        .expect("schedulable");
        assert_eq!(delay, MAXIMUM_REFRESH_DELAY);
    }

    #[test]
    fn decode_jwt_lifetime_rejects_non_jwt() {
        assert_eq!(decode_jwt_lifetime("not-a-jwt"), None);
        assert_eq!(decode_jwt_lifetime("a.b"), None);
    }

    fn token_with_refresh_delay(delay: Duration) -> String {
        let now = unix(SystemTime::now());
        let lifetime = delay.as_secs() + REFRESH_LEEWAY_SECS;
        jwt(now, now + lifetime)
    }

    #[tokio::test(start_paused = true)]
    async fn scheduled_refresh_fetches_with_force_refresh() {
        let auth = AuthState::new();
        let fetches = Arc::new(Mutex::new(Vec::new()));
        let token = token_with_refresh_delay(Duration::from_secs(60));
        let generation = auth
            .install(counting_fetcher(Arc::clone(&fetches), token.clone()))
            .await;
        let (applied, mut applied_rx) = mpsc::unbounded_channel();
        auth.set_on_apply(Arc::new(move |generation| {
            let applied = applied.clone();
            Box::pin(async move {
                let _ = applied.send(generation);
            })
        }));

        auth.arm(generation, &token).await;
        time::advance(Duration::from_secs(50)).await;
        assert!(fetches.lock().await.is_empty());
        time::advance(Duration::from_secs(20)).await;
        assert_eq!(applied_rx.recv().await, Some(generation));
        assert_eq!(*fetches.lock().await, vec![true]);
        assert_eq!(
            auth.slots
                .lock()
                .await
                .pending_user_token
                .as_ref()
                .and_then(|token| token.as_ref().ok())
                .map(String::as_str),
            Some(token.as_str())
        );
    }

    #[tokio::test(start_paused = true)]
    async fn clear_cancels_scheduled_refresh() {
        let auth = AuthState::new();
        let fetches = Arc::new(Mutex::new(Vec::new()));
        let token = token_with_refresh_delay(Duration::from_secs(60));
        let generation = auth
            .install(counting_fetcher(Arc::clone(&fetches), token.clone()))
            .await;
        let applied = Arc::new(AtomicUsize::new(0));
        let applied_count = Arc::clone(&applied);
        auth.set_on_apply(Arc::new(move |_| {
            let applied_count = Arc::clone(&applied_count);
            Box::pin(async move {
                applied_count.fetch_add(1, Ordering::SeqCst);
            })
        }));

        auth.arm(generation, &token).await;
        auth.clear().await;
        time::advance(Duration::from_secs(90)).await;
        tokio::task::yield_now().await;

        assert!(fetches.lock().await.is_empty());
        assert_eq!(applied.load(Ordering::SeqCst), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn scheduled_refresh_retries_failure_without_waiting_for_token_expiry() {
        let auth = AuthState::new();
        let attempts = Arc::new(AtomicUsize::new(0));
        let token = token_with_refresh_delay(Duration::from_secs(60));
        let generation = auth
            .install(Arc::new({
                let attempts = Arc::clone(&attempts);
                let token = token.clone();
                move |force_refresh| {
                    let attempts = Arc::clone(&attempts);
                    let token = token.clone();
                    Box::pin(async move {
                        assert!(force_refresh);
                        if attempts.fetch_add(1, Ordering::SeqCst) == 0 {
                            anyhow::bail!("temporarily unavailable");
                        }
                        Ok(token)
                    })
                }
            }))
            .await;
        let (applied, mut applied_rx) = mpsc::unbounded_channel();
        auth.set_on_apply(Arc::new(move |generation| {
            let applied = applied.clone();
            Box::pin(async move {
                let _ = applied.send(generation);
            })
        }));
        auth.arm(generation, &token).await;
        assert_eq!(applied_rx.recv().await, Some(generation));
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn signed_out_refresh_is_applied_once_without_retrying() {
        let auth = AuthState::new();
        let generation = auth
            .install(Arc::new(|_| Box::pin(async { Err(AuthSignedOut.into()) })))
            .await;
        let (applied, mut applied_rx) = mpsc::unbounded_channel();
        auth.set_on_apply(Arc::new(move |generation| {
            let applied = applied.clone();
            Box::pin(async move {
                let _ = applied.send(generation);
            })
        }));
        auth.arm(
            generation,
            &token_with_refresh_delay(Duration::from_secs(10)),
        )
        .await;
        assert_eq!(applied_rx.recv().await, Some(generation));
        assert!(
            auth.resolve(generation, false)
                .await
                .unwrap_err()
                .is::<AuthSignedOut>()
        );
        time::advance(Duration::from_secs(120)).await;
        assert!(applied_rx.try_recv().is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn replacement_aborts_the_previous_schedule() {
        let auth = AuthState::new();
        let fetches = Arc::new(Mutex::new(Vec::new()));
        let first = token_with_refresh_delay(Duration::from_secs(120));
        let second = token_with_refresh_delay(Duration::from_secs(60));
        let generation = auth
            .install(counting_fetcher(Arc::clone(&fetches), second.clone()))
            .await;
        let (applied, mut applied_rx) = mpsc::unbounded_channel();
        auth.set_on_apply(Arc::new(move |_| {
            let applied = applied.clone();
            Box::pin(async move {
                let _ = applied.send(());
            })
        }));

        auth.arm(generation, &first).await;
        auth.arm(generation, &second).await;
        time::advance(Duration::from_secs(61)).await;
        applied_rx.recv().await.expect("second schedule applied");
        assert_eq!(fetches.lock().await.len(), 1);

        time::advance(Duration::from_secs(120)).await;
        tokio::task::yield_now().await;
        assert_eq!(fetches.lock().await.len(), 1);
        assert!(applied_rx.try_recv().is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn last_clone_drop_aborts_scheduled_refresh() {
        let auth = AuthState::new();
        let fetches = Arc::new(Mutex::new(Vec::new()));
        let token = token_with_refresh_delay(Duration::from_secs(60));
        let generation = auth
            .install(counting_fetcher(Arc::clone(&fetches), token.clone()))
            .await;
        let applied = Arc::new(AtomicUsize::new(0));
        let applied_count = Arc::clone(&applied);
        auth.set_on_apply(Arc::new(move |_| {
            let applied_count = Arc::clone(&applied_count);
            Box::pin(async move {
                applied_count.fetch_add(1, Ordering::SeqCst);
            })
        }));
        auth.arm(generation, &token).await;

        let clone = Arc::clone(&auth);
        drop(clone);
        drop(auth);
        time::advance(Duration::from_secs(90)).await;
        tokio::task::yield_now().await;

        assert!(fetches.lock().await.is_empty());
        assert_eq!(applied.load(Ordering::SeqCst), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn last_clone_drop_does_not_wait_for_a_hung_refresh_fetch() {
        let auth = AuthState::new();
        let (started_tx, started_rx) = oneshot::channel();
        let started_tx = Arc::new(Mutex::new(Some(started_tx)));
        let dropped = Arc::new(AtomicUsize::new(0));
        let dropped_count = Arc::clone(&dropped);
        let fetcher: AuthTokenFetcher = Arc::new(move |_force_refresh| {
            let dropped_count = Arc::clone(&dropped_count);
            let started_tx = Arc::clone(&started_tx);
            Box::pin(async move {
                struct Flag(Arc<AtomicUsize>);
                impl Drop for Flag {
                    fn drop(&mut self) {
                        self.0.fetch_add(1, Ordering::SeqCst);
                    }
                }
                let _flag = Flag(dropped_count);
                let _ = started_tx
                    .lock()
                    .await
                    .take()
                    .expect("refresh starts once")
                    .send(());
                std::future::pending::<()>().await;
                Ok("unused".to_string())
            })
        });
        let token = token_with_refresh_delay(Duration::ZERO);
        let generation = auth.install(fetcher).await;
        auth.arm(generation, &token).await;
        time::advance(Duration::from_millis(1)).await;
        started_rx.await.expect("refresh fetch started");

        let started_at = std::time::Instant::now();
        drop(auth);
        assert!(started_at.elapsed() < Duration::from_millis(200));
        tokio::task::yield_now().await;
        for _ in 0..16 {
            if dropped.load(Ordering::SeqCst) == 1 {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert_eq!(dropped.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn resolve_preserves_forced_refresh_and_uses_pending_for_callback_apply() {
        let auth = AuthState::new();
        let fetches = Arc::new(Mutex::new(Vec::new()));
        let token = "cached-token".to_string();
        let generation = auth
            .install(counting_fetcher(Arc::clone(&fetches), token.clone()))
            .await;

        assert_eq!(auth.resolve(generation, true).await.expect("forced"), token);
        assert_eq!(*fetches.lock().await, vec![true]);

        auth.slots.lock().await.pending_user_token = Some(Ok("pending-token".to_string()));
        assert_eq!(
            auth.resolve(generation, false).await.expect("pending"),
            "pending-token"
        );
        assert_eq!(*fetches.lock().await, vec![true]);
        assert!(auth.slots.lock().await.pending_user_token.is_none());

        assert_eq!(
            auth.resolve(generation, false).await.expect("cached"),
            token
        );
        assert_eq!(*fetches.lock().await, vec![true, false]);
    }

    #[tokio::test]
    async fn resolve_does_not_apply_after_clear() {
        let auth = AuthState::new();
        let (continue_tx, continue_rx) = oneshot::channel();
        let continue_rx = Arc::new(Mutex::new(Some(continue_rx)));
        let fetcher: AuthTokenFetcher = Arc::new(move |force_refresh| {
            let continue_rx = Arc::clone(&continue_rx);
            Box::pin(async move {
                if let Some(continue_rx) = continue_rx.lock().await.take() {
                    continue_rx.await.expect("continue");
                }
                Ok(format!("token-{force_refresh}"))
            })
        });
        let generation = auth.install(fetcher).await;
        let resolve = {
            let auth = Arc::clone(&auth);
            tokio::spawn(async move { auth.resolve(generation, true).await })
        };
        tokio::task::yield_now().await;
        auth.clear().await;
        continue_tx.send(()).expect("unblock fetch");
        assert!(resolve.await.expect("join").is_err());
    }
}
