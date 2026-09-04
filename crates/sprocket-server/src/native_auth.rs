use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, anyhow};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use convex::{FunctionResult, Value};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sprocket_convex::{AuthTokenFetcher, Client as ConvexClient};
use tokio::sync::{Mutex, OnceCell};
use tokio::time::timeout;
use workos::helpers::AuthKitAuthorizationUrlParams;
use workos::resources::user_management::{
    AuthenticateWithCodeParams, AuthenticateWithRefreshTokenParams,
};
use workos::{AuthenticateResponse, Client as WorkOsClient};

const CLIENT_CONFIG_QUERY: &str = "authBootstrap:getClientConfig";
const CLIENT_CONFIG_TIMEOUT: Duration = Duration::from_secs(15);
const LOGIN_ATTEMPT_TTL: Duration = Duration::from_secs(5 * 60);
const ACCESS_TOKEN_REFRESH_MARGIN_SECS: u64 = 60;
const KEYRING_SERVICE: &str = "dev.sprocket.native-auth";
const KEYRING_ACCOUNT_PREFIX: &str = "workos-refresh-token";

#[derive(Clone, Debug)]
pub(crate) struct NativeAuthConfig {
    pub workos_client_id: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeUser {
    pub id: String,
    pub email: String,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub profile_picture_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "camelCase")]
