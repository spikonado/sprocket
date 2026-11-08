mod credentials;
mod device;
#[cfg(any(test, feature = "test-support"))]
mod test_support;

use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, anyhow};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use convex::{FunctionResult, Value};
use futures::future::BoxFuture;
use serde::{Deserialize, Serialize};
use sprocket_convex::{AuthSignedOut, AuthTokenFetcher, Client as ConvexClient};
use tokio::sync::{Mutex, OnceCell, watch};
use tokio::time::timeout;
use workos::helpers::AuthKitAuthorizationUrlParams;
use workos::resources::user_management::{
    AuthenticateWithCodeParams, AuthenticateWithRefreshTokenParams,
};
use workos::{AuthenticateResponse, Client as WorkOsClient};

use credentials::{ProfileCredentials, RefreshTokenStore};

const CLIENT_CONFIG_QUERY: &str = "authBootstrap:getClientConfig";
const CLIENT_CONFIG_TIMEOUT: Duration = Duration::from_secs(15);
const LOGIN_ATTEMPT_TTL: Duration = Duration::from_secs(5 * 60);
const ACCESS_TOKEN_REFRESH_MARGIN_SECS: u64 = 60;
const NATIVE_SESSION_SIGNED_OUT: &str = "native WorkOS session is signed out";
const NATIVE_SESSION_EXPIRED: &str = "native WorkOS session expired";
const NATIVE_SESSION_UNAVAILABLE: &str = "Native sign-in is temporarily unavailable. Try again.";
pub const UNENCRYPTED_CREDENTIALS_NOTICE: &str = "Your session is stored unencrypted in a private file for this Sprocket profile. To require the operating system keyring, run sprocket logout, then sprocket login --credential-store keyring.";

#[derive(Clone, Debug)]
pub struct NativeAuthConfig {
    pub workos_client_id: String,
}

pub trait BrowserSessions: Send + Sync {
    fn sync_with_owner<'a>(&'a self, user_id: Option<&'a str>)
    -> BoxFuture<'a, anyhow::Result<()>>;

