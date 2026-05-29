use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::http::HeaderMap;
use axum_extra::extract::CookieJar;
use cookie::{Cookie, SameSite};
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::config::SESSION_COOKIE_NAME;

const PAIRING_CREDENTIAL_FILE: &str = "pairing-credential";
const SESSION_MAX_AGE_SECS: i64 = 60 * 60 * 24 * 30;

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
    _data_dir: PathBuf,
    pairing_credential: String,
    sessions: RwLock<HashMap<String, SessionRecord>>,
}

#[derive(Debug, Clone)]
struct SessionRecord {
    role: String,
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

        Ok(Arc::new(Self {
            _data_dir: data_dir.to_path_buf(),
            pairing_credential,
            sessions: RwLock::new(HashMap::new()),
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

        let sessions = self.sessions.read().await;
        let Some(session) = sessions.get(session_token) else {
            return AuthSessionResponse {
                authenticated: false,
                role: None,
            };
        };

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
            },
        );

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
}