pub(crate) enum NativeLoginStatus {
    SignedOut,
    Pending,
    Authenticated { user: NativeUser },
    Unavailable { error: String },
    Failed { error: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeLoginStart {
    pub authorization_url: String,
    pub login_id: String,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum NativeLoginFlow {
    SignIn,
    SignUp,
}

trait RefreshTokenStore: Send + Sync {
    fn load(&self) -> anyhow::Result<Option<String>>;
    fn save(&self, refresh_token: &str) -> anyhow::Result<()>;
    fn clear(&self) -> anyhow::Result<()>;
}

#[cfg(test)]
struct EmptyRefreshTokenStore;

#[cfg(test)]
impl RefreshTokenStore for EmptyRefreshTokenStore {
    fn load(&self) -> anyhow::Result<Option<String>> {
        Ok(None)
    }

    fn save(&self, _refresh_token: &str) -> anyhow::Result<()> {
        Ok(())
    }

    fn clear(&self) -> anyhow::Result<()> {
        Ok(())
    }
}

struct KeyringRefreshTokenStore {
    account: String,
}

impl KeyringRefreshTokenStore {
    fn new(deployment_url: &str, data_dir: &Path) -> Self {
        let mut hasher = Sha256::new();
        hasher.update(deployment_url.as_bytes());
        hasher.update([0]);
        hasher.update(data_dir.as_os_str().as_encoded_bytes());
        let digest = hasher.finalize();
        let suffix = digest[..16]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        Self {
            account: format!("{KEYRING_ACCOUNT_PREFIX}-{suffix}"),
        }
    }

    fn entry(&self) -> anyhow::Result<keyring::Entry> {
        keyring::Entry::new(KEYRING_SERVICE, &self.account)
            .context("failed to access the operating system credential store")
    }
}

impl RefreshTokenStore for KeyringRefreshTokenStore {
    fn load(&self) -> anyhow::Result<Option<String>> {
        match self.entry()?.get_password() {
            Ok(token) if token.trim().is_empty() => {
                anyhow::bail!("stored WorkOS refresh token is empty")
            }
            Ok(token) => Ok(Some(token)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(error).context("failed to load WorkOS refresh token"),
        }
    }

    fn save(&self, refresh_token: &str) -> anyhow::Result<()> {
        if refresh_token.trim().is_empty() {
            anyhow::bail!("refusing to persist an empty WorkOS refresh token");
        }
        self.entry()?
            .set_password(refresh_token)
            .context("failed to persist WorkOS refresh token")
    }

    fn clear(&self) -> anyhow::Result<()> {
        match self.entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(error).context("failed to delete WorkOS refresh token"),
        }
    }
}

struct PendingLogin {
    session_token: String,
    code_verifier: String,
    created_at: Instant,
}

#[derive(Default)]
struct PendingLogins {
    by_state: HashMap<String, PendingLogin>,
    by_session: HashMap<String, String>,
}

struct AccessToken {
    value: String,
    expires_at: u64,
}

#[derive(Default)]
struct NativeSession {
    pending: PendingLogins,
    access_token: Option<AccessToken>,
    user: Option<NativeUser>,
    login_errors: HashMap<String, String>,
    suppress_persisted_resume: bool,
    sign_out_generation: u64,
}

pub(crate) struct NativeAuthManager {
    deployment_url: Option<String>,
    client: OnceCell<WorkOsClient>,
    callback_url: String,
    refresh_tokens: Arc<dyn RefreshTokenStore>,
    credential_operation: Mutex<()>,
    session: Mutex<NativeSession>,
}

impl NativeAuthManager {
    pub fn new(deployment_url: String, callback_url: String, data_dir: &Path) -> Arc<Self> {
        let refresh_tokens = Arc::new(KeyringRefreshTokenStore::new(&deployment_url, data_dir));
        Arc::new(Self {
            deployment_url: Some(deployment_url),
            client: OnceCell::new(),
            callback_url,
            refresh_tokens,
            credential_operation: Mutex::new(()),
            session: Mutex::new(NativeSession::default()),
        })
    }

    #[cfg(test)]
    fn with_client(
        client: WorkOsClient,
        callback_url: String,
        refresh_tokens: Arc<dyn RefreshTokenStore>,
    ) -> Self {
        let client_cell = OnceCell::new();
        assert!(client_cell.set(client).is_ok());
        Self {
            deployment_url: None,
            client: client_cell,
            callback_url,
            refresh_tokens,
            credential_operation: Mutex::new(()),
            session: Mutex::new(NativeSession::default()),
        }
    }

    #[cfg(test)]
    fn with_store(
        config: NativeAuthConfig,
        callback_url: String,
        refresh_tokens: Arc<dyn RefreshTokenStore>,
    ) -> Self {
        let client = WorkOsClient::builder()
            .client_id(config.workos_client_id)
            .build();
        Self::with_client(client, callback_url, refresh_tokens)
    }

    #[cfg(test)]
    pub(crate) fn configured_for_test(config: NativeAuthConfig, callback_url: String) -> Arc<Self> {
        Arc::new(Self::with_store(
            config,
            callback_url,
            Arc::new(EmptyRefreshTokenStore),
        ))
    }

    async fn client(&self) -> anyhow::Result<&WorkOsClient> {
        self.client
            .get_or_try_init(|| async {
                let deployment_url = self
                    .deployment_url
                    .as_deref()
                    .context("native authentication deployment URL is missing")?;
                let config = NativeAuthConfig::load(deployment_url)
                    .await
                    .context("failed to configure native authentication")?;
                Ok(WorkOsClient::builder()
                    .client_id(config.workos_client_id)
                    .build())
            })
            .await
    }

    pub async fn start_login(
        &self,
        session_token: &str,
        flow: NativeLoginFlow,
    ) -> anyhow::Result<NativeLoginStart> {
        let session_token = session_token.trim();
        if session_token.is_empty() {
            anyhow::bail!("desktop login session is missing");
        }

        let authorization = self
            .client()
            .await?
            .authkit()
            .pkce_authorization_url(AuthKitAuthorizationUrlParams {
                redirect_uri: self.callback_url.clone(),
                provider: Some("authkit".to_string()),
                screen_hint: match flow {
                    NativeLoginFlow::SignIn => Some("sign-in".to_string()),
                    NativeLoginFlow::SignUp => Some("sign-up".to_string()),
                },
                ..Default::default()
            })
            .context("failed to build WorkOS authorization URL")?;
        let mut session = self.session.lock().await;
        purge_expired_logins(&mut session.pending);
        if let Some(previous_state) = session.pending.by_session.remove(session_token) {
            session.pending.by_state.remove(&previous_state);
        }
        session
            .pending
            .by_session
            .insert(session_token.to_string(), authorization.state.clone());
        session.pending.by_state.insert(
            authorization.state.clone(),
            PendingLogin {
                session_token: session_token.to_string(),
                code_verifier: authorization.code_verifier,
                created_at: Instant::now(),
            },
        );
        session.login_errors.remove(session_token);

        Ok(NativeLoginStart {
            authorization_url: authorization.url,
            login_id: authorization.state,
        })
    }

    pub async fn complete_login(
        &self,
        code: &str,
        state: &str,
    ) -> anyhow::Result<(NativeUser, String)> {
        let code = required_callback_value(code, "authorization code")?;
        let state = required_callback_value(state, "desktop login state")?;
        let (code_verifier, pending_session_token, sign_out_generation) = {
            let mut session = self.session.lock().await;
            purge_expired_logins(&mut session.pending);
            let pending = session
                .pending
                .by_state
                .remove(state)
                .context("no pending desktop login attempt")?;
            session.pending.by_session.remove(&pending.session_token);
            (
                pending.code_verifier,
                pending.session_token,
                session.sign_out_generation,
            )
        };

        let _credential_operation = self.credential_operation.lock().await;
        if self.session.lock().await.sign_out_generation != sign_out_generation {
            anyhow::bail!("desktop login attempt was invalidated by sign-out");
        }
        let mut params = AuthenticateWithCodeParams::new(code);
        params.code_verifier = Some(code_verifier);
        match self
            .client()
            .await?
            .user_management()
            .authenticate_with_code(params)
            .await
        {
            Ok(response) => self
                .accept_authentication(response)
                .await
                .map(|user| (user, pending_session_token)),
            Err(error) => {
                self.session
                    .lock()
                    .await
                    .login_errors
                    .insert(pending_session_token, provider_error(&error));
                Err(error).context("WorkOS authorization-code exchange failed")
            }
        }
    }

    pub async fn fail_login(&self, state: &str, error: &str) -> anyhow::Result<()> {
        let state = required_callback_value(state, "desktop login state")?;
        let error = required_callback_value(error, "desktop login error")?;
        let mut session = self.session.lock().await;
        purge_expired_logins(&mut session.pending);
        let pending = session
            .pending
            .by_state
            .remove(state)
            .context("no pending desktop login attempt")?;
        session.pending.by_session.remove(&pending.session_token);
        session
            .login_errors
            .insert(pending.session_token, error.to_string());
        Ok(())
    }

    pub async fn status(&self, session_token: &str) -> NativeLoginStatus {
        {
            let mut session = self.session.lock().await;
            purge_expired_logins(&mut session.pending);
            if session.pending.by_session.contains_key(session_token) {
                return NativeLoginStatus::Pending;
            }
            if let Some(error) = session.login_errors.get(session_token) {
                return NativeLoginStatus::Failed {
                    error: error.clone(),
                };
            }
            if let Some(user) = &session.user {
                return NativeLoginStatus::Authenticated { user: user.clone() };
            }
        }

        if let Err(error) = self.access_token(false).await {
            let message = error.to_string();
            return if message.contains("native WorkOS session is signed out")
                || message.contains("native WorkOS session expired")
            {
                NativeLoginStatus::SignedOut
            } else {
                NativeLoginStatus::Unavailable {
                    error: "Native sign-in is temporarily unavailable. Try again.".to_string(),
                }
            };
        }

        self.session
            .lock()
            .await
            .user
            .as_ref()
            .map_or(NativeLoginStatus::SignedOut, |user| {
                NativeLoginStatus::Authenticated { user: user.clone() }
            })
    }

    pub async fn cancel_login(&self, session_token: &str, login_id: &str) {
        let mut session = self.session.lock().await;
        if session
            .pending
            .by_session
            .get(session_token)
            .is_some_and(|state| state == login_id)
        {
            session.pending.by_session.remove(session_token);
            session.pending.by_state.remove(login_id);
        }
    }

    #[cfg(test)]
    pub async fn expire_login_for_test(&self, session_token: &str) {
        let mut session = self.session.lock().await;
        let Some(state) = session.pending.by_session.get(session_token).cloned() else {
            return;
        };
        if let Some(pending) = session.pending.by_state.get_mut(&state) {
            pending.created_at = Instant::now() - LOGIN_ATTEMPT_TTL - Duration::from_secs(1);
        }
    }

    pub async fn sign_out(&self) -> anyhow::Result<()> {
        let _credential_operation = self.credential_operation.lock().await;
        let sign_out_generation = self
            .session
            .lock()
            .await
            .sign_out_generation
            .wrapping_add(1);
        let mut session = NativeSession::default();
        session.suppress_persisted_resume = true;
        session.sign_out_generation = sign_out_generation;
        *self.session.lock().await = session;
        self.clear_refresh_token().await
    }

    pub fn auth_token_fetcher_for_user(
        self: &Arc<Self>,
        expected_user_id: String,
    ) -> AuthTokenFetcher {
        let manager = Arc::clone(self);
        Arc::new(move |force_refresh| {
            let manager = Arc::clone(&manager);
            let expected_user_id = expected_user_id.clone();
            Box::pin(async move {
                manager
                    .access_token_for_user(force_refresh, &expected_user_id)
                    .await
            })
        })
    }

    pub async fn require_user(&self, expected_user_id: &str) -> anyhow::Result<()> {
        self.access_token_for_user(false, expected_user_id).await?;
        Ok(())
    }

    async fn access_token(&self, force_refresh: bool) -> anyhow::Result<String> {
        let _credential_operation = self.credential_operation.lock().await;
        self.access_token_locked(force_refresh).await
    }

    async fn access_token_for_user(
        &self,
        force_refresh: bool,
        expected_user_id: &str,
    ) -> anyhow::Result<String> {
        let _credential_operation = self.credential_operation.lock().await;
        let token = self.access_token_locked(force_refresh).await?;
        let session = self.session.lock().await;
        let user = session
            .user
            .as_ref()
            .context("native WorkOS session has no user")?;
        if user.id != expected_user_id {
            anyhow::bail!("native and browser sessions belong to different users");
        }
        Ok(token)
    }

    async fn access_token_locked(&self, force_refresh: bool) -> anyhow::Result<String> {
        let refresh_before = unix_time_secs().saturating_add(ACCESS_TOKEN_REFRESH_MARGIN_SECS);
        if !force_refresh {
            let session = self.session.lock().await;
            if let Some(access_token) = &session.access_token
                && access_token.expires_at > refresh_before
            {
                return Ok(access_token.value.clone());
            }
        }
        if self.session.lock().await.suppress_persisted_resume {
            anyhow::bail!("native WorkOS session is signed out");
        }

        let refresh_token = self
            .load_refresh_token()
            .await?
            .context("native WorkOS session is signed out")?;
        let response = self
            .client()
            .await?
            .user_management()
            .authenticate_with_refresh_token(AuthenticateWithRefreshTokenParams::new(refresh_token))
            .await;
        match response {
            Ok(response) => {
                self.accept_authentication(response).await?;
                self.session
                    .lock()
                    .await
                    .access_token
                    .as_ref()
                    .map(|token| token.value.clone())
                    .context("WorkOS response omitted access token")
            }
            Err(error) if is_terminal_refresh_error(&error) => {
                let mut session = self.session.lock().await;
                session.access_token = None;
                session.user = None;
                session.suppress_persisted_resume = true;
                drop(session);
                self.clear_refresh_token().await?;
                Err(error).context("native WorkOS session expired")
            }
            Err(error) if is_transient_refresh_error(&error) => {
                let session = self.session.lock().await;
                if let Some(access_token) = &session.access_token
                    && access_token.expires_at > unix_time_secs()
                {
                    tracing::warn!(
                        "native WorkOS refresh failed; retaining current access token: {error}"
                    );
                    return Ok(access_token.value.clone());
                }
                Err(error).context("failed to refresh native WorkOS session")
            }
            Err(error) => {
                let session = self.session.lock().await;
                if let Some(access_token) = &session.access_token
                    && access_token.expires_at > unix_time_secs()
                {
                    tracing::warn!(
                        "native WorkOS refresh returned an unrecognized error; retaining current access token: {error}"
                    );
                    return Ok(access_token.value.clone());
                }
                Err(error).context("failed to refresh native WorkOS session")
            }
        }
    }

    async fn accept_authentication(
        &self,
        response: AuthenticateResponse,
    ) -> anyhow::Result<NativeUser> {
        let user = NativeUser {
            id: response.user.id,
            email: response.user.email,
            first_name: response.user.first_name,
            last_name: response.user.last_name,
            profile_picture_url: response.user.profile_picture_url,
        };
        let access_token = response.access_token.into_inner();
        let expires_at = jwt_expiration(&access_token)?;
        let refresh_token = response.refresh_token.into_inner();
        self.save_refresh_token(refresh_token).await?;

        let mut session = self.session.lock().await;
        session.access_token = Some(AccessToken {
            value: access_token,
            expires_at,
        });
        session.user = Some(user.clone());
        session.login_errors.clear();
        session.suppress_persisted_resume = false;
        Ok(user)
    }

    async fn load_refresh_token(&self) -> anyhow::Result<Option<String>> {
        let store = Arc::clone(&self.refresh_tokens);
        let token = tokio::task::spawn_blocking(move || store.load())
            .await
            .context("credential-store task failed")??;
        match token {
            Some(token) if token.trim().is_empty() => {
                anyhow::bail!("stored WorkOS refresh token is empty")
            }
            token => Ok(token),
        }
    }

    async fn save_refresh_token(&self, refresh_token: String) -> anyhow::Result<()> {
        let store = Arc::clone(&self.refresh_tokens);
        tokio::task::spawn_blocking(move || store.save(&refresh_token))
            .await
            .context("credential-store task failed")?
    }

    async fn clear_refresh_token(&self) -> anyhow::Result<()> {
        let store = Arc::clone(&self.refresh_tokens);
        tokio::task::spawn_blocking(move || store.clear())
            .await
            .context("credential-store task failed")?
    }
}

fn purge_expired_logins(logins: &mut PendingLogins) {
    let expired: Vec<_> = logins
        .by_state
        .iter()
        .filter(|(_, pending)| pending.created_at.elapsed() > LOGIN_ATTEMPT_TTL)
        .map(|(state, _)| state.clone())
        .collect();
    for state in expired {
        if let Some(pending) = logins.by_state.remove(&state) {
            logins.by_session.remove(&pending.session_token);
        }
    }
}

fn required_callback_value<'a>(value: &'a str, name: &str) -> anyhow::Result<&'a str> {
    let value = value.trim();
    if value.is_empty() {
        anyhow::bail!("{name} is missing");
    }
    Ok(value)
}

#[derive(Deserialize)]
struct JwtExpiration {
    exp: u64,
}

fn jwt_expiration(token: &str) -> anyhow::Result<u64> {
    let payload = token
        .split('.')
        .nth(1)
        .context("WorkOS access token is not a JWT")?;
    let decoded = URL_SAFE_NO_PAD
        .decode(payload)
        .context("WorkOS access token has invalid base64 payload")?;
    let claims: JwtExpiration = serde_json::from_slice(&decoded)
        .context("WorkOS access token has invalid expiration metadata")?;
    Ok(claims.exp)
}

fn unix_time_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs())
}

