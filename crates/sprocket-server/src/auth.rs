use std::collections::HashMap;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::http::HeaderMap;
use axum_extra::extract::CookieJar;
use cookie::{Cookie, SameSite};
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, RwLock};
use uuid::Uuid;

use crate::config::SESSION_COOKIE_NAME;

const PAIRING_CREDENTIAL_FILE: &str = "pairing-credential";
const SESSIONS_FILE: &str = "sessions.json";
const SESSION_MAX_AGE_SECS: i64 = 60 * 60 * 24 * 30;
const SESSION_MAX_AGE_MS: u64 = SESSION_MAX_AGE_SECS as u64 * 1000;
const DESKTOP_LOGIN_TTL: Duration = Duration::from_secs(5 * 60);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthSessionResponse {
    pub authenticated: bool,
    pub role: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapRequest {
    pub credential: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapResponse {
    pub authenticated: bool,
    pub role: String,
}

pub struct AuthState {
    data_dir: PathBuf,
    pairing_credential: String,
    sessions: RwLock<HashMap<String, SessionRecord>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopLoginStartResponse {
    pub ok: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum DesktopLoginResultResponse {
    Pending,
    #[serde(rename_all = "camelCase")]
    Complete {
        code: String,
        state: String,
    },
    #[serde(rename_all = "camelCase")]
    Failed {
        error: String,
    },
}

#[derive(Debug, Clone)]
enum DesktopLoginOutcome {
    Complete { code: String, state: String },
    Failed { error: String },
}

#[derive(Debug)]
struct DesktopLoginAttempt {
    session_token: String,
    created_at: Instant,
    outcome: Option<DesktopLoginOutcome>,
}

#[derive(Debug, Default)]
struct DesktopLoginAttempts {
    /// Primary index: nonce uniquely identifies one pending/completed attempt.
    by_nonce: HashMap<String, DesktopLoginAttempt>,
    /// Secondary index for authenticated polling/cancel by local session token.
    by_session: HashMap<String, String>,
}

/// One-shot in-memory store for the RFC 8252 loopback desktop login handshake.
///
/// Attempts are keyed by nonce so the unauthenticated callback binds deterministically
/// to exactly one attempt. Polling and cancel remain authenticated by session token.
pub struct DesktopLoginStore {
    attempts: Mutex<DesktopLoginAttempts>,
}

impl DesktopLoginStore {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            attempts: Mutex::new(DesktopLoginAttempts::default()),
        })
    }

    pub async fn start(&self, session_token: &str, nonce: &str) -> anyhow::Result<()> {
        let session_token = session_token.trim();
        let nonce = nonce.trim();
        if session_token.is_empty() {
            anyhow::bail!("desktop login session is missing");
        }
        if nonce.is_empty() {
            anyhow::bail!("desktop login state must not be empty");
        }

        let mut attempts = self.attempts.lock().await;
        purge_expired(&mut attempts);

        if let Some(existing) = attempts.by_nonce.get(nonce)
            && existing.session_token != session_token
        {
            anyhow::bail!("desktop login state is already in use");
        }

        if let Some(previous_nonce) = attempts.by_session.remove(session_token) {
            attempts.by_nonce.remove(&previous_nonce);
        }

        attempts.by_nonce.insert(
            nonce.to_string(),
            DesktopLoginAttempt {
                session_token: session_token.to_string(),
                created_at: Instant::now(),
                outcome: None,
            },
        );
        attempts
            .by_session
            .insert(session_token.to_string(), nonce.to_string());
        Ok(())
    }

    pub async fn complete_callback(&self, code: &str, state: &str) -> anyhow::Result<()> {
        let code = code.trim();
        if code.is_empty() {
            anyhow::bail!("authorization code is missing");
        }

        let nonce = extract_nonce_from_state(state)?;
        let mut attempts = self.attempts.lock().await;
        purge_expired(&mut attempts);

        let Some(attempt) = attempts.by_nonce.get_mut(&nonce) else {
            anyhow::bail!("no pending desktop login attempt");
        };
        if attempt.outcome.is_some() {
            anyhow::bail!("desktop login already completed");
        }

        attempt.outcome = Some(DesktopLoginOutcome::Complete {
            code: code.to_string(),
            state: state.to_string(),
        });
        Ok(())
    }

    pub async fn fail_callback(&self, error: &str, state: &str) -> anyhow::Result<()> {
        let error = error.trim();
        if error.is_empty() {
            anyhow::bail!("desktop login error is missing");
        }

        let nonce = extract_nonce_from_state(state)?;
        let mut attempts = self.attempts.lock().await;
        purge_expired(&mut attempts);

        let Some(attempt) = attempts.by_nonce.get_mut(&nonce) else {
            anyhow::bail!("no pending desktop login attempt");
        };
        if attempt.outcome.is_some() {
            anyhow::bail!("desktop login already completed");
        }

        attempt.outcome = Some(DesktopLoginOutcome::Failed {
            error: error.to_string(),
        });
        Ok(())
    }

    pub async fn take_result(&self, session_token: &str) -> DesktopLoginResultResponse {
        let mut attempts = self.attempts.lock().await;
        purge_expired(&mut attempts);

        let Some(nonce) = attempts.by_session.get(session_token).cloned() else {
            return DesktopLoginResultResponse::Pending;
        };
        let Some(attempt) = attempts.by_nonce.get(&nonce) else {
            attempts.by_session.remove(session_token);
            return DesktopLoginResultResponse::Pending;
        };

        let Some(outcome) = attempt.outcome.clone() else {
            return DesktopLoginResultResponse::Pending;
        };

        remove_attempt(&mut attempts, session_token, &nonce);
        match outcome {
            DesktopLoginOutcome::Complete { code, state } => {
                DesktopLoginResultResponse::Complete { code, state }
            }
            DesktopLoginOutcome::Failed { error } => DesktopLoginResultResponse::Failed { error },
        }
    }

    pub async fn cancel(&self, session_token: &str, nonce: &str) -> bool {
        let nonce = nonce.trim();
        let mut attempts = self.attempts.lock().await;
        purge_expired(&mut attempts);

        if attempts
            .by_session
            .get(session_token)
            .is_some_and(|mapped| mapped == nonce)
        {
            remove_attempt(&mut attempts, session_token, nonce);
            true
        } else {
            false
        }
    }

    #[cfg(test)]
    pub async fn expire_for_test(&self, session_token: &str) {
        let mut attempts = self.attempts.lock().await;
        let Some(nonce) = attempts.by_session.get(session_token).cloned() else {
            return;
        };
        if let Some(attempt) = attempts.by_nonce.get_mut(&nonce) {
            attempt.created_at = Instant::now() - DESKTOP_LOGIN_TTL - Duration::from_secs(1);
        }
    }
}

/// WorkOS AuthKit allows `http://127.0.0.1:*/...` loopback redirect URIs for native apps.
pub fn desktop_login_callback_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/api/auth/desktop-login/callback")
}