    fn bind_user<'a>(
        &'a self,
        session_token: &'a str,
        user_id: &'a str,
    ) -> BoxFuture<'a, anyhow::Result<()>>;
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, clap::ValueEnum)]
#[serde(rename_all = "camelCase")]
pub enum CredentialStore {
    Keyring,
    File,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceLoginResponse {
    pub verification_uri: String,
    pub user_code: String,
    pub expires_in: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeUser {
    pub id: String,
    pub email: String,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub profile_picture_url: Option<String>,
}

#[derive(Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeBrowserSession {
    pub access_token: String,
    pub user: NativeUser,
}

impl std::fmt::Debug for NativeBrowserSession {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("NativeBrowserSession")
            .field("user", &self.user)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum NativeLoginStatus {
    SignedOut,
    Pending,
    Authenticated {
        user: NativeUser,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        credential_store: Option<CredentialStore>,
    },
    Unavailable {
        error: String,
    },
    Failed {
        error: String,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeLoginStart {
    pub authorization_url: String,
    pub login_id: String,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NativeLoginFlow {
    SignIn,
    SignUp,
}

struct LoginAttempt {
    session_token: String,
    started_at: Instant,
    state: LoginState,
}

enum LoginState {
    Pending { code_verifier: String },
    Exchanging,
    Failed(String),
}

impl LoginAttempt {
    fn is_pending(&self) -> bool {
        matches!(self.state, LoginState::Pending { .. })
    }

    fn in_progress(&self) -> bool {
        !matches!(self.state, LoginState::Failed(_))
    }
}

struct AccessToken {
    value: String,
    expires_at: u64,
}

struct NativeSession {
    devices: HashMap<String, device::PendingDeviceLogin>,
    remote_devices: HashMap<String, device::RemoteDeviceLogin>,
    logins: HashMap<String, LoginAttempt>,
    access_token: Option<AccessToken>,
    refresh_token: Option<String>,
    refresh_token_persisted: bool,
    credential_store: Option<CredentialStore>,
    refresh_generation: u64,
    user: Option<NativeUser>,
    suppress_persisted_resume: bool,
    login_generation: u64,
}

impl Default for NativeSession {
    fn default() -> Self {
        Self {
            devices: HashMap::new(),
            remote_devices: HashMap::new(),
            logins: HashMap::new(),
            access_token: None,
            refresh_token: None,
            refresh_token_persisted: true,
            credential_store: None,
            refresh_generation: 0,
            user: None,
            suppress_persisted_resume: false,
            login_generation: 0,
        }
    }
}

impl NativeSession {
    fn clear_authenticated_state(&mut self) {
        self.access_token = None;
        self.refresh_token = None;
        self.refresh_token_persisted = true;
        self.credential_store = None;
        self.user = None;
        self.suppress_persisted_resume = true;
    }

    fn purge_expired_logins(&mut self) {
        self.logins.retain(|_, attempt| {
            matches!(attempt.state, LoginState::Exchanging)
                || attempt.started_at.elapsed() <= LOGIN_ATTEMPT_TTL
        });
    }
}

pub struct NativeAuthManager {
    changes: watch::Sender<u64>,
    browser_sessions: Option<Arc<dyn BrowserSessions>>,
    deployment_url: Option<String>,
    client: OnceCell<WorkOsClient>,
    callback_url: String,
    refresh_tokens: Arc<dyn RefreshTokenStore>,
    credential_operation: Mutex<()>,
    session: Mutex<NativeSession>,
}

impl NativeAuthManager {
    pub fn new(
        deployment_url: String,
        callback_url: String,
        data_dir: &Path,
        browser_sessions: Option<Arc<dyn BrowserSessions>>,
    ) -> Arc<Self> {
        let refresh_tokens = Arc::new(ProfileCredentials::new(&deployment_url, data_dir));
        Arc::new(Self {
            changes: watch::channel(0).0,
            browser_sessions,
            deployment_url: Some(deployment_url),
            client: OnceCell::new(),
            callback_url,
            refresh_tokens,
            credential_operation: Mutex::new(()),
            session: Mutex::new(NativeSession::default()),
        })
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
        let _operation = self.credential_operation.lock().await;
        let mut session = self.session.lock().await;
        session.purge_expired_logins();
        session.logins.insert(
            authorization.state.clone(),
            LoginAttempt {
                session_token: session_token.to_string(),
                started_at: Instant::now(),
                state: LoginState::Pending {
                    code_verifier: authorization.code_verifier,
                },
            },
        );

        Ok(NativeLoginStart {
            authorization_url: authorization.url,
            login_id: authorization.state,
        })
    }

    pub async fn complete_login(
        self: &Arc<Self>,
        code: &str,
        state: &str,
    ) -> anyhow::Result<(NativeUser, String)> {
        let manager = Arc::clone(self);
        let code = code.to_string();
        let state = state.to_string();
        crate::run_to_completion(async move { manager.complete_login_inner(&code, &state).await })
            .await
            .context("native login task failed")?
    }

    async fn complete_login_inner(
        &self,
        code: &str,
        state: &str,
    ) -> anyhow::Result<(NativeUser, String)> {
        let code = required_callback_value(code, "authorization code")?;
        let state = required_callback_value(state, "desktop login state")?;
        let (session_token, code_verifier, login_generation) = {
            let mut session = self.session.lock().await;
            session.purge_expired_logins();
            let login_generation = session.login_generation;
            let attempt = session
                .logins
                .get_mut(state)
                .context("no pending desktop login attempt")?;
            let LoginState::Pending { code_verifier } = &mut attempt.state else {
                anyhow::bail!("no pending desktop login attempt");
            };
            let code_verifier = std::mem::take(code_verifier);
            attempt.state = LoginState::Exchanging;
            (
                attempt.session_token.clone(),
                code_verifier,
                login_generation,
            )
        };

        let _credential_operation = self.credential_operation.lock().await;
        let result = self
            .exchange_code(code, code_verifier, login_generation, state)
            .await;
        if let Err(error) = &result {
            let mut session = self.session.lock().await;
            if let Some(attempt) = session.logins.get_mut(state)
                && matches!(attempt.state, LoginState::Exchanging)
            {
                attempt.state = LoginState::Failed(login_failure_message(error));
            }
        }
        result.map(|user| (user, session_token))
    }

    async fn exchange_code(
        &self,
        code: &str,
        code_verifier: String,
        login_generation: u64,
        login_id: &str,
    ) -> anyhow::Result<NativeUser> {
        if self.session.lock().await.login_generation != login_generation {
            anyhow::bail!("desktop login attempt was invalidated by another sign-in or sign-out");
        }
        let mut params = AuthenticateWithCodeParams::new(code);
        params.code_verifier = Some(code_verifier.into());
        let response = self
            .client()
            .await?
            .user_management()
            .authenticate_with_code(params)
            .await
            .context("WorkOS authorization-code exchange failed")?;
        self.accept_login(response, Some(login_id)).await
    }

    pub async fn fail_login(&self, state: &str, error: &str) -> anyhow::Result<()> {
        let state = required_callback_value(state, "desktop login state")?;
        let error = required_callback_value(error, "desktop login error")?;
        let mut session = self.session.lock().await;
        session.purge_expired_logins();
        let attempt = session
            .logins
            .get_mut(state)
            .filter(|attempt| attempt.is_pending())
            .context("no pending desktop login attempt")?;
        attempt.state = LoginState::Failed(error.to_string());
        Ok(())
    }

    pub async fn login_status(
        self: &Arc<Self>,
        session_token: &str,
        login_id: &str,
    ) -> NativeLoginStatus {
        {
            let mut session = self.session.lock().await;
            session.purge_expired_logins();
            match session
                .logins
                .get(login_id)
                .filter(|attempt| attempt.session_token == session_token)
                .map(|attempt| &attempt.state)
            {
                Some(LoginState::Failed(error)) => {
                    return NativeLoginStatus::Failed {
                        error: error.clone(),
                    };
                }
                Some(_) => return NativeLoginStatus::Pending,
                None => {}
            }
        }
        self.status().await
    }

    async fn status(self: &Arc<Self>) -> NativeLoginStatus {
        match self.browser_session(false).await {
            Ok(Some(session)) => NativeLoginStatus::Authenticated {
                user: session.user,
                credential_store: self.credential_store().await,
            },
            Ok(None) => NativeLoginStatus::SignedOut,
            Err(_) => NativeLoginStatus::Unavailable {
                error: NATIVE_SESSION_UNAVAILABLE.to_string(),
            },
        }
    }

    pub async fn cancel_login(&self, session_token: &str, login_id: &str) {
        let mut session = self.session.lock().await;
        if session
            .logins
            .get(login_id)
            .is_some_and(|attempt| attempt.session_token == session_token && attempt.is_pending())
        {
            session.logins.remove(login_id);
        }
    }

    pub async fn sign_out(self: &Arc<Self>) -> anyhow::Result<()> {
        let manager = Arc::clone(self);
        crate::run_to_completion(async move { manager.sign_out_inner().await })
            .await
            .context("native sign-out task failed")?
    }

    async fn sign_out_inner(&self) -> anyhow::Result<()> {
        let _credential_operation = self.credential_operation.lock().await;
        self.clear_refresh_token().await?;
        let login_generation = self.session.lock().await.login_generation.wrapping_add(1);
        let mut session = NativeSession::default();
        session.suppress_persisted_resume = true;
        session.login_generation = login_generation;
        {
            let mut current = self.session.lock().await;
            for attempt in current.devices.values() {
                attempt.cancel.cancel();
            }
            for attempt in current.remote_devices.values() {
                attempt.cancel.cancel();
            }
            *current = session;
        }
        self.publish_session_change(None).await
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
                let result = manager
                    .access_token_for_user(force_refresh, &expected_user_id)
                    .await;
                match result {
                    Err(error) if is_authoritative_unauthenticated(&error) => {
                        Err(AuthSignedOut.into())
                    }
                    result => result,
                }
            })
        })
    }