fn is_terminal_refresh_error(error: &workos::Error) -> bool {
    matches!(error.status(), Some(400 | 401)) && error.code() == Some("invalid_grant")
}

fn is_transient_refresh_error(error: &workos::Error) -> bool {
    matches!(
        error,
        workos::Error::Network(network)
            if matches!(
                network.kind,
                workos::transport::TransportErrorKind::Connect
                    | workos::transport::TransportErrorKind::Timeout
            )
    ) || matches!(error.status(), Some(408 | 429 | 500 | 502 | 503 | 504))
}

fn provider_error(error: &workos::Error) -> String {
    match error.request_id() {
        Some(request_id) => format!("WorkOS sign-in failed (request {request_id})"),
        None => "WorkOS sign-in failed".to_string(),
    }
}

impl NativeAuthConfig {
    pub async fn load(convex_deployment_url: &str) -> anyhow::Result<Self> {
        load_from_query(|| async {
            let client = ConvexClient::new(convex_deployment_url).await?;
            client.query(CLIENT_CONFIG_QUERY, BTreeMap::new()).await
        })
        .await
    }
}

async fn load_from_query<F, Fut>(query: F) -> anyhow::Result<NativeAuthConfig>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = anyhow::Result<FunctionResult>>,
{
    let result = timeout(CLIENT_CONFIG_TIMEOUT, query())
        .await
        .context("timed out loading native authentication configuration from Convex")??;
    decode_client_config(result)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClientConfigResponse {
    workos_client_id: String,
}

fn decode_client_config(result: FunctionResult) -> anyhow::Result<NativeAuthConfig> {
    let value = match result {
        FunctionResult::Value(value) => value,
        FunctionResult::ErrorMessage(message) => {
            return Err(anyhow!("{CLIENT_CONFIG_QUERY}: {message}"));
        }
        FunctionResult::ConvexError(error) => {
            return Err(anyhow!("{CLIENT_CONFIG_QUERY}: {}", error.message));
        }
    };

    let response: ClientConfigResponse = serde_json::from_value(convex_value_to_json(value))
        .context("Convex returned malformed native authentication configuration")?;
    let workos_client_id = response.workos_client_id.trim();
    if workos_client_id.is_empty() {
        anyhow::bail!("Convex returned an empty WorkOS client ID");
    }

    Ok(NativeAuthConfig {
        workos_client_id: workos_client_id.to_string(),
    })
}

fn convex_value_to_json(value: Value) -> serde_json::Value {
    match value {
        Value::Null => serde_json::Value::Null,
        Value::Int64(number) => serde_json::json!(number),
        Value::Float64(number) => serde_json::json!(number),
        Value::Boolean(boolean) => serde_json::json!(boolean),
        Value::String(text) => serde_json::json!(text),
        Value::Bytes(bytes) => serde_json::json!(bytes),
        Value::Array(values) => {
            serde_json::Value::Array(values.into_iter().map(convex_value_to_json).collect())
        }
        Value::Object(fields) => serde_json::Value::Object(
            fields
                .into_iter()
                .map(|(key, value)| (key, convex_value_to_json(value)))
                .collect(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    use axum::Json;
    use axum::http::StatusCode;
    use axum::routing::post;

    use super::*;

    #[derive(Default)]
    struct MemoryRefreshTokenStore {
        token: std::sync::Mutex<Option<String>>,
        fail_save: AtomicBool,
        fail_clear: AtomicBool,
    }

    impl MemoryRefreshTokenStore {
        fn with_token(token: &str) -> Arc<Self> {
            Arc::new(Self {
                token: std::sync::Mutex::new(Some(token.to_string())),
                fail_save: AtomicBool::new(false),
                fail_clear: AtomicBool::new(false),
            })
        }

        fn token(&self) -> Option<String> {
            self.token.lock().unwrap().clone()
        }
    }

    impl RefreshTokenStore for MemoryRefreshTokenStore {
        fn load(&self) -> anyhow::Result<Option<String>> {
            Ok(self.token())
        }

        fn save(&self, refresh_token: &str) -> anyhow::Result<()> {
            if self.fail_save.load(Ordering::SeqCst) {
                anyhow::bail!("credential store unavailable");
            }
            *self.token.lock().unwrap() = Some(refresh_token.to_string());
            Ok(())
        }

        fn clear(&self) -> anyhow::Result<()> {
            if self.fail_clear.load(Ordering::SeqCst) {
                anyhow::bail!("credential deletion failed");
            }
            *self.token.lock().unwrap() = None;
            Ok(())
        }
    }

    fn access_token(expires_at: u64) -> String {
        let claims = URL_SAFE_NO_PAD.encode(format!(r#"{{"exp":{expires_at}}}"#));
        format!("e30.{claims}.signature")
    }

    fn authentication_response(access_token: String, refresh_token: &str) -> AuthenticateResponse {
        serde_json::from_value(serde_json::json!({
            "user": {
                "object": "user",
                "id": "user_123",
                "first_name": "Ada",
                "last_name": "Lovelace",
                "profile_picture_url": null,
                "email": "ada@example.com",
                "email_verified": true,
                "external_id": null,
                "metadata": null,
                "last_sign_in_at": null,
                "locale": null,
                "created_at": "2025-01-01T00:00:00Z",
                "updated_at": "2025-01-01T00:00:00Z"
            },
            "organization_id": null,
            "authkit_authorization_code": null,
            "access_token": access_token,
            "refresh_token": refresh_token,
            "authentication_method": null,
            "impersonator": null,
            "oauth_tokens": null
        }))
        .expect("authentication response")
    }

    async fn manager_with_response(
        store: Arc<MemoryRefreshTokenStore>,
        status: StatusCode,
        body: serde_json::Value,
    ) -> NativeAuthManager {
        let app = axum::Router::new().route(
            "/user_management/authenticate",
            post(move || {
                let body = body.clone();
                async move { (status, Json(body)) }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("mock listener");
        let address = listener.local_addr().expect("mock address");
        tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("mock WorkOS server");
        });
        let client = WorkOsClient::builder()
            .client_id("client_test")
            .base_url(format!("http://{address}"))
            .build();
        NativeAuthManager::with_client(client, "http://127.0.0.1/callback".to_string(), store)
    }

    fn config_result(client_id: Value) -> FunctionResult {
        FunctionResult::Value(Value::Object(BTreeMap::from([(
            "workosClientId".to_string(),
            client_id,
        )])))
    }

    #[tokio::test]
    async fn loads_and_normalizes_client_id() {
        let config = load_from_query(|| async {
            Ok(config_result(Value::String(" client_123 ".to_string())))
        })
        .await
        .expect("valid configuration");

        assert_eq!(config.workos_client_id, "client_123");
    }

    #[test]
    fn keyring_credentials_are_scoped_to_deployment_and_data_directory() {
        let first = KeyringRefreshTokenStore::new("https://first.convex.cloud", Path::new("/one"));
        let same = KeyringRefreshTokenStore::new("https://first.convex.cloud", Path::new("/one"));
        let other_deployment =
            KeyringRefreshTokenStore::new("https://second.convex.cloud", Path::new("/one"));
        let other_data_dir =
            KeyringRefreshTokenStore::new("https://first.convex.cloud", Path::new("/two"));

        assert_eq!(first.account, same.account);
        assert_ne!(first.account, other_deployment.account);
        assert_ne!(first.account, other_data_dir.account);
    }

    #[tokio::test]
    async fn rejects_empty_client_id() {
        let error =
            load_from_query(|| async { Ok(config_result(Value::String("  ".to_string()))) })
                .await
                .expect_err("empty client ID must fail");

        assert!(error.to_string().contains("empty WorkOS client ID"));
    }

    #[tokio::test]
    async fn rejects_malformed_configuration() {
        let error =
            load_from_query(|| async { Ok(FunctionResult::Value(Value::Object(BTreeMap::new()))) })
                .await
                .expect_err("missing client ID must fail");

        assert!(error.to_string().contains("malformed"));
    }

    #[tokio::test]
    async fn preserves_convex_query_failures() {
        let error = load_from_query(|| async {
            Ok(FunctionResult::ErrorMessage(
                "deployment unavailable".to_string(),
            ))
        })
        .await
        .expect_err("query failure must fail");

        assert_eq!(
            error.to_string(),
            "authBootstrap:getClientConfig: deployment unavailable"
        );
    }

    #[tokio::test]
    async fn refresh_resumes_a_persisted_session_and_rotates_the_token() {
        let store = MemoryRefreshTokenStore::with_token("refresh-old");
        let expected_access_token = access_token(unix_time_secs() + 3_600);
        let manager = manager_with_response(
            Arc::clone(&store),
            StatusCode::OK,
            serde_json::to_value(authentication_response(
                expected_access_token.clone(),
                "refresh-new",
            ))
            .unwrap(),
        )
        .await;

        assert!(matches!(
            manager.status("paired-session").await,
            NativeLoginStatus::Authenticated { .. }
        ));
        assert_eq!(
            manager.access_token(false).await.unwrap(),
            expected_access_token
        );
        assert_eq!(store.token().as_deref(), Some("refresh-new"));
    }

    #[tokio::test]
    async fn require_user_rejects_a_different_native_identity() {
        let manager = manager_with_response(
            MemoryRefreshTokenStore::with_token("refresh-old"),
            StatusCode::OK,
            serde_json::to_value(authentication_response(
                access_token(unix_time_secs() + 3_600),
                "refresh-new",
            ))
            .unwrap(),
        )
        .await;

        manager.require_user("user_123").await.unwrap();
        assert_eq!(
            manager
                .require_user("user_456")
                .await
                .unwrap_err()
                .to_string(),
            "native and browser sessions belong to different users"
        );
    }

    #[tokio::test]
    async fn user_bound_fetcher_rejects_an_account_transition() {
        let manager = Arc::new(
            manager_with_response(
                MemoryRefreshTokenStore::with_token("refresh-old"),
                StatusCode::OK,
                serde_json::to_value(authentication_response(
                    access_token(unix_time_secs() + 3_600),
                    "refresh-new",
                ))
                .unwrap(),
            )
            .await,
        );
        let fetcher = manager.auth_token_fetcher_for_user("user_123".to_string());

        fetcher(false).await.unwrap();
        manager.session.lock().await.user.as_mut().unwrap().id = "user_456".to_string();

        assert_eq!(
            fetcher(false).await.unwrap_err().to_string(),
            "native and browser sessions belong to different users"
        );
    }

    #[tokio::test]
    async fn authorization_code_exchange_installs_the_native_session() {
        let store = MemoryRefreshTokenStore::with_token("refresh-old");
        let expected_access_token = access_token(unix_time_secs() + 3_600);
        let manager = manager_with_response(
            Arc::clone(&store),
            StatusCode::OK,
            serde_json::to_value(authentication_response(
                expected_access_token.clone(),
                "refresh-new",
            ))
            .unwrap(),
        )
        .await;
        let login = manager
            .start_login("paired-session", NativeLoginFlow::SignIn)
            .await
            .unwrap();

        let (user, session_token) = manager
            .complete_login("authorization-code", &login.login_id)
            .await
            .unwrap();

        assert_eq!(user.id, "user_123");
        assert_eq!(session_token, "paired-session");
        assert_eq!(store.token().as_deref(), Some("refresh-new"));
        assert_eq!(
            manager.access_token(false).await.unwrap(),
            expected_access_token
        );
    }

    #[tokio::test]
    async fn empty_persisted_refresh_token_is_rejected_without_network_io() {
        let store = MemoryRefreshTokenStore::with_token("   ");
        let manager = NativeAuthManager::with_store(
            NativeAuthConfig {
                workos_client_id: "client_test".to_string(),
            },
            "http://127.0.0.1/callback".to_string(),
            store,
        );

        let error = manager.access_token(false).await.unwrap_err();

        assert!(error.to_string().contains("refresh token is empty"));
    }

    #[tokio::test]
    async fn failed_rotation_does_not_replace_the_in_memory_session() {
        let store = MemoryRefreshTokenStore::with_token("refresh-old");
        let manager = NativeAuthManager::with_store(
            NativeAuthConfig {
                workos_client_id: "client_test".to_string(),
            },
            "http://127.0.0.1/callback".to_string(),
            store.clone(),
        );
        manager
            .accept_authentication(authentication_response(
                access_token(unix_time_secs() + 3_600),
                "refresh-current",
            ))
            .await
            .unwrap();
        store.fail_save.store(true, Ordering::SeqCst);

        let error = manager
            .accept_authentication(authentication_response(
                access_token(unix_time_secs() + 7_200),
                "refresh-replacement",
            ))
            .await
            .expect_err("failed persistence must reject new session");

        assert!(error.to_string().contains("credential store unavailable"));
        assert_eq!(store.token().as_deref(), Some("refresh-current"));
        assert_eq!(
            manager.session.lock().await.user.as_ref().unwrap().email,
            "ada@example.com"
        );
    }

    #[tokio::test]
    async fn invalid_grant_clears_the_persisted_session() {
        let store = MemoryRefreshTokenStore::with_token("expired-refresh");
        let manager = manager_with_response(
            Arc::clone(&store),
            StatusCode::BAD_REQUEST,
            serde_json::json!({
                "error": "invalid_grant",
                "error_description": "refresh token expired"
            }),
        )
        .await;

        assert!(manager.access_token(false).await.is_err());
        assert_eq!(store.token(), None);
    }

    #[tokio::test]
    async fn transient_refresh_failure_retains_a_still_valid_token() {
        let store = MemoryRefreshTokenStore::with_token("refresh-current");
        let manager = manager_with_response(
            Arc::clone(&store),
            StatusCode::SERVICE_UNAVAILABLE,
            serde_json::json!({ "error": "unavailable" }),
        )
        .await;
        let current_access_token = access_token(unix_time_secs() + 30);
        manager
            .accept_authentication(authentication_response(
                current_access_token.clone(),
                "refresh-current",
            ))
            .await
            .unwrap();

        assert_eq!(
            manager.access_token(false).await.unwrap(),
            current_access_token
        );
        assert_eq!(store.token().as_deref(), Some("refresh-current"));
    }

    #[tokio::test]
    async fn unexpected_refresh_failure_preserves_the_session_for_retry() {
        let store = MemoryRefreshTokenStore::with_token("refresh-current");
        let manager = manager_with_response(
            Arc::clone(&store),
            StatusCode::IM_A_TEAPOT,
            serde_json::json!({ "error": "unexpected" }),
        )
        .await;
        let current_access_token = access_token(unix_time_secs() + 30);
        manager
            .accept_authentication(authentication_response(
                current_access_token.clone(),
                "refresh-current",
            ))
            .await
            .unwrap();

        assert_eq!(
            manager.access_token(false).await.unwrap(),
            current_access_token
        );
        assert_eq!(store.token().as_deref(), Some("refresh-current"));
        assert!(matches!(
            manager.status("paired-session").await,
            NativeLoginStatus::Authenticated { .. }
        ));
    }

    #[tokio::test]
    async fn forced_refresh_returns_a_still_valid_token_after_transient_failure() {
        let store = MemoryRefreshTokenStore::with_token("refresh-current");
        let manager = manager_with_response(
            Arc::clone(&store),
            StatusCode::SERVICE_UNAVAILABLE,
            serde_json::json!({ "error": "unavailable" }),
        )
        .await;
        manager
            .accept_authentication(authentication_response(
                access_token(unix_time_secs() + 3_600),
                "refresh-current",
            ))
            .await
            .unwrap();

        let current_access_token = manager
            .session
            .lock()
            .await
            .access_token
            .as_ref()
            .unwrap()
            .value
            .clone();
        assert_eq!(
            manager.access_token(true).await.unwrap(),
            current_access_token
        );
        assert_eq!(store.token().as_deref(), Some("refresh-current"));
    }

    #[tokio::test]
    async fn concurrent_fetches_share_one_refresh() {
        let store = MemoryRefreshTokenStore::with_token("refresh-current");
        let requests = Arc::new(AtomicUsize::new(0));
        let expected_access_token = access_token(unix_time_secs() + 3_600);
        let response = serde_json::to_value(authentication_response(
            expected_access_token.clone(),
            "refresh-new",
        ))
        .unwrap();
        let app = axum::Router::new().route(
            "/user_management/authenticate",
            post({
                let requests = Arc::clone(&requests);
                move || {
                    let requests = Arc::clone(&requests);
                    let response = response.clone();
                    async move {
                        requests.fetch_add(1, Ordering::SeqCst);
                        tokio::time::sleep(Duration::from_millis(25)).await;
                        Json(response)
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = WorkOsClient::builder()
            .client_id("client_test")
            .base_url(format!("http://{address}"))
            .build();
        let manager = Arc::new(NativeAuthManager::with_client(
            client,
            "http://127.0.0.1/callback".to_string(),
            store,
        ));

        let first_manager = Arc::clone(&manager);
        let second_manager = Arc::clone(&manager);
        let (first, second) = tokio::join!(
            first_manager.access_token(false),
            second_manager.access_token(false)
        );

        assert_eq!(first.unwrap(), expected_access_token);
        assert_eq!(second.unwrap(), expected_access_token);
        assert_eq!(requests.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn sign_out_clears_memory_when_credential_deletion_fails() {
        let store = MemoryRefreshTokenStore::with_token("refresh-current");
        let manager = NativeAuthManager::with_store(
            NativeAuthConfig {
                workos_client_id: "client_test".to_string(),
            },
            "http://127.0.0.1/callback".to_string(),
            store.clone(),
        );
        manager
            .accept_authentication(authentication_response(
                access_token(unix_time_secs() + 3_600),
                "refresh-current",
            ))
            .await
            .unwrap();
        store.fail_clear.store(true, Ordering::SeqCst);

        assert!(manager.sign_out().await.is_err());
        assert!(manager.session.lock().await.user.is_none());
        assert!(manager.session.lock().await.access_token.is_none());
        assert!(manager.access_token(false).await.is_err());
    }
}