/// Hosts that can accept connections to the dedicated 127.0.0.1 callback URL.
pub fn host_supports_loopback_desktop_login(host: &str) -> bool {
    matches!(host.trim(), "127.0.0.1" | "0.0.0.0")
}

/// Whether the TCP peer may complete the unauthenticated desktop login callback.
///
/// Uses the real socket peer address from Axum `ConnectInfo`, never request headers.
pub fn peer_may_complete_desktop_login_callback(peer: std::net::SocketAddr) -> bool {
    peer.ip().is_loopback()
}

fn extract_nonce_from_state(state: &str) -> anyhow::Result<String> {
    let trimmed = state.trim();
    if trimmed.is_empty() {
        anyhow::bail!("desktop login state is missing");
    }

    // AuthKit round-trips `state` as JSON.stringify({ nonce }).
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) {
        if let Some(nonce) = value
            .get("nonce")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return Ok(nonce.to_string());
        }
    }

    // Also accept a bare nonce string for simpler clients/tests.
    Ok(trimmed.to_string())
}

fn remove_attempt(attempts: &mut DesktopLoginAttempts, session_token: &str, nonce: &str) {
    attempts.by_nonce.remove(nonce);
    attempts.by_session.remove(session_token);
}

fn purge_expired(attempts: &mut DesktopLoginAttempts) {
    let expired_nonces: Vec<String> = attempts
        .by_nonce
        .iter()
        .filter(|(_, attempt)| attempt.created_at.elapsed() > DESKTOP_LOGIN_TTL)
        .map(|(nonce, _)| nonce.clone())
        .collect();

    for nonce in expired_nonces {
        if let Some(attempt) = attempts.by_nonce.remove(&nonce) {
            if attempts
                .by_session
                .get(&attempt.session_token)
                .is_some_and(|mapped| mapped == &nonce)
            {
                attempts.by_session.remove(&attempt.session_token);
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionRecord {
    role: String,
    created_at: u64,
}

impl AuthState {
    pub fn load(data_dir: &Path) -> anyhow::Result<Arc<Self>> {
        fs::create_dir_all(data_dir)?;

        let credential_path = data_dir.join(PAIRING_CREDENTIAL_FILE);
        let pairing_credential = if let Ok(existing) = fs::read_to_string(&credential_path) {
            existing.trim().to_string()
        } else {
            let credential = Uuid::new_v4().to_string();
            fs::write(&credential_path, format!("{credential}\n"))?;
            credential
        };

        if pairing_credential.is_empty() {
            anyhow::bail!("pairing credential must not be empty");
        }

        let sessions = load_sessions(&data_dir)?;

        Ok(Arc::new(Self {
            data_dir: data_dir.to_path_buf(),
            pairing_credential,
            sessions: RwLock::new(sessions),
        }))
    }

    pub fn pairing_credential(&self) -> &str {
        &self.pairing_credential
    }

    pub async fn session_state(&self, session_token: Option<&str>) -> AuthSessionResponse {
        let Some(session_token) = session_token else {
            return AuthSessionResponse {
                authenticated: false,
                role: None,
            };
        };

        let session = {
            let sessions = self.sessions.read().await;
            sessions.get(session_token).cloned()
        };
        let Some(session) = session else {
            return AuthSessionResponse {
                authenticated: false,
                role: None,
            };
        };

        if session_is_expired(&session) {
            let snapshot = {
                let mut sessions = self.sessions.write().await;
                sessions.remove(session_token);
                sessions_snapshot(&sessions)
            };
            if let Err(error) = self.save_sessions(snapshot).await {
                tracing::warn!("failed to persist expired session removal: {error}");
            }
            return AuthSessionResponse {
                authenticated: false,
                role: None,
            };
        }

        AuthSessionResponse {
            authenticated: true,
            role: Some(session.role.clone()),
        }
    }

    pub async fn bootstrap(&self, credential: &str) -> anyhow::Result<(BootstrapResponse, String)> {
        if credential.trim() != self.pairing_credential {
            anyhow::bail!(
                "invalid pairing credential; use the token printed by your running Sprocket server"
            );
        }

        let session_token = Uuid::new_v4().to_string();
        self.sessions.write().await.insert(
            session_token.clone(),
            SessionRecord {
                role: "owner".to_string(),
                created_at: now_ms(),
            },
        );
        self.persist_sessions().await?;

        Ok((
            BootstrapResponse {
                authenticated: true,
                role: "owner".to_string(),
            },
            session_token,
        ))
    }

    pub fn make_session_cookie(session_token: &str) -> Cookie<'static> {
        Cookie::build((SESSION_COOKIE_NAME, session_token.to_string()))
            .http_only(true)
            .path("/")
            .same_site(SameSite::Lax)
            .max_age(cookie::time::Duration::seconds(SESSION_MAX_AGE_SECS))
            .build()
    }

    async fn persist_sessions(&self) -> anyhow::Result<()> {
        let snapshot = {
            let sessions = self.sessions.read().await;
            sessions_snapshot(&sessions)
        };
        self.save_sessions(snapshot).await
    }

    async fn save_sessions(&self, snapshot: Vec<PersistedSessionRecord>) -> anyhow::Result<()> {
        let sessions_path = self.data_dir.join(SESSIONS_FILE);
        let payload = serde_json::to_string_pretty(&snapshot)?;
        tokio::fs::write(sessions_path, payload).await?;
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedSessionRecord {
    token: String,
    #[serde(flatten)]
    session: SessionRecord,
}

pub fn extract_session_token(headers: &HeaderMap, jar: &CookieJar) -> Option<String> {
    if let Some(auth_header) = headers.get(axum::http::header::AUTHORIZATION)
        && let Ok(value) = auth_header.to_str()
        && let Some(token) = value.strip_prefix("Bearer ")
    {
        return Some(token.trim().to_string());
    }

    jar.get(SESSION_COOKIE_NAME)
        .map(|cookie| cookie.value().to_string())
}

pub async fn require_session(
    auth: &AuthState,
    headers: &HeaderMap,
    jar: &CookieJar,
) -> anyhow::Result<String> {
    let session_token = extract_session_token(headers, jar)
        .ok_or_else(|| anyhow::anyhow!("authentication required"))?;
    let session = auth.session_state(Some(&session_token)).await;
    if !session.authenticated {
        anyhow::bail!("authentication required");
    }
    Ok(session_token)
}

fn load_sessions(data_dir: &Path) -> anyhow::Result<HashMap<String, SessionRecord>> {
    let sessions_path = data_dir.join(SESSIONS_FILE);
    let contents = match fs::read_to_string(&sessions_path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(HashMap::new()),
        Err(error) => return Err(error.into()),
    };

    let records: Vec<PersistedSessionRecord> = match serde_json::from_str(&contents) {
        Ok(records) => records,
        Err(error) => {
            tracing::warn!(
                "failed to parse persisted sessions at {}: {error}",
                sessions_path.display()
            );
            return Ok(HashMap::new());
        }
    };
    Ok(records
        .into_iter()
        .filter(|record| !session_is_expired(&record.session))
        .map(|record| (record.token, record.session))
        .collect())
}

fn sessions_snapshot(sessions: &HashMap<String, SessionRecord>) -> Vec<PersistedSessionRecord> {
    sessions
        .iter()
        .filter(|(_, session)| !session_is_expired(session))
        .map(|(token, session)| PersistedSessionRecord {
            token: token.clone(),
            session: session.clone(),
        })
        .collect()
}

fn session_is_expired(session: &SessionRecord) -> bool {
    now_ms().saturating_sub(session.created_at) > SESSION_MAX_AGE_MS
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn bootstrap_creates_authenticated_session() {
        let temp_dir = std::env::temp_dir().join(format!("sprocket-auth-test-{}", Uuid::new_v4()));
        let auth = AuthState::load(&temp_dir).expect("auth state");
        let credential = auth.pairing_credential().to_string();

        let (response, session_token) = auth
            .bootstrap(&credential)
            .await
            .expect("bootstrap should succeed");
        assert!(response.authenticated);
        assert_eq!(response.role, "owner");

        let session = auth.session_state(Some(&session_token)).await;
        assert!(session.authenticated);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[tokio::test]
    async fn bootstrap_persists_authenticated_session() {
        let temp_dir = std::env::temp_dir().join(format!("sprocket-auth-test-{}", Uuid::new_v4()));
        let auth = AuthState::load(&temp_dir).expect("auth state");
        let credential = auth.pairing_credential().to_string();

        let (_, session_token) = auth
            .bootstrap(&credential)
            .await
            .expect("bootstrap should succeed");

        let reloaded = AuthState::load(&temp_dir).expect("reloaded auth state");
        let session = reloaded.session_state(Some(&session_token)).await;
        assert!(session.authenticated);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[tokio::test]
    async fn desktop_login_completes_with_matching_nonce() {
        let store = DesktopLoginStore::new();
        store.start("session-a", "nonce-1").await.expect("start");

        store
            .complete_callback("auth-code", r#"{"nonce":"nonce-1"}"#)
            .await
            .expect("callback");

        match store.take_result("session-a").await {
            DesktopLoginResultResponse::Complete { code, state } => {
                assert_eq!(code, "auth-code");
                assert_eq!(state, r#"{"nonce":"nonce-1"}"#);
            }
            other => panic!("expected complete result, got {other:?}"),
        }

        assert!(matches!(
            store.take_result("session-a").await,
            DesktopLoginResultResponse::Pending
        ));
    }

    #[tokio::test]
    async fn desktop_login_rejects_mismatched_nonce() {
        let store = DesktopLoginStore::new();
        store.start("session-a", "nonce-1").await.expect("start");

        let error = store
            .complete_callback("auth-code", r#"{"nonce":"nonce-2"}"#)
            .await
            .expect_err("mismatched nonce should fail");
        assert!(
            error
                .to_string()
                .contains("no pending desktop login attempt")
        );
    }

    #[tokio::test]
    async fn desktop_login_start_replaces_prior_attempt_for_same_session() {
        let store = DesktopLoginStore::new();
        store.start("session-a", "nonce-1").await.expect("start");
        store.start("session-a", "nonce-2").await.expect("start");

        let error = store
            .complete_callback("auth-code", r#"{"nonce":"nonce-1"}"#)
            .await
            .expect_err("old nonce should no longer match");
        assert!(
            error
                .to_string()
                .contains("no pending desktop login attempt")
        );

        store
            .complete_callback("auth-code", r#"{"nonce":"nonce-2"}"#)
            .await
            .expect("callback with latest nonce");
    }

    #[tokio::test]
    async fn desktop_login_isolates_concurrent_sessions() {
        let store = DesktopLoginStore::new();
        store.start("session-a", "nonce-a").await.expect("start a");
        store.start("session-b", "nonce-b").await.expect("start b");

        store
            .complete_callback("code-a", r#"{"nonce":"nonce-a"}"#)
            .await
            .expect("callback a");

        assert!(matches!(
            store.take_result("session-b").await,
            DesktopLoginResultResponse::Pending
        ));

        match store.take_result("session-a").await {
            DesktopLoginResultResponse::Complete { code, .. } => assert_eq!(code, "code-a"),
            other => panic!("expected complete for session-a, got {other:?}"),
        }

        store
            .complete_callback("code-b", r#"{"nonce":"nonce-b"}"#)
            .await
            .expect("callback b");

        match store.take_result("session-b").await {
            DesktopLoginResultResponse::Complete { code, .. } => assert_eq!(code, "code-b"),
            other => panic!("expected complete for session-b, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn desktop_login_provider_error_is_terminal() {
        let store = DesktopLoginStore::new();
        store.start("session-a", "nonce-1").await.expect("start");

        store
            .fail_callback(
                "access_denied: Sign-in was cancelled or failed.",
                r#"{"nonce":"nonce-1"}"#,
            )
            .await
            .expect("fail callback");

        match store.take_result("session-a").await {
            DesktopLoginResultResponse::Failed { error } => {
                assert!(error.contains("access_denied"));
            }
            other => panic!("expected failed result, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn desktop_login_cancel_clears_pending_attempt() {
        let store = DesktopLoginStore::new();
        store.start("session-a", "nonce-1").await.expect("start");
        assert!(store.cancel("session-a", "nonce-1").await);

        let error = store
            .complete_callback("auth-code", r#"{"nonce":"nonce-1"}"#)
            .await
            .expect_err("cancelled attempt should be gone");
        assert!(
            error
                .to_string()
                .contains("no pending desktop login attempt")
        );
    }

    #[tokio::test]
    async fn stale_desktop_login_cancel_preserves_replacement_attempt() {
        let store = DesktopLoginStore::new();
        store
            .start("session-a", "nonce-old")
            .await
            .expect("start old");
        store
            .start("session-a", "nonce-new")
            .await
            .expect("start new");

        assert!(!store.cancel("session-a", "nonce-old").await);

        store
            .complete_callback("auth-code", r#"{"nonce":"nonce-new"}"#)
            .await
            .expect("replacement callback");
        assert!(matches!(
            store.take_result("session-a").await,
            DesktopLoginResultResponse::Complete { .. }
        ));
    }

    #[tokio::test]
    async fn desktop_login_expires_pending_attempt() {
        let store = DesktopLoginStore::new();
        store.start("session-a", "nonce-1").await.expect("start");
        store.expire_for_test("session-a").await;

        let error = store
            .complete_callback("auth-code", r#"{"nonce":"nonce-1"}"#)
            .await
            .expect_err("expired attempt should be gone");
        assert!(
            error
                .to_string()
                .contains("no pending desktop login attempt")
        );
        assert!(matches!(
            store.take_result("session-a").await,
            DesktopLoginResultResponse::Pending
        ));
    }

    #[tokio::test]
    async fn desktop_login_rejects_nonce_collision_across_sessions() {
        let store = DesktopLoginStore::new();
        store
            .start("session-a", "shared-nonce")
            .await
            .expect("start a");

        let error = store
            .start("session-b", "shared-nonce")
            .await
            .expect_err("colliding nonce should be rejected");
        assert!(error.to_string().contains("already in use"));

        store
            .complete_callback("code-a", r#"{"nonce":"shared-nonce"}"#)
            .await
            .expect("original session still owns nonce");

        match store.take_result("session-a").await {
            DesktopLoginResultResponse::Complete { code, .. } => assert_eq!(code, "code-a"),
            other => panic!("expected complete for session-a, got {other:?}"),
        }
        assert!(matches!(
            store.take_result("session-b").await,
            DesktopLoginResultResponse::Pending
        ));
    }

    #[tokio::test]
    async fn desktop_login_same_session_may_reuse_nonce_after_replace() {
        let store = DesktopLoginStore::new();
        store.start("session-a", "nonce-1").await.expect("start");
        store
            .start("session-a", "nonce-1")
            .await
            .expect("same session may restart with same nonce");

        store
            .complete_callback("auth-code", r#"{"nonce":"nonce-1"}"#)
            .await
            .expect("callback");
        assert!(matches!(
            store.take_result("session-a").await,
            DesktopLoginResultResponse::Complete { .. }
        ));
    }

    #[test]
    fn peer_loopback_gate_uses_socket_address() {
        use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

        assert!(peer_may_complete_desktop_login_callback(SocketAddr::new(
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            54321
        )));
        assert!(peer_may_complete_desktop_login_callback(SocketAddr::new(
            IpAddr::V4(Ipv4Addr::new(127, 0, 0, 42)),
            1
        )));
        assert!(peer_may_complete_desktop_login_callback(SocketAddr::new(
            IpAddr::V6(Ipv6Addr::LOCALHOST),
            1
        )));
        assert!(!peer_may_complete_desktop_login_callback(SocketAddr::new(
            IpAddr::V4(Ipv4Addr::new(192, 168, 1, 10)),
            54321
        )));
        assert!(!peer_may_complete_desktop_login_callback(SocketAddr::new(
            IpAddr::V4(Ipv4Addr::UNSPECIFIED),
            54321
        )));
    }

    #[test]
    fn desktop_login_callback_url_uses_loopback() {
        assert_eq!(
            desktop_login_callback_url(7731),
            "http://127.0.0.1:7731/api/auth/desktop-login/callback"
        );
        assert!(host_supports_loopback_desktop_login("127.0.0.1"));
        assert!(host_supports_loopback_desktop_login("0.0.0.0"));
        assert!(!host_supports_loopback_desktop_login("localhost"));
        assert!(!host_supports_loopback_desktop_login("::"));
        assert!(!host_supports_loopback_desktop_login("[::]"));
        assert!(!host_supports_loopback_desktop_login("::1"));
        assert!(!host_supports_loopback_desktop_login("192.168.1.10"));
    }
}