    pub async fn require_user(self: &Arc<Self>, expected_user_id: &str) -> anyhow::Result<()> {
        self.access_token_for_user(false, expected_user_id).await?;
        Ok(())
    }

    pub async fn browser_session(
        self: &Arc<Self>,
        force_refresh: bool,
    ) -> anyhow::Result<Option<NativeBrowserSession>> {
        let manager = Arc::clone(self);
        crate::run_to_completion(async move { manager.browser_session_inner(force_refresh).await })
            .await
            .context("native session task failed")?
    }

    pub async fn signed_in_as(&self, user_id: &str) -> bool {
        let session = self.session.lock().await;
        session.user.as_ref().is_some_and(|user| user.id == user_id)
            && session
                .access_token
                .as_ref()
                .is_some_and(|token| token.expires_at > unix_time_secs())
    }

    async fn browser_session_inner(
        &self,
        force_refresh: bool,
    ) -> anyhow::Result<Option<NativeBrowserSession>> {
        let refresh_generation = self.session.lock().await.refresh_generation;
        let _credential_operation = self.credential_operation.lock().await;
        match self
            .access_token_locked(force_refresh, refresh_generation)
            .await
        {
            Ok(access_token) => {
                let user = self
                    .session
                    .lock()
                    .await
                    .user
                    .clone()
                    .context("native WorkOS session has no user")?;
                Ok(Some(NativeBrowserSession { access_token, user }))
            }
            Err(error) if is_authoritative_unauthenticated(&error) => Ok(None),
            Err(error) => Err(error),
        }
    }

