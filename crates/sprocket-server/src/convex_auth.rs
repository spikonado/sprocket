use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::anyhow;
use tokio::sync::Mutex;

use sprocket_convex::AuthTokenFetcher;

// WorkOS access tokens live ~5 minutes. Treat a token as stale a minute
// before its real expiry so an in-flight request never rides a dying token.
const EXPIRY_BUFFER: Duration = Duration::from_secs(60);
// How long a force_refresh waits for the browser to push a renewed token
// before falling back to the freshest cached copy.
const FORCE_REFRESH_WAIT: Duration = Duration::from_secs(10);
const FORCE_REFRESH_POLL: Duration = Duration::from_millis(150);

struct CachedToken {
    token: String,
    refresh_after: Option<Instant>,
}

/// Holds the caller's Convex JWT and hands fresh copies to the Convex client.
///
/// The browser owns the WorkOS session, so it pushes renewed access tokens to
/// the server (`POST /api/auth/convex-token`), which calls [`update`]. The
/// Convex client pulls via [`Self::fetcher`]. On `force_refresh` we wait
/// briefly for a pushed token that is fresher than the one Convex just
/// rejected, instead of replaying a token the backend already refused.
///
/// [`update`]: ConvexTokenProvider::update
/// [`Self::fetcher`]: ConvexTokenProvider::fetcher
#[derive(Clone, Default)]
pub struct ConvexTokenProvider {
    inner: Arc<Mutex<Option<CachedToken>>>,
}

impl ConvexTokenProvider {
    pub fn new() -> Self {
        Self::default()
    }

    /// Seeds the provider with an initial token (e.g. the one the browser sent
    /// when launching a run) before it is shared.
    pub async fn seeded(token: String) -> Self {
        let provider = Self::new();
        provider.update(token).await;
        provider
    }

    pub async fn update(&self, token: String) {
        let token = token.trim().to_string();
        if token.is_empty() {
            return;
        }
        let refresh_after =
            access_token_expiry(&token).and_then(|expiry| expiry.checked_sub(EXPIRY_BUFFER));
        *self.inner.lock().await = Some(CachedToken {
            token,
            refresh_after,
        });
    }

    pub fn fetcher(&self, label: &'static str) -> AuthTokenFetcher {
        let provider = self.clone();
        Arc::new(move |force_refresh| {
            let provider = provider.clone();
            Box::pin(async move {
                let token = if force_refresh {
                    provider.wait_for_fresh().await
                } else {
                    provider.current().await
                };
                match token {
                    Some(token) if !token.trim().is_empty() => Ok(token),
                    _ => Err(anyhow!("{label} auth token is unavailable")),
                }
            })
        })
    }

    async fn current(&self) -> Option<String> {
        self.inner
            .lock()
            .await
            .as_ref()
            .map(|cached| cached.token.clone())
    }

    /// Returns the cached token once it is fresh, waiting for a push. Falls
    /// back to the freshest cached copy after [`FORCE_REFRESH_WAIT`] so a dead
    /// browser degrades to the old behavior instead of hanging the client.
    async fn wait_for_fresh(&self) -> Option<String> {
        let deadline = Instant::now() + FORCE_REFRESH_WAIT;
        loop {
            {
                let guard = self.inner.lock().await;
                if let Some(cached) = guard.as_ref() {
                    if cached.is_fresh() {
                        return Some(cached.token.clone());
                    }
                }
            }
            if Instant::now() >= deadline {
                return self.current().await;
            }
            tokio::time::sleep(FORCE_REFRESH_POLL).await;
        }
    }
}

impl CachedToken {
    fn is_fresh(&self) -> bool {
        match self.refresh_after {
            Some(refresh_after) => Instant::now() < refresh_after,
            // Unknown expiry: treat as fresh and let Convex reject it if not.
            None => true,
        }
    }
}

