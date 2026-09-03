use std::collections::HashMap;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::http::HeaderMap;
use axum_extra::extract::CookieJar;
use cookie::{Cookie, SameSite};
use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::config::SESSION_COOKIE_NAME;

const PAIRING_CREDENTIAL_FILE: &str = "pairing-credential";
const SESSIONS_FILE: &str = "sessions.json";
const SESSION_MAX_AGE_SECS: i64 = 60 * 60 * 24 * 30;
const SESSION_MAX_AGE_MS: u64 = SESSION_MAX_AGE_SECS as u64 * 1000;
type HmacSha256 = Hmac<Sha256>;

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
        let pairing_credential = if let Some(existing) = read_pairing_credential(data_dir)? {
            existing
        } else {
            let credential = Uuid::new_v4().to_string();
            fs::write(&credential_path, format!("{credential}\n"))?;
            credential
        };

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

    pub fn verify_pairing_credential(&self, credential: &str) -> anyhow::Result<()> {
        if credential.trim() != self.pairing_credential {
            anyhow::bail!(
                "invalid pairing credential; use the token printed by your running Sprocket server"
            );
        }
        Ok(())
    }

    pub fn pairing_proof(&self, message: &str) -> anyhow::Result<Vec<u8>> {
        let mut mac = HmacSha256::new_from_slice(self.pairing_credential.as_bytes())?;
        mac.update(message.as_bytes());
        Ok(mac.finalize().into_bytes().to_vec())
    }
}

/// Constant-time HMAC-SHA256 verification of a pairing proof.
pub fn verify_pairing_proof(credential: &str, message: &str, proof: &[u8]) -> bool {
    let Ok(mut mac) = HmacSha256::new_from_slice(credential.as_bytes()) else {
        return false;
    };
    mac.update(message.as_bytes());
    mac.verify_slice(proof).is_ok()
}

impl AuthState {
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
        self.verify_pairing_credential(credential)?;

        let session_token = Uuid::new_v4().to_string();
        self.sessions.write().await.insert(
            session_token.clone(),
            SessionRecord {
                role: "owner".to_string(),
                created_at: crate::now_ms(),
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

pub fn read_pairing_credential(data_dir: &Path) -> anyhow::Result<Option<String>> {
    let credential = match fs::read_to_string(data_dir.join(PAIRING_CREDENTIAL_FILE)) {
        Ok(credential) => credential,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let credential = credential.trim().to_string();
    if credential.is_empty() {
        anyhow::bail!("pairing credential must not be empty");
    }
    Ok(Some(credential))
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
    crate::now_ms().saturating_sub(session.created_at) > SESSION_MAX_AGE_MS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reading_a_missing_pairing_credential_has_no_side_effects() {
        let temp_dir = std::env::temp_dir().join(format!("sprocket-auth-test-{}", Uuid::new_v4()));

        assert_eq!(read_pairing_credential(&temp_dir).unwrap(), None);
        assert!(!temp_dir.exists());
    }

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