    async fn access_token_for_user(
        self: &Arc<Self>,
        force_refresh: bool,
        expected_user_id: &str,
    ) -> anyhow::Result<String> {
        let manager = Arc::clone(self);
        let expected_user_id = expected_user_id.to_string();
        crate::run_to_completion(async move {
            manager
                .access_token_for_user_inner(force_refresh, &expected_user_id)
                .await
        })
        .await
        .context("native token task failed")?
    }

    async fn access_token_for_user_inner(
        &self,
        force_refresh: bool,
        expected_user_id: &str,
    ) -> anyhow::Result<String> {
        let refresh_generation = self.session.lock().await.refresh_generation;
        let _credential_operation = self.credential_operation.lock().await;
        let token = self
            .access_token_locked(force_refresh, refresh_generation)
            .await?;
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

    async fn access_token_locked(
        &self,
        force_refresh: bool,
        refresh_generation: u64,
    ) -> anyhow::Result<String> {
        let reusable = {
            let session = self.session.lock().await;
            reusable_access_token(&session, force_refresh, refresh_generation)
        };
        if let Some(access_token) = reusable {
            self.flush_refresh_token().await?;
            return Ok(access_token);
        }
        if self.session.lock().await.suppress_persisted_resume {
            return Err(anyhow!(NATIVE_SESSION_SIGNED_OUT));
        }

        let refresh_token = self
            .load_refresh_token()
            .await?
            .context(NATIVE_SESSION_SIGNED_OUT)?;
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
                self.session.lock().await.clear_authenticated_state();
                let cleared = self.clear_refresh_token().await;
                self.publish_session_change(None).await?;
                cleared?;
                Err(error).context(NATIVE_SESSION_EXPIRED)
            }
            Err(error) => {
                let session = self.session.lock().await;
                let retained_access_token = session.access_token.as_ref().and_then(|token| {
                    (!force_refresh && token.expires_at > unix_time_secs())
                        .then(|| token.value.clone())
                });
                if let Some(access_token) = retained_access_token {
                    let kind = if is_transient_refresh_error(&error) {
                        "transient"
                    } else {
                        "unrecognized"
                    };
                    tracing::warn!(
                        "native WorkOS refresh failed ({kind}); retaining current access token: {error}"
                    );
                    return Ok(access_token);
                }
                Err(error).context("failed to refresh native WorkOS session")
            }
        }
    }

    async fn accept_login(
        &self,
        response: AuthenticateResponse,
        completed_login: Option<&str>,
    ) -> anyhow::Result<NativeUser> {
        let user = self.accept_new_login(response).await?;
        let mut session = self.session.lock().await;
        session.login_generation = session.login_generation.wrapping_add(1);
        let invalidated =
            "Another sign-in completed. Start sign-in again if you want to switch accounts.";
        session
            .logins
            .retain(|id, attempt| attempt.in_progress() && Some(id.as_str()) != completed_login);
        for attempt in session.logins.values_mut() {
            attempt.state = LoginState::Failed(invalidated.into());
        }
        for attempt in session.devices.values_mut() {
            attempt.cancel.cancel();
            attempt.result = Some(Err(invalidated.into()));
        }
        for attempt in session.remote_devices.values_mut() {
            attempt.cancel.cancel();
            attempt.result = Some(Err(invalidated.into()));
        }
        Ok(user)
    }

    async fn accept_new_login(&self, response: AuthenticateResponse) -> anyhow::Result<NativeUser> {
        self.accept_authentication_with_persistence(response, true)
            .await
    }

    async fn accept_authentication(
        &self,
        response: AuthenticateResponse,
    ) -> anyhow::Result<NativeUser> {
        self.accept_authentication_with_persistence(response, false)
            .await
    }