/// Reads the `exp` claim without verifying the signature. The server never
/// trusts this token for its own authorization — it only forwards it to
/// Convex — so decoding (not verifying) is the correct operation here.
fn access_token_expiry(token: &str) -> Option<Instant> {
    let payload = token.split('.').nth(1)?;
    let decoded = base64_url_decode(payload)?;
    let claims: serde_json::Value = serde_json::from_slice(&decoded).ok()?;
    let exp_secs = claims.get("exp")?.as_u64()?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?;
    let expires_in = exp_secs.checked_sub(now.as_secs())?;
    Some(Instant::now() + Duration::from_secs(expires_in))
}

fn base64_url_decode(input: &str) -> Option<Vec<u8>> {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const TABLE: [u8; 128] = {
        let mut table = [0xFFu8; 128];
        let mut i = 0;
        while i < 64 {
            table[ALPHABET[i] as usize] = i as u8;
            i += 1;
        }
        table
    };

    let mut out = Vec::with_capacity(input.len() * 3 / 4);
    let mut acc: u32 = 0;
    let mut bits = 0;
    for byte in input.bytes() {
        if byte == b'=' {
            break;
        }
        if byte >= 128 {
            return None;
        }
        let value = TABLE[byte as usize];
        if value == 0xFF {
            return None;
        }
        acc = (acc << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base64_url_encode(bytes: &[u8]) -> String {
        const ALPHABET: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        let mut out = String::new();
        for chunk in bytes.chunks(3) {
            let b0 = chunk[0];
            let b1 = chunk.get(1).copied().unwrap_or(0);
            let b2 = chunk.get(2).copied().unwrap_or(0);
            let n = (u32::from(b0) << 16) | (u32::from(b1) << 8) | u32::from(b2);
            out.push(ALPHABET[(n >> 18) as usize & 63] as char);
            out.push(ALPHABET[(n >> 12) as usize & 63] as char);
            if chunk.len() > 1 {
                out.push(ALPHABET[(n >> 6) as usize & 63] as char);
            }
            if chunk.len() > 2 {
                out.push(ALPHABET[n as usize & 63] as char);
            }
        }
        out
    }

    fn unsigned_jwt(exp_offset_secs: i64) -> String {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        let exp = now + exp_offset_secs;
        let header = base64_url_encode(br#"{"alg":"none"}"#);
        let payload = base64_url_encode(format!(r#"{{"exp":{exp}}}"#).as_bytes());
        format!("{header}.{payload}.sig")
    }

    #[test]
    fn base64_roundtrip() {
        let data = b"hello world, this is a test!";
        let encoded = base64_url_encode(data);
        assert_eq!(base64_url_decode(&encoded).unwrap(), data);
    }

    #[tokio::test]
    async fn serves_seeded_token_without_force_refresh() {
        let provider = ConvexTokenProvider::seeded(unsigned_jwt(300)).await;
        let fetcher = provider.fetcher("test");
        let token = fetcher(false).await.expect("seeded token");
        assert!(!token.is_empty());
    }

    #[tokio::test]
    async fn force_refresh_returns_fresh_token_immediately() {
        let provider = ConvexTokenProvider::seeded(unsigned_jwt(300)).await;
        let fetcher = provider.fetcher("test");
        let token = tokio::time::timeout(Duration::from_millis(500), fetcher(true))
            .await
            .expect("fresh token should not wait")
            .expect("token");
        assert!(!token.is_empty());
    }

    #[tokio::test]
    async fn force_refresh_waits_for_pushed_token() {
        // Seed with an already-expired token so force_refresh must wait.
        let provider = ConvexTokenProvider::seeded(unsigned_jwt(-3600)).await;
        let fetcher = provider.fetcher("test");
        let pusher = provider.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            pusher.update(unsigned_jwt(300)).await;
        });
        let token = tokio::time::timeout(Duration::from_secs(3), fetcher(true))
            .await
            .expect("pushed token should arrive before the deadline")
            .expect("token");
        assert!(!token.is_empty());
    }

    #[tokio::test]
    async fn empty_token_is_rejected() {
        let provider = ConvexTokenProvider::new();
        let fetcher = provider.fetcher("test");
        assert!(fetcher(false).await.is_err());
    }
}