    async fn accept_authentication_with_persistence(
        &self,
        response: AuthenticateResponse,
        persist_before_acceptance: bool,
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
        if persist_before_acceptance {
            self.save_refresh_token(refresh_token.clone()).await?;
        }
        let changed = self
            .session
            .lock()
            .await
            .user
            .as_ref()
            .map(|user| user.id.as_str())
            != Some(user.id.as_str());
        {
            let mut session = self.session.lock().await;
            session.access_token = Some(AccessToken {
                value: access_token,
                expires_at,
            });
            session.refresh_token = Some(refresh_token);
            session.refresh_token_persisted = persist_before_acceptance;
            session.refresh_generation = session.refresh_generation.wrapping_add(1);
            session.user = Some(user.clone());
            session.suppress_persisted_resume = false;
        }
        self.flush_refresh_token().await?;
        if changed {
            self.publish_session_change(Some(&user.id)).await?;
        }
        Ok(user)
    }

    pub fn subscribe_changes(&self) -> watch::Receiver<u64> {
        self.changes.subscribe()
    }

    async fn publish_session_change(&self, user_id: Option<&str>) -> anyhow::Result<()> {
        let result = match &self.browser_sessions {
            Some(sessions) => sessions.sync_with_owner(user_id).await,
            None => Ok(()),
        };
        self.changes
            .send_modify(|generation| *generation = generation.wrapping_add(1));
        result
    }

    async fn load_refresh_token(&self) -> anyhow::Result<Option<String>> {
        {
            let session = self.session.lock().await;
            if let Some(token) = &session.refresh_token {
                return Ok(Some(token.clone()));
            }
        }
        let store = Arc::clone(&self.refresh_tokens);
        let token = tokio::task::spawn_blocking(move || store.load())
            .await
            .context("credential-store task failed")??;
        match token {
            Some(token) if token.trim().is_empty() => {
                anyhow::bail!("stored WorkOS refresh token is empty")
            }
            Some(token) => {
                let mut session = self.session.lock().await;
                if session.refresh_token.is_none() {
                    session.refresh_token = Some(token.clone());
                    session.refresh_token_persisted = true;
                }
                Ok(session.refresh_token.clone())
            }
            None => Ok(None),
        }
    }

    async fn flush_refresh_token(&self) -> anyhow::Result<()> {
        let token = {
            let session = self.session.lock().await;
            if session.refresh_token_persisted {
                return Ok(());
            }
            session.refresh_token.clone()
        };
        let Some(token) = token else {
            return Ok(());
        };
        self.save_refresh_token(token).await?;
        self.session.lock().await.refresh_token_persisted = true;
        Ok(())
    }

    async fn save_refresh_token(&self, refresh_token: String) -> anyhow::Result<()> {
        let store = Arc::clone(&self.refresh_tokens);
        let credential_store = tokio::task::spawn_blocking(move || store.save(&refresh_token))
            .await
            .context("credential-store task failed")??;
        self.session.lock().await.credential_store = Some(credential_store);
        Ok(())
    }

    pub async fn credential_store(&self) -> Option<CredentialStore> {
        self.session.lock().await.credential_store
    }

    async fn clear_refresh_token(&self) -> anyhow::Result<()> {
        let store = Arc::clone(&self.refresh_tokens);
        tokio::task::spawn_blocking(move || store.clear())
            .await
            .context("credential-store task failed")?
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

fn reusable_access_token(
    session: &NativeSession,
    force_refresh: bool,
    refresh_generation: u64,
) -> Option<String> {
    let access_token = session.access_token.as_ref()?;
    let now = unix_time_secs();
    if access_token.expires_at <= now {
        return None;
    }
    let rotated_while_waiting = session.refresh_generation != refresh_generation;
    if force_refresh {
        return rotated_while_waiting.then(|| access_token.value.clone());
    }
    let refresh_before = now.saturating_add(ACCESS_TOKEN_REFRESH_MARGIN_SECS);
    (access_token.expires_at > refresh_before).then(|| access_token.value.clone())
}

fn is_authoritative_unauthenticated(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        let message = cause.to_string();
        message == NATIVE_SESSION_SIGNED_OUT || message == NATIVE_SESSION_EXPIRED
    })
}

fn is_terminal_refresh_error(error: &workos::Error) -> bool {
    matches!(error.status(), Some(400 | 401)) && error.code() == Some("invalid_grant")
}

fn is_transient_refresh_error(error: &workos::Error) -> bool {
    matches!(error, workos::Error::Network(_))
        || error.is_rate_limited()
        || error.is_server_error()
        || matches!(error.status(), Some(408))
}

fn login_failure_message(error: &anyhow::Error) -> String {
    let Some(provider_error) = error.downcast_ref::<workos::Error>() else {
        return format!("{error:#}");
    };
    match provider_error.request_id() {
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
mod tests;
