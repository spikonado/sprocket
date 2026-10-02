use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use anyhow::{Context, bail, ensure};
use base64::Engine;
use futures::future::BoxFuture;
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header, jwk::Jwk};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use sprocket_agent::{ChatGptAccess, ChatGptCredentials};
use tokio::sync::{Mutex, watch};
use uuid::Uuid;

const ISSUER: &str = "https://auth.openai.com";
const RESOURCE: &str = "https://api.openai.com/v1";
const SCOPES: &str =
    "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const DYNAMIC_CLIENT: &str = "dynamic_agent_client";
const RESPONSE_LIMIT: usize = 1024 * 1024;

#[derive(Clone)]
pub(crate) struct ChatGptService {
    state: Arc<Mutex<Store>>,
    path: Arc<PathBuf>,
    issuer: String,
    token_endpoint: String,
    client: reqwest::Client,
    watches: Arc<StdMutex<HashMap<String, watch::Sender<Option<String>>>>>,
    persistence_pending: Arc<AtomicBool>,
    storage_error: Option<String>,
    #[cfg(test)]
    persist_failure_after: Arc<StdMutex<Option<usize>>>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Store {
    version: u32,
    host_id: String,
    users: HashMap<String, UserAccounts>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UserAccounts {
    accounts: Vec<Account>,
    active: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Account {
    connection_id: String,
    client_id: String,
    subject: String,
    email: Option<String>,
    session_id: String,
    tokens: Option<Tokens>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    retired_refresh_tokens: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Tokens {
    access_token: String,
    refresh_token: String,
    id_token: String,
    scopes: Vec<String>,
    expires_at: u64,
    earliest_refresh_at: u64,
    refresh_in_flight: bool,
}

pub(crate) struct PendingGrant {
    user: String,
    expected_connection: Option<String>,
    expected_session: Option<String>,
    client_id: String,
    subject: String,
    email: Option<String>,
    tokens: Tokens,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ServiceStatus {
    accounts: Vec<AccountStatus>,
    active_connection_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AccountStatus {
    connection_id: String,
    label: String,
    connected: bool,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: String,
    id_token: Option<String>,
    token_type: String,
    expires_in: u64,
    scope: Option<String>,
    earliest_refresh_at: Option<u64>,
}

#[derive(Clone, Deserialize)]
struct Identity {
    sub: String,
    nonce: Option<String>,
    email: Option<String>,
}

#[derive(Deserialize)]
struct Discovery {
    issuer: String,
    revocation_endpoint: String,
}

#[derive(Deserialize)]
struct OAuthError {
    error: String,
}

fn now() -> u64 {
    crate::now_ms() / 1000
}

fn session(accounts: &UserAccounts) -> Option<String> {
    let active = accounts.active.as_ref()?;
    let account = accounts
        .accounts
        .iter()
        .find(|account| &account.connection_id == active)?;
    account.tokens.as_ref().map(|_| account.session_id.clone())
}

fn active_account<'a>(
    state: &'a mut Store,
    user: &str,
) -> anyhow::Result<(&'a mut UserAccounts, String)> {
    let accounts = state
        .users
        .get_mut(user)
        .context("Connect ChatGPT locally in Settings before starting a run.")?;
    let active = accounts
        .active
        .clone()
        .context("Select a ChatGPT account in Settings.")?;
    ensure!(
        accounts
            .accounts
            .iter()
            .any(|account| account.connection_id == active),
        "Select a ChatGPT account in Settings."
    );
    Ok((accounts, active))
}

fn scopes(value: &str) -> Vec<String> {
    value.split_whitespace().map(str::to_owned).collect()
}

fn require_scopes(granted: &[String]) -> anyhow::Result<()> {
    ensure!(
        [
            "chatgpt.tokens.use.direct",
            "resource.invoke",
            "offline_access"
        ]
        .iter()
        .all(|required| granted.iter().any(|scope| scope == required)),
        "ChatGPT plan usage was not authorized. Reconnect and approve plan access."
    );
    Ok(())
}

fn issued_client(selected: Option<&str>, callback: Option<&str>) -> anyhow::Result<String> {
    let client = match (selected, callback) {
        (Some(selected), Some(callback)) => {
            ensure!(
                selected == callback,
                "ChatGPT returned a different client registration."
            );
            selected
        }
        (Some(selected), None) => selected,
        (None, Some(callback)) => callback,
        (None, None) => {
            bail!("ChatGPT registration did not return an issued client ID. Start sign-in again.")
        }
    };
    ensure!(
        client != DYNAMIC_CLIENT && !client.is_empty() && client.len() <= 512,
        "ChatGPT returned an invalid client registration."
    );
    Ok(client.to_owned())
}

fn token_tuple(
    response: TokenResponse,
    previous: Option<&Tokens>,
    received_at: u64,
) -> anyhow::Result<Tokens> {
    ensure!(
        response.token_type.eq_ignore_ascii_case("bearer"),
        "ChatGPT returned an unsupported token type."
    );
    ensure!(
        !response.access_token.is_empty()
            && !response.refresh_token.is_empty()
            && response.access_token.len() <= 128 * 1024
            && response.refresh_token.len() <= 128 * 1024,
        "ChatGPT returned invalid credentials."
    );
    ensure!(
        response.expires_in > 0 && response.expires_in <= 24 * 60 * 60,
        "ChatGPT returned invalid credential expiry."
    );
    let granted = match response.scope {
        Some(scope) => scopes(&scope),
        None => previous
            .context("ChatGPT did not return granted scopes.")?
            .scopes
            .clone(),
    };
    require_scopes(&granted)?;
    let id_token = response
        .id_token
        .or_else(|| previous.map(|tokens| tokens.id_token.clone()))
        .context("ChatGPT did not return an ID token.")?;
    ensure!(
        !id_token.is_empty() && id_token.len() <= 128 * 1024,
        "ChatGPT returned an invalid ID token."
    );
    Ok(Tokens {
        access_token: response.access_token,
        refresh_token: response.refresh_token,
        id_token,
        scopes: granted,
        expires_at: received_at
            .checked_add(response.expires_in)
            .context("Invalid expiry.")?,
        earliest_refresh_at: response.earliest_refresh_at.unwrap_or(received_at),
        refresh_in_flight: false,
    })
}

fn verify_identity(
    token: &str,
    keys: &[Jwk],
    client_id: &str,
    nonce: Option<&str>,
) -> anyhow::Result<Identity> {
    let header = decode_header(token).map_err(|_| anyhow::anyhow!("Invalid ChatGPT ID token."))?;
    ensure!(
        header.alg == Algorithm::RS256,
        "Unsupported ChatGPT ID token signature."
    );
    let key_id = header.kid.context("ChatGPT ID token has no signing key.")?;
    let key = keys
        .iter()
        .find(|key| key.common.key_id.as_deref() == Some(key_id.as_str()))
        .context("Unknown ChatGPT signing key.")?;
    let key = DecodingKey::from_jwk(key).context("Invalid ChatGPT signing key.")?;
    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_issuer(&[ISSUER]);
    validation.set_audience(&[client_id]);
    validation.set_required_spec_claims(&["exp", "iss", "aud", "sub"]);
    validation.leeway = 0;
    validation.validate_nbf = true;
    let identity = decode::<Identity>(token, &key, &validation)
        .map_err(|_| anyhow::anyhow!("ChatGPT ID token verification failed."))?
        .claims;
    ensure!(
        !identity.sub.is_empty() && identity.sub.len() <= 1024,
        "Invalid ChatGPT subject."
    );
    if let Some(nonce) = nonce {
        ensure!(
            identity.nonce.as_deref() == Some(nonce),
            "ChatGPT ID token nonce did not match."
        );
    }
    Ok(identity)
}

async fn json<T: DeserializeOwned>(mut response: reqwest::Response) -> anyhow::Result<T> {
    ensure!(
        response
            .content_length()
            .is_none_or(|length| length <= RESPONSE_LIMIT as u64),
        "Provider returned an oversized response."
    );
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .context("Could not read provider response.")?
    {
        ensure!(
            bytes.len().saturating_add(chunk.len()) <= RESPONSE_LIMIT,
            "Provider returned an oversized response."
        );
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| anyhow::anyhow!("Provider returned an invalid response."))
}

impl ChatGptService {
    pub(crate) fn load(data_dir: &Path) -> anyhow::Result<Arc<Self>> {
        Self::load_with_issuer(data_dir, ISSUER)
    }

    pub(crate) fn load_or_unavailable(data_dir: &Path) -> anyhow::Result<Arc<Self>> {
        Self::load(data_dir).or_else(|_| {
            Self::from_state(
                data_dir.join("chatgpt-siwc.json"),
                Store {
                    version: 1,
                    host_id: format!("urn:uuid:{}", Uuid::new_v4()),
                    users: HashMap::new(),
                },
                ISSUER,
                Some("Local ChatGPT storage is unavailable. Preserve chatgpt-siwc.json in the Sprocket data directory and repair or restore it, then restart Sprocket. Other providers remain available.".to_owned()),
            )
        })
    }

    pub(crate) fn available(&self) -> bool {
        self.storage_error.is_none()
    }

    fn require_storage(&self) -> anyhow::Result<()> {
        if let Some(error) = &self.storage_error {
            bail!("{error}");
        }
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn test_load(data_dir: &Path, issuer: &str) -> Arc<Self> {
        Self::load_with_issuer(data_dir, issuer).unwrap()
    }

    fn load_with_issuer(data_dir: &Path, issuer: &str) -> anyhow::Result<Arc<Self>> {
        let path = data_dir.join("chatgpt-siwc.json");
        let mut state: Store = match std::fs::read(&path) {
            Ok(bytes) => {
                serde_json::from_slice(&bytes).context("Could not read local ChatGPT state.")?
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Store {
                version: 1,
                host_id: format!("urn:uuid:{}", Uuid::new_v4()),
                users: HashMap::new(),
            },
            Err(error) => return Err(error).context("Could not read local ChatGPT state."),
        };
        ensure!(
            state.version == 1,
            "Unsupported local ChatGPT state version."
        );
        ensure!(
            state.host_id.starts_with("urn:uuid:") && Uuid::parse_str(&state.host_id[9..]).is_ok(),
            "Invalid local ChatGPT host identity."
        );
        for accounts in state.users.values_mut() {
            for account in &mut accounts.accounts {
                issued_client(Some(&account.client_id), None)?;
                ensure!(
                    !account.subject.is_empty(),
                    "Invalid local ChatGPT identity."
                );
                if account
                    .tokens
                    .as_ref()
                    .is_some_and(|tokens| tokens.refresh_in_flight)
                {
                    if let Some(tokens) = account.tokens.take() {
                        account.retired_refresh_tokens.push(tokens.refresh_token);
                    }
                    account.session_id = Uuid::new_v4().to_string();
                }
            }
            accounts.accounts.retain(|account| {
                account.tokens.is_some() || !account.retired_refresh_tokens.is_empty()
            });
            let active_survived = accounts.accounts.iter().any(|account| {
                account.tokens.is_some() && Some(&account.connection_id) == accounts.active.as_ref()
            });
            if !active_survived {
                accounts.active = None;
            }
        }
        state
            .users
            .retain(|_, accounts| !accounts.accounts.is_empty());
        crate::profile::write_private_file(&path, &serde_json::to_vec(&state)?)?;
        Self::from_state(path, state, issuer, None)
    }

    fn from_state(
        path: PathBuf,
        state: Store,
        issuer: &str,
        storage_error: Option<String>,
    ) -> anyhow::Result<Arc<Self>> {
        let watches = state
            .users
            .iter()
            .map(|(user, accounts)| {
                let (sender, _) = watch::channel(session(accounts));
                (user.clone(), sender)
            })
            .collect();
        Ok(Arc::new(Self {
            state: Arc::new(Mutex::new(state)),
            path: Arc::new(path),
            issuer: issuer.to_owned(),
            token_endpoint: format!("{issuer}/api/accounts/oauth/token"),
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .retry(reqwest::retry::never())
                .connect_timeout(Duration::from_secs(5))
                .timeout(Duration::from_secs(15))
                .build()?,
            watches: Arc::new(StdMutex::new(watches)),
            persistence_pending: Arc::new(AtomicBool::new(false)),
            storage_error,
            #[cfg(test)]
            persist_failure_after: Arc::new(StdMutex::new(None)),
        }))
    }

    async fn persist(&self, state: &Store) -> anyhow::Result<()> {
        self.require_storage()?;
        self.persistence_pending.store(true, Ordering::Release);
        #[cfg(test)]
        {
            let mut failure_after = self.persist_failure_after.lock().unwrap();
            if let Some(remaining) = failure_after.as_mut() {
                if *remaining == 0 {
                    *failure_after = None;
                    bail!("Could not save local ChatGPT credentials.");
                }
                *remaining -= 1;
            }
        }
        let bytes = serde_json::to_vec(state)?;
        let path = Arc::clone(&self.path);
        tokio::task::spawn_blocking(move || crate::profile::write_private_file(&path, &bytes))
            .await
            .context("ChatGPT storage task stopped.")?
            .context("Could not save local ChatGPT credentials.")?;
        self.persistence_pending.store(false, Ordering::Release);
        Ok(())
    }

    fn notify(&self, user: &str, accounts: &UserAccounts) {
        let mut watches = self
            .watches
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let sender = watches
            .entry(user.to_owned())
            .or_insert_with(|| watch::channel(None).0);
        sender.send_replace(session(accounts));
    }

    pub(crate) fn for_user(self: &Arc<Self>, user: String) -> Arc<dyn ChatGptCredentials> {
        Arc::new(UserCredentials {
            service: Arc::clone(self),
            user,
        })
    }

    pub(crate) async fn authorization(
        &self,
        user: &str,
        connection: Option<&str>,
        redirect_uri: &str,
        state: &str,
        nonce: &str,
        verifier: &str,
    ) -> anyhow::Result<String> {
        self.require_storage()?;
        let stored = self.state.lock().await;
        let account = connection
            .map(|connection| {
                stored
                    .users
                    .get(user)
                    .and_then(|accounts| {
                        accounts
                            .accounts
                            .iter()
                            .find(|account| account.connection_id == connection)
                    })
                    .context("Saved ChatGPT account was not found.")
            })
            .transpose()?;
        let mut url = url::Url::parse("https://auth.openai.com/api/accounts/authorize")?;
        let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(Sha256::digest(verifier.as_bytes()));
        url.query_pairs_mut().extend_pairs([
            (
                "client_id",
                account.map_or(DYNAMIC_CLIENT, |account| account.client_id.as_str()),
            ),
            ("ext_agent_host_id", stored.host_id.as_str()),
            ("response_type", "code"),
            ("redirect_uri", redirect_uri),
            ("scope", SCOPES),
            ("resource", RESOURCE),
            ("state", state),
            ("nonce", nonce),
            ("code_challenge_method", "S256"),
            ("code_challenge", challenge.as_str()),
        ]);
        if account.is_none() {
            url.query_pairs_mut()
                .append_pair("agent_name_hint", "Sprocket");
        }
        Ok(url.to_string())
    }

    async fn identity(
        &self,
        token: &str,
        client_id: &str,
        nonce: Option<&str>,
    ) -> anyhow::Result<Identity> {
        let response = self
            .client
            .get(format!("{}/.well-known/jwks.json", self.issuer))
            .send()
            .await
            .context("Could not retrieve ChatGPT signing keys.")?;
        ensure!(
            response.status().is_success(),
            "Could not retrieve ChatGPT signing keys."
        );
        let keys: jsonwebtoken::jwk::JwkSet = json(response).await?;
        verify_identity(token, &keys.keys, client_id, nonce)
    }

    pub(crate) async fn exchange(
        &self,
        user: &str,
        connection: Option<&str>,
        redirect_uri: &str,
        nonce: &str,
        verifier: &str,
        code: &str,
        callback_client: Option<&str>,
    ) -> anyhow::Result<PendingGrant> {
        let account = {
            let state = self.state.lock().await;
            connection
                .map(|connection| {
                    state
                        .users
                        .get(user)
                        .and_then(|accounts| {
                            accounts
                                .accounts
                                .iter()
                                .find(|account| account.connection_id == connection)
                        })
                        .cloned()
                        .context("Saved ChatGPT account was not found.")
                })
                .transpose()?
        };
        let client_id = issued_client(
            account.as_ref().map(|account| account.client_id.as_str()),
            callback_client,
        )?;
        let sent_at = now();
        let response = self
            .client
            .post(&self.token_endpoint)
            .form(&[
                ("grant_type", "authorization_code"),
                ("client_id", client_id.as_str()),
                ("code", code),
                ("code_verifier", verifier),
                ("redirect_uri", redirect_uri),
                ("resource", RESOURCE),
            ])
            .send()
            .await
            .context("Could not exchange ChatGPT sign-in. Start sign-in again.")?;
        ensure!(
            response.status().is_success(),
            "ChatGPT rejected sign-in. Start sign-in again."
        );
        let response: TokenResponse = json(response).await?;
        let refresh_token = response.refresh_token.clone();
        let outcome = async {
            let tokens = token_tuple(response, None, sent_at)?;
            let identity = self
                .identity(&tokens.id_token, &client_id, Some(nonce))
                .await?;
            if let Some(account) = &account {
                ensure!(
                    identity.sub == account.subject,
                    "ChatGPT signed in to a different account. Select Add account instead."
                );
            }
            Ok(PendingGrant {
                user: user.to_owned(),
                expected_connection: connection.map(str::to_owned),
                expected_session: account.as_ref().map(|account| account.session_id.clone()),
                client_id: client_id.clone(),
                subject: identity.sub,
                email: identity.email,
                tokens,
            })
        }
        .await;
        if outcome.is_err() {
            self.revoke(&client_id, &refresh_token).await;
        }
        outcome
    }

    pub(crate) async fn discard(&self, grant: PendingGrant) {
        self.revoke(&grant.client_id, &grant.tokens.refresh_token)
            .await;
    }

    pub(crate) async fn commit(&self, user: &str, grant: PendingGrant) -> anyhow::Result<()> {
        let mut state = self.state.lock().await;
        let outcome = async {
            ensure!(
                grant.user == user,
                "ChatGPT sign-in belongs to another Sprocket account."
            );
            let mut candidate = state.clone();
            let accounts = candidate.users.entry(user.to_owned()).or_default();
            let existing = if let Some(connection) = &grant.expected_connection {
                let account = accounts
                    .accounts
                    .iter_mut()
                    .find(|account| &account.connection_id == connection)
                    .context("ChatGPT account changed while signing in.")?;
                ensure!(
                    Some(&account.session_id) == grant.expected_session.as_ref()
                        && account.client_id == grant.client_id
                        && account.subject == grant.subject,
                    "ChatGPT account changed while signing in."
                );
                Some(account)
            } else {
                accounts.accounts.iter_mut().find(|account| {
                    account.client_id == grant.client_id && account.subject == grant.subject
                })
            };
            let connection_id = existing.as_ref().map_or_else(
                || Uuid::new_v4().to_string(),
                |account| account.connection_id.clone(),
            );
            let mut retired_refresh_tokens = existing
                .as_ref()
                .map(|account| account.retired_refresh_tokens.clone())
                .unwrap_or_default();
            if let Some(tokens) = existing
                .as_ref()
                .and_then(|account| account.tokens.as_ref())
                && tokens.refresh_token != grant.tokens.refresh_token
                && !retired_refresh_tokens.contains(&tokens.refresh_token)
            {
                retired_refresh_tokens.push(tokens.refresh_token.clone());
            }
            let account = Account {
                connection_id: connection_id.clone(),
                client_id: grant.client_id.clone(),
                subject: grant.subject.clone(),
                email: grant.email.clone(),
                session_id: Uuid::new_v4().to_string(),
                tokens: Some(grant.tokens.clone()),
                retired_refresh_tokens,
            };
            if let Some(existing) = existing {
                *existing = account;
            } else {
                accounts.accounts.push(account);
            }
            accounts.active = Some(connection_id.clone());
            self.persist(&candidate).await?;
            *state = candidate;
            self.notify(user, state.users.get(user).unwrap());
            let retired = state.users[user]
                .accounts
                .iter()
                .find(|account| account.connection_id == connection_id)
                .unwrap()
                .retired_refresh_tokens
                .clone();
            let mut revoked = false;
            for token in retired {
                if self.revoke(&grant.client_id, &token).await {
                    revoked = true;
                    let account = state
                        .users
                        .get_mut(user)
                        .unwrap()
                        .accounts
                        .iter_mut()
                        .find(|account| account.connection_id == connection_id)
                        .unwrap();
                    account
                        .retired_refresh_tokens
                        .retain(|stored| stored != &token);
                }
            }
            if revoked && self.persist(&state).await.is_err() {
                tracing::warn!("Could not save replaced ChatGPT session revocation state");
            }
            Ok(())
        }
        .await;
        drop(state);
        if outcome.is_err() {
            self.discard(grant).await;
        }
        outcome
    }

    pub(crate) async fn select(&self, user: &str, connection: &str) -> anyhow::Result<()> {
        let service = self.clone();
        let user = user.to_owned();
        let connection = connection.to_owned();
        tokio::spawn(async move {
            let mut state = service.state.lock().await;
            let mut candidate = state.clone();
            let accounts = candidate
                .users
                .get_mut(&user)
                .context("Saved ChatGPT account was not found.")?;
            ensure!(
                accounts
                    .accounts
                    .iter()
                    .any(|account| account.connection_id == connection && account.tokens.is_some()),
                "Saved ChatGPT account was not found."
            );
            if accounts.active.as_deref() != Some(&connection) {
                if let Some(account) = accounts
                    .accounts
                    .iter_mut()
                    .find(|account| account.connection_id == connection)
                {
                    account.session_id = Uuid::new_v4().to_string();
                }
                accounts.active = Some(connection);
            }
            service.persist(&candidate).await?;
            *state = candidate;
            service.notify(&user, state.users.get(&user).unwrap());
            Ok(())
        })
        .await
        .context("ChatGPT selection task stopped.")?
    }

    async fn revoke(&self, client_id: &str, refresh_token: &str) -> bool {
        let discovery = async {
            let response = self
                .client
                .get(format!("{}/.well-known/openid-configuration", self.issuer))
                .timeout(Duration::from_secs(5))
                .send()
                .await
                .ok()?;
            if !response.status().is_success() {
                return None;
            }
            let discovery: Discovery = json(response).await.ok()?;
            let endpoint = url::Url::parse(&discovery.revocation_endpoint).ok()?;
            let issuer = url::Url::parse(&self.issuer).ok()?;
            if discovery.issuer != self.issuer
                || endpoint.origin() != issuer.origin()
                || !endpoint.username().is_empty()
                || endpoint.password().is_some()
            {
                return None;
            }
            Some(endpoint)
        }
        .await;
        let Some(endpoint) = discovery else {
            return false;
        };
        for attempt in 0..2 {
            let response = self
                .client
                .post(endpoint.clone())
                .timeout(Duration::from_secs(5))
                .form(&[
                    ("token", refresh_token),
                    ("token_type_hint", "refresh_token"),
                    ("client_id", client_id),
                ])
                .send()
                .await;
            match response {
                Ok(response) if response.status().as_u16() == 200 => return true,
                Ok(response) if !response.status().is_server_error() => return false,
                _ => {}
            }
            if attempt == 0 {
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        }
        false
    }

    pub(crate) async fn disconnect(
        &self,
        user: &str,
        connection: &str,
    ) -> anyhow::Result<Option<String>> {
        self.forget(user, connection, false).await
    }

    async fn forget(
        &self,
        user: &str,
        connection: &str,
        only_if_tokenless: bool,
    ) -> anyhow::Result<Option<String>> {
        let service = self.clone();
        let user = user.to_owned();
        let connection = connection.to_owned();
        tokio::spawn(async move {
            let mut state = service.state.lock().await;
            let mut candidate = state.clone();
            let account = candidate.users.get_mut(&user)
                .and_then(|accounts| accounts.accounts.iter_mut().find(|account| account.connection_id == connection));
            if only_if_tokenless && account.as_ref().is_none_or(|account| account.tokens.is_some()) {
                return Ok(None);
            }
            let account = account.context("Saved ChatGPT account was not found.")?;
            if let Some(tokens) = account.tokens.take() {
                account.retired_refresh_tokens.push(tokens.refresh_token);
            }
            account.subject = "signed-out".to_owned();
            account.email = None;
            account.session_id = Uuid::new_v4().to_string();
            let marker_session = account.session_id.clone();
            let retired = account.retired_refresh_tokens.clone();
            let client_id = account.client_id.clone();
            let accounts = candidate.users.get_mut(&user).unwrap();
            if accounts.active.as_deref() == Some(&connection) {
                accounts.active = None;
            }
            service.persist(&candidate).await?;
            *state = candidate;
            service.notify(&user, &state.users[&user]);
            drop(state);
            let mut confirmed = true;
            for token in retired {
                confirmed &= service.revoke(&client_id, &token).await;
            }
            let mut state = service.state.lock().await;
            let saved = if let Some(accounts) = state.users.get_mut(&user) {
                accounts.accounts.retain(|account| {
                    account.connection_id != connection || account.session_id != marker_session
                });
                if accounts.accounts.is_empty() {
                    state.users.remove(&user);
                }
                service.persist(&state).await
            } else {
                Ok(())
            };
            let warning = (!confirmed).then(|| "Signed out locally. OpenAI revocation could not be confirmed. Remove the agent in ChatGPT settings if needed.".to_owned());
            if let Err(error) = saved {
                return Err(match warning {
                    Some(warning) => anyhow::anyhow!("{error} {warning}"),
                    None => error,
                });
            }
            Ok(warning)
        }).await.context("ChatGPT sign-out task stopped.")?
    }

    async fn access(&self, user: &str) -> anyhow::Result<ChatGptAccess> {
        self.require_storage()?;
        let mut state = self.state.lock().await;
        if self.persistence_pending.load(Ordering::Acquire) {
            self.persist(&state).await?;
        }
        let (accounts, active) = active_account(&mut state, user)?;
        let account = accounts
            .accounts
            .iter_mut()
            .find(|account| account.connection_id == active)
            .unwrap();
        let tokens = account
            .tokens
            .clone()
            .context("Reconnect ChatGPT locally in Settings.")?;
        require_scopes(&tokens.scopes)?;
        if tokens.expires_at > now().saturating_add(60) && !tokens.refresh_in_flight {
            return Ok(ChatGptAccess {
                connection_id: account.session_id.clone(),
                access_token: tokens.access_token,
                expires_at: tokens.expires_at.saturating_mul(1000),
            });
        }
        ensure!(
            now() >= tokens.earliest_refresh_at,
            "ChatGPT credentials cannot refresh yet. Retry later."
        );
        let client_id = account.client_id.clone();
        let subject = account.subject.clone();
        account.tokens.as_mut().unwrap().refresh_in_flight = true;
        self.persist(&state).await?;
        let sent_at = now();
        let result = self
            .client
            .post(&self.token_endpoint)
            .form(&[
                ("grant_type", "refresh_token"),
                ("client_id", client_id.as_str()),
                ("refresh_token", tokens.refresh_token.as_str()),
                ("resource", RESOURCE),
            ])
            .send()
            .await;
        let refreshed = match result {
            Ok(response) if response.status().is_success() => {
                let response: TokenResponse = match json(response).await {
                    Ok(response) => response,
                    Err(error) => {
                        let (accounts, active) = active_account(&mut state, user)?;
                        let account = accounts
                            .accounts
                            .iter_mut()
                            .find(|account| account.connection_id == active)
                            .unwrap();
                        account.tokens = None;
                        account.session_id = Uuid::new_v4().to_string();
                        self.notify(user, accounts);
                        self.persist(&state).await?;
                        return Err(error);
                    }
                };
                let issued_refresh = response.refresh_token.clone();
                let outcome = async {
                    if let Some(id_token) = &response.id_token {
                        let identity = self.identity(id_token, &client_id, None).await?;
                        ensure!(
                            identity.sub == subject,
                            "ChatGPT refresh returned another identity."
                        );
                    }
                    token_tuple(response, Some(&tokens), sent_at)
                }
                .await;
                if outcome.is_err() {
                    self.revoke(&client_id, &issued_refresh).await;
                }
                outcome
            }
            Ok(response) => {
                let status = response.status();
                let terminal = json::<OAuthError>(response)
                    .await
                    .ok()
                    .is_some_and(|error| {
                        [
                            "invalid_grant",
                            "refresh_token_expired",
                            "refresh_token_reused",
                            "refresh_token_invalidated",
                            "token_revoked",
                        ]
                        .contains(&error.error.as_str())
                    });
                if !terminal && (status.is_server_error() || status.as_u16() == 429) {
                    let (accounts, active) = active_account(&mut state, user)?;
                    let account = accounts
                        .accounts
                        .iter_mut()
                        .find(|account| account.connection_id == active)
                        .unwrap();
                    account.tokens = Some(tokens);
                    self.persist(&state).await?;
                    bail!("ChatGPT refresh is temporarily unavailable. Retry later.");
                }
                Err(anyhow::anyhow!(if terminal {
                    "ChatGPT session expired. Reconnect locally in Settings."
                } else {
                    "ChatGPT refresh could not be completed safely. Reconnect locally in Settings."
                }))
            }
            Err(error) if error.is_connect() => {
                let (accounts, active) = active_account(&mut state, user)?;
                let account = accounts
                    .accounts
                    .iter_mut()
                    .find(|account| account.connection_id == active)
                    .unwrap();
                account.tokens = Some(tokens);
                self.persist(&state).await?;
                bail!(
                    "Could not connect to ChatGPT to refresh credentials. Retry when connectivity returns."
                );
            }
            Err(_) => Err(anyhow::anyhow!(
                "ChatGPT refresh was interrupted. Reconnect locally in Settings."
            )),
        };
        let (accounts, active) = active_account(&mut state, user)?;
        let account = accounts
            .accounts
            .iter_mut()
            .find(|account| account.connection_id == active)
            .unwrap();
        match refreshed {
            Ok(refreshed) => {
                let access = ChatGptAccess {
                    connection_id: account.session_id.clone(),
                    access_token: refreshed.access_token.clone(),
                    expires_at: refreshed.expires_at.saturating_mul(1000),
                };
                account.tokens = Some(refreshed);
                self.persist(&state).await?;
                Ok(access)
            }
            Err(error) => {
                account.tokens = None;
                account.session_id = Uuid::new_v4().to_string();
                self.notify(user, accounts);
                self.persist(&state).await?;
                Err(error)
            }
        }
    }

    pub(crate) async fn status(&self, user: &str) -> anyhow::Result<ServiceStatus> {
        let service = self.clone();
        let user = user.to_owned();
        tokio::spawn(async move {
            let mut error = service.storage_error.clone();
            let mut cleanup_warning = None;
            if error.is_none() {
                let forgotten = {
                    let state = service.state.lock().await;
                    state
                        .users
                        .get(&user)
                        .map(|accounts| {
                            accounts
                                .accounts
                                .iter()
                                .filter(|account| account.tokens.is_none())
                                .map(|account| account.connection_id.clone())
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default()
                };
                for connection in forgotten {
                    match service.forget(&user, &connection, true).await {
                        Ok(Some(warning)) => cleanup_warning = Some(warning),
                        Ok(None) => {}
                        Err(failure) => error = Some(failure.to_string()),
                    }
                }
            }
            let connected = {
                let state = service.state.lock().await;
                if service.persistence_pending.load(Ordering::Acquire) {
                    if let Err(failure) = service.persist(&state).await {
                        error = Some(failure.to_string());
                    }
                }
                state.users.get(&user).and_then(session).is_some()
            };
            if connected && error.is_none() {
                if let Err(failure) = service.access(&user).await {
                    error = Some(failure.to_string());
                }
            }
            let state = service.state.lock().await;
            let accounts = state.users.get(&user).cloned().unwrap_or_default();
            Ok(ServiceStatus {
                accounts: accounts
                    .accounts
                    .iter()
                    .filter(|account| account.tokens.is_some())
                    .map(|account| AccountStatus {
                        connection_id: account.connection_id.clone(),
                        label: account
                            .email
                            .clone()
                            .unwrap_or_else(|| "ChatGPT account".into()),
                        connected: account.tokens.is_some(),
                    })
                    .collect(),
                active_connection_id: accounts.active,
                error: match (error, cleanup_warning) {
                    (Some(error), Some(warning)) => Some(format!("{error} {warning}")),
                    (error, warning) => error.or(warning),
                },
            })
        })
        .await
        .context("ChatGPT status task stopped.")?
    }
}

struct UserCredentials {
    service: Arc<ChatGptService>,
    user: String,
}

impl ChatGptCredentials for UserCredentials {
    fn connection(&self) -> watch::Receiver<Option<String>> {
        let mut watches = self
            .service
            .watches
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        watches
            .entry(self.user.clone())
            .or_insert_with(|| watch::channel(None).0)
            .subscribe()
    }

    fn credential(&self) -> BoxFuture<'_, anyhow::Result<ChatGptAccess>> {
        let service = Arc::clone(&self.service);
        let user = self.user.clone();
        Box::pin(async move {
            tokio::spawn(async move { service.access(&user).await })
                .await
                .context("ChatGPT refresh task stopped.")?
        })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use base64::Engine;
    use jsonwebtoken::{EncodingKey, Header, encode};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::*;

    const GRANTED: &str =
        "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
    const RSA_KEY: &str = "-----BEGIN PRIVATE KEY-----\nMIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCrZ9ZLr29AUzPN\nLs0LovbC5x+v4WOaQX9Eo4Bc709L0ShbuJx5ji/Da20c95Q1fvSMtsH7TGcKP+39\noYbghsbmZoCLp58DyyRbXlEU5/lfPefy0vuqZtIY3Ofe/89Ofe0TfxxWdRGyYn2y\n6rwWysR1jsigVFHoW7E0UKcXq24ZocAd0vWQfxABH1ydUfAMzk71PH3lMFsTbusy\nRSkrXdyHkcvPHpwEXJlsSQTr6E7RCLbtwXVuIsF6kD+NXlIjx50rCZX/gcpltAht\nRWsxrq3iKoUnnxWfCm4/Oh/20SgHoShbNEmNRcE2QIeDLdWC75tzq8IZE8p4/Yts\nUfHIC8htAgMBAAECggEAA7G6vCndT3kbmjYChFgwUlYR6EQG1gnIWO3fM+GSh3NM\nF+H8OWB3phIYKXIqlxaT5b6Aos5sQBvNoNRM6GTvP4MBDUGBG19S+scnHzi6trNK\nXwDuHKeXqqKEOtmvmaT8KZnpPfHK/lnCFMubXzBimJgJue7nTwc+4/5DA68Vseay\nCVsMLsamqTduCYPtUIDp0Qp95/qR9MQuzSluOVACgVOOBCahDP8QiSUvOI4tP/Mk\njhxv7a6FREbDPQUVZFgLxVRFwKWCz8POX8wKAr8qht85BmbhNri8ga/hdirjmEod\nowzv1wnva0agPo7EHFdvS8UYtd9DDU2B0yqzlqF1XwKBgQDXUi8qxwEeOh3z7hSu\n6wCo/bIzbmAxO43yFU4+KTZnE9dV9GRSfyeQFdSiPRLwqVzI660tArbpADu0q6fv\n/b7TYp1+mWFjtBwL0yKqqAQKveKzpHe6BwwrQjFPptT8q5c54eXDuOHIHDcRCH/w\nipz99LSIQKe/dZhmMxgnSI39PwKBgQDLybi34Sx9LJLOpDCwbOK0YjvqJBT0lrK+\nsRXXBy+8+wMqa/bgBDwZVt4po8vjV7gplvfpbclfzzxA+cJFQQzYZS+iJurDE1nL\n67V/9wMfdviLiBCAL4Sb5mZljdCIqku8Dy2On8gGSzw0vy+KVL8P0hVQr+uO8YhI\nWjTZ7wkTUwKBgDzOzNs70CkFKKhWuCid3VXcL5MuvKOque9/7NTJNr/tboaruhlC\nJ54dTCt1LAAjFDz5sbJgbd9nXXUsdQTlmBqCYw/5qPNLThBY1BV11Y5jCb7J17YF\nf35H9z0TVFr26oJCNW0MrVaiATsiN19rBeMCVGmWOMltIFjcXRna955pAoGAC6H3\nLl/nJzoNI0iSEvAUPNHCs8ndfFzB1UrMgVrCqdn2Q0yoaf8z4wpnYh8ce1y9gXpB\nqox+yz5MJTVclpFxB0U3Y90u13XaUV6iHKzf+8LRyz04G+kae7+6Jp/iwHpgGlsP\nca3DQEC5LhWfxBi0U1Xdq55vJti4u9CSZcJUVUsCgYBWOm2Ws0VruHWj4WGqylfV\nuURcTGoADEkkAohtILu9zzqh21Il0irSQVRLvxY36h4rR4w+RH9VjQi0Vg0lmmAT\nKKzQgjnyGdgHclULok7DUtZwjZ7TYOqFWp2O2al7As/uivowpvTlV2AAR7zNVcRV\n12gHMJ6qoYyS2u/dU5hR7Q==\n-----END PRIVATE KEY-----\n";

    struct Shared {
        requests: Vec<String>,
        token: (u16, String),
        revoke_status: u16,
        hold_token: bool,
        hold_revoke: bool,
    }

    #[derive(Clone)]
    struct TestProvider {
        issuer: String,
        jwks: String,
        shared: Arc<StdMutex<Shared>>,
        arrivals: Arc<AtomicUsize>,
    }

    impl TestProvider {
        fn requests(&self) -> Vec<String> {
            self.shared.lock().unwrap().requests.clone()
        }

        fn posts(&self, path: &str) -> Vec<String> {
            self.requests()
                .into_iter()
                .filter(|request| request.starts_with(&format!("POST {path}")))
                .collect()
        }

        fn set_token(&self, status: u16, body: String) {
            self.shared.lock().unwrap().token = (status, body);
        }

        fn set_revoke_status(&self, status: u16) {
            self.shared.lock().unwrap().revoke_status = status;
        }

        fn hold_token(&self, hold: bool) {
            self.shared.lock().unwrap().hold_token = hold;
        }

        async fn await_token_requests(&self, count: usize) {
            tokio::time::timeout(Duration::from_secs(5), async {
                while self.arrivals.load(Ordering::SeqCst) < count {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
        }
    }

    fn signing_key() -> EncodingKey {
        let der = pem_der(RSA_KEY);
        // This fixture has a 26-byte PKCS8 wrapper around the PKCS1 key.
        EncodingKey::from_rsa_der(&der[26..])
    }

    fn pem_der(pem: &str) -> Vec<u8> {
        let body: String = pem
            .lines()
            .filter(|line| !line.starts_with("-----"))
            .collect();
        base64::engine::general_purpose::STANDARD
            .decode(body)
            .unwrap()
    }

    fn id_token(
        issuer: &str,
        client_id: &str,
        subject: &str,
        nonce: Option<&str>,
        expires_at: u64,
    ) -> String {
        #[derive(Serialize)]
        struct Claims<'a> {
            iss: &'a str,
            aud: &'a str,
            sub: &'a str,
            exp: u64,
            email: Option<&'a str>,
            nonce: Option<&'a str>,
        }
        let header = Header {
            alg: Algorithm::RS256,
            kid: Some("test-key".into()),
            ..Default::default()
        };
        encode(
            &header,
            &Claims {
                iss: issuer,
                aud: client_id,
                sub: subject,
                exp: expires_at,
                email: Some("agent@example.com"),
                nonce,
            },
            &signing_key(),
        )
        .unwrap()
    }

    fn test_jwk() -> Jwk {
        let mut jwk = Jwk::from_encoding_key(&signing_key(), Algorithm::RS256).unwrap();
        jwk.common.key_id = Some("test-key".into());
        jwk
    }

    async fn serve(listener: tokio::net::TcpListener, provider: TestProvider) {
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            let provider = provider.clone();
            tokio::spawn(async move {
                let mut buffer = vec![0; 16384];
                let mut request = Vec::new();
                let header_end = loop {
                    let read = stream.read(&mut buffer).await.unwrap();
                    if read == 0 {
                        return;
                    }
                    request.extend_from_slice(&buffer[..read]);
                    if let Some(end) = request.windows(4).position(|window| window == b"\r\n\r\n") {
                        break end + 4;
                    }
                };
                let headers = String::from_utf8_lossy(&request[..header_end]).into_owned();
                let line = headers.lines().next().unwrap().to_owned();
                let path = line.split(' ').nth(1).unwrap().to_owned();
                let length: usize = headers
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse().unwrap())
                    })
                    .unwrap_or(0);
                while request.len() < header_end + length {
                    let read = stream.read(&mut buffer).await.unwrap();
                    if read == 0 {
                        break;
                    }
                    request.extend_from_slice(&buffer[..read]);
                }
                let body = String::from_utf8_lossy(&request[header_end..]).into_owned();
                let (status, response_body) = {
                    let mut shared = provider.shared.lock().unwrap();
                    shared.requests.push(format!("{line}\n{body}"));
                    match path.as_str() {
                        "/.well-known/openid-configuration" => (
                            200,
                            format!(
                                r#"{{"issuer":"{0}","revocation_endpoint":"{0}/revoke"}}"#,
                                provider.issuer
                            ),
                        ),
                        "/.well-known/jwks.json" => (200, provider.jwks.clone()),
                        "/api/accounts/oauth/token" => shared.token.clone(),
                        "/revoke" => (shared.revoke_status, String::new()),
                        _ => panic!("unexpected provider request path {path}"),
                    }
                };
                if path == "/api/accounts/oauth/token" {
                    provider.arrivals.fetch_add(1, Ordering::SeqCst);
                    while provider.shared.lock().unwrap().hold_token {
                        tokio::time::sleep(Duration::from_millis(5)).await;
                    }
                }
                if path == "/revoke" {
                    while provider.shared.lock().unwrap().hold_revoke {
                        tokio::time::sleep(Duration::from_millis(5)).await;
                    }
                }
                let reason = match status {
                    200 => "OK",
                    400 => "Bad Request",
                    429 => "Too Many Requests",
                    500 => "Internal Server Error",
                    _ => "Error",
                };
                let response = format!(
                    "HTTP/1.1 {status} {reason}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{response_body}",
                    response_body.len()
                );
                stream.write_all(response.as_bytes()).await.unwrap();
            });
        }
    }

    struct Fixture {
        service: Arc<ChatGptService>,
        provider: TestProvider,
        directory: tempfile::TempDir,
    }

    async fn fixture() -> Fixture {
        let directory = tempfile::tempdir().unwrap();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let issuer = format!("http://{}", listener.local_addr().unwrap());
        let provider = TestProvider {
            issuer: issuer.clone(),
            jwks: serde_json::to_string(&jsonwebtoken::jwk::JwkSet {
                keys: vec![test_jwk()],
            })
            .unwrap(),
            shared: Arc::new(StdMutex::new(Shared {
                requests: Vec::new(),
                token: (500, String::new()),
                revoke_status: 200,
                hold_token: false,
                hold_revoke: false,
            })),
            arrivals: Arc::new(AtomicUsize::new(0)),
        };
        tokio::spawn(serve(listener, provider.clone()));
        let service = ChatGptService::test_load(directory.path(), &issuer);
        Fixture {
            service,
            provider,
            directory,
        }
    }

    fn tokens(
        _fixture: &Fixture,
        client_id: &str,
        subject: &str,
        access: &str,
        refresh: &str,
        expires_at: u64,
    ) -> Tokens {
        Tokens {
            access_token: access.into(),
            refresh_token: refresh.into(),
            id_token: id_token(ISSUER, client_id, subject, None, expires_at + 3600),
            scopes: scopes(GRANTED),
            expires_at,
            earliest_refresh_at: 0,
            refresh_in_flight: false,
        }
    }

    fn account(
        connection: &str,
        client_id: &str,
        subject: &str,
        tokens: Option<Tokens>,
    ) -> Account {
        Account {
            connection_id: connection.into(),
            client_id: client_id.into(),
            subject: subject.into(),
            email: Some("agent@example.com".into()),
            session_id: Uuid::new_v4().to_string(),
            tokens,
            retired_refresh_tokens: Vec::new(),
        }
    }

    async fn insert(service: &ChatGptService, user: &str, account: Account) {
        let mut state = service.state.lock().await;
        let accounts = state.users.entry(user.to_owned()).or_default();
        if accounts.active.is_none() {
            accounts.active = Some(account.connection_id.clone());
        }
        accounts.accounts.push(account);
        let accounts = state.users.get(user).unwrap().clone();
        service.notify(user, &accounts);
        service.persist(&state).await.unwrap();
    }

    fn token_response(
        access: &str,
        refresh: &str,
        id_token: Option<String>,
        scope: Option<&str>,
        expires_in: u64,
    ) -> String {
        serde_json::json!({
            "access_token": access,
            "refresh_token": refresh,
            "id_token": id_token,
            "token_type": "Bearer",
            "expires_in": expires_in,
            "scope": scope,
        })
        .to_string()
    }

    async fn stored_account(service: &ChatGptService, user: &str, connection: &str) -> Account {
        let state = service.state.lock().await;
        state.users[user]
            .accounts
            .iter()
            .find(|account| account.connection_id == connection)
            .unwrap()
            .clone()
    }

    #[test]
    fn issued_client_resolves_dynamic_and_returning_registrations() {
        assert_eq!(issued_client(None, Some("client-1")).unwrap(), "client-1");
        assert_eq!(issued_client(Some("client-1"), None).unwrap(), "client-1");
        assert_eq!(
            issued_client(Some("client-1"), Some("client-1")).unwrap(),
            "client-1"
        );
        assert!(issued_client(Some("client-1"), Some("client-2")).is_err());
        assert!(issued_client(None, None).is_err());
        assert!(issued_client(None, Some(DYNAMIC_CLIENT)).is_err());
        assert!(issued_client(None, Some("")).is_err());
    }

    #[test]
    fn token_tuple_requires_scopes_and_inherits_them_on_refresh() {
        let response = || TokenResponse {
            access_token: "access".into(),
            refresh_token: "refresh".into(),
            id_token: Some("id".into()),
            token_type: "Bearer".into(),
            expires_in: 3600,
            scope: Some(GRANTED.into()),
            earliest_refresh_at: None,
        };
        let issued = token_tuple(response(), None, 1000).unwrap();
        assert_eq!(issued.expires_at, 4600);
        assert_eq!(issued.scopes, scopes(GRANTED));

        let mut refreshed = response();
        refreshed.scope = None;
        refreshed.id_token = None;
        let refreshed = token_tuple(refreshed, Some(&issued), 2000).unwrap();
        assert_eq!(refreshed.scopes, issued.scopes);
        assert_eq!(refreshed.id_token, issued.id_token);

        let mut missing = response();
        missing.scope = None;
        assert!(token_tuple(missing, None, 1000).is_err());

        let mut narrowed = response();
        narrowed.scope = Some("openid profile email".into());
        let error = token_tuple(narrowed, Some(&issued), 2000)
            .err()
            .unwrap()
            .to_string();
        assert!(error.contains("plan usage was not authorized"), "{error}");

        let mut bad_type = response();
        bad_type.token_type = "MAC".into();
        assert!(token_tuple(bad_type, None, 1000).is_err());

        let mut expired = response();
        expired.expires_in = 0;
        assert!(token_tuple(expired, None, 1000).is_err());
    }

    #[test]
    fn identity_verification_enforces_signature_issuer_audience_and_nonce() {
        let keys = &[test_jwk()];
        let expiry = now() + 3600;

        let token = id_token(ISSUER, "client-1", "subject-1", Some("nonce-1"), expiry);
        let identity = verify_identity(&token, keys, "client-1", Some("nonce-1")).unwrap();
        assert_eq!(identity.sub, "subject-1");
        assert_eq!(identity.email.as_deref(), Some("agent@example.com"));
        verify_identity(&token, keys, "client-1", None).unwrap();

        assert!(verify_identity(&token, keys, "client-1", Some("nonce-2")).is_err());
        assert!(verify_identity(&token, keys, "client-2", None).is_err());
        let wrong_issuer = id_token("https://example.com", "client-1", "subject-1", None, expiry);
        assert!(verify_identity(&wrong_issuer, keys, "client-1", None).is_err());
        let expired = id_token(ISSUER, "client-1", "subject-1", None, now() - 10);
        assert!(verify_identity(&expired, keys, "client-1", None).is_err());
        let mut unknown_key = test_jwk();
        unknown_key.common.key_id = Some("other-key".into());
        assert!(verify_identity(&token, &[unknown_key], "client-1", None).is_err());
        assert!(verify_identity(&token, &[], "client-1", None).is_err());
    }

    #[tokio::test]
    async fn load_recovers_refresh_cancellation_markers_and_protects_storage() {
        let directory = tempfile::tempdir().unwrap();
        let service = ChatGptService::load(directory.path()).unwrap();
        let stale = account(
            "connection-1",
            "client-1",
            "subject-1",
            Some(Tokens {
                access_token: "access".into(),
                refresh_token: "refresh".into(),
                id_token: "id".into(),
                scopes: scopes(GRANTED),
                expires_at: now() - 10,
                earliest_refresh_at: 0,
                refresh_in_flight: true,
            }),
        );
        let mut healthy = account(
            "connection-2",
            "client-1",
            "subject-1",
            Some(Tokens {
                access_token: "access".into(),
                refresh_token: "refresh".into(),
                id_token: "id".into(),
                scopes: scopes(GRANTED),
                expires_at: now() + 3600,
                earliest_refresh_at: 0,
                refresh_in_flight: false,
            }),
        );
        healthy.session_id = "healthy-session".into();
        insert(&service, "user-a", stale).await;
        insert(&service, "user-a", healthy).await;

        let reloaded = ChatGptService::load(directory.path()).unwrap();
        let state = reloaded.state.lock().await;
        let accounts = &state.users["user-a"];
        assert_eq!(accounts.accounts.len(), 2);
        assert_eq!(accounts.active, None);
        let recovered = &accounts.accounts[0];
        assert!(recovered.tokens.is_none());
        assert_eq!(recovered.retired_refresh_tokens, vec!["refresh"]);
        let healthy = &accounts.accounts[1];
        assert_eq!(healthy.connection_id, "connection-2");
        assert!(healthy.tokens.is_some());
        assert_eq!(healthy.session_id, "healthy-session");
        drop(state);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(directory.path().join("chatgpt-siwc.json"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600, "credential store must be owner-only");
        }

        let directory = tempfile::tempdir().unwrap();
        std::fs::write(
            directory.path().join("chatgpt-siwc.json"),
            br#"{"version":2,"hostId":"urn:uuid:25e57611-c2cb-4934-8142-fde1a3644a46","users":{}}"#,
        )
        .unwrap();
        assert!(ChatGptService::load(directory.path()).is_err());
        std::fs::write(
            directory.path().join("chatgpt-siwc.json"),
            br#"{"version":1,"hostId":"host","users":{}}"#,
        )
        .unwrap();
        assert!(ChatGptService::load(directory.path()).is_err());
    }

    #[tokio::test]
    async fn exchange_and_commit_round_trip_persists_and_notifies() {
        let fixture = fixture().await;
        let nonce = Uuid::new_v4().to_string();
        let user_credentials = fixture.service.for_user("user-a".into());
        let mut watch = user_credentials.connection();
        assert_eq!(*watch.borrow(), None);

        let code_id_token = id_token(ISSUER, "client-1", "subject-1", Some(&nonce), now() + 3600);
        fixture.provider.set_token(
            200,
            token_response(
                "access-1",
                "refresh-1",
                Some(code_id_token),
                Some(GRANTED),
                3600,
            ),
        );
        let grant = fixture
            .service
            .exchange(
                "user-a",
                None,
                "http://127.0.0.1:1/auth/callback",
                &nonce,
                "verifier",
                "code-1",
                Some("client-1"),
            )
            .await
            .unwrap();
        fixture.service.commit("user-a", grant).await.unwrap();

        watch.changed().await.unwrap();
        let session_id = watch.borrow().clone().unwrap();
        assert!(!session_id.is_empty());
        let account = fixture.service.state.lock().await.users["user-a"].accounts[0].clone();
        assert_eq!(account.session_id, session_id);
        assert_eq!(account.client_id, "client-1");
        assert_eq!(account.subject, "subject-1");
        assert_eq!(account.tokens.as_ref().unwrap().refresh_token, "refresh-1");

        let exchanges = fixture.provider.posts("/api/accounts/oauth/token");
        assert_eq!(exchanges.len(), 1);
        assert!(exchanges[0].contains("grant_type=authorization_code"));
        assert!(exchanges[0].contains("code_verifier=verifier"));
        assert!(exchanges[0].contains("client_id=client-1"));

        let reloaded =
            ChatGptService::test_load(fixture.directory.path(), &fixture.provider.issuer);
        assert_eq!(
            reloaded.state.lock().await.users["user-a"].accounts[0].subject,
            "subject-1"
        );
    }

    #[tokio::test]
    async fn commit_rejects_another_sprocket_account_and_revokes_the_grant() {
        let fixture = fixture().await;
        let grant = PendingGrant {
            user: "user-a".into(),
            expected_connection: None,
            expected_session: None,
            client_id: "client-1".into(),
            subject: "subject-1".into(),
            email: None,
            tokens: tokens(
                &fixture,
                "client-1",
                "subject-1",
                "access",
                "refresh-1",
                now() + 3600,
            ),
        };
        let error = fixture
            .service
            .commit("user-b", grant)
            .await
            .err()
            .unwrap()
            .to_string();
        assert!(error.contains("another Sprocket account"), "{error}");
        assert!(fixture.service.state.lock().await.users.is_empty());
        let revocations = fixture.provider.posts("/revoke");
        assert_eq!(
            revocations.len(),
            1,
            "mismatched commit must revoke the grant"
        );
        assert!(revocations[0].contains("token=refresh-1"));
    }

    #[tokio::test]
    async fn access_returns_fresh_token_without_persisting_and_converts_units() {
        let fixture = fixture().await;
        let mut account = account(
            "connection-1",
            "client-1",
            "subject-1",
            Some(tokens(
                &fixture,
                "client-1",
                "subject-1",
                "access-1",
                "refresh-1",
                now() + 3600,
            )),
        );
        account.session_id = "session-1".into();
        insert(&fixture.service, "user-a", account).await;
        let before = std::fs::read(fixture.directory.path().join("chatgpt-siwc.json")).unwrap();

        let credentials = fixture.service.for_user("user-a".into());
        let access = credentials.credential().await.unwrap();
        assert_eq!(access.access_token, "access-1");
        assert_eq!(access.connection_id, "session-1");
        assert_eq!(access.expires_at % 1000, 0, "trait expiry is milliseconds");
        assert!(access.expires_at > crate::now_ms());
        assert_eq!(
            std::fs::read(fixture.directory.path().join("chatgpt-siwc.json")).unwrap(),
            before
        );
        assert!(
            fixture
                .provider
                .posts("/api/accounts/oauth/token")
                .is_empty()
        );
    }

    #[tokio::test]
    async fn access_refreshes_expired_tokens_and_persists_the_new_tuple() {
        let fixture = fixture().await;
        let mut account = account(
            "connection-1",
            "client-1",
            "subject-1",
            Some(tokens(
                &fixture,
                "client-1",
                "subject-1",
                "access-old",
                "refresh-old",
                now() - 10,
            )),
        );
        account.session_id = "session-1".into();
        insert(&fixture.service, "user-a", account).await;

        let refreshed_id = id_token(ISSUER, "client-1", "subject-1", None, now() + 7200);
        fixture.provider.set_token(
            200,
            token_response("access-new", "refresh-new", Some(refreshed_id), None, 3600),
        );
        let access = fixture
            .service
            .for_user("user-a".into())
            .credential()
            .await
            .unwrap();
        assert_eq!(access.access_token, "access-new");
        assert_eq!(access.connection_id, "session-1");

        let stored = stored_account(&fixture.service, "user-a", "connection-1").await;
        let stored_tokens = stored.tokens.unwrap();
        assert_eq!(stored_tokens.refresh_token, "refresh-new");
        assert!(!stored_tokens.refresh_in_flight);
        assert!(stored_tokens.expires_at > now());
        let reloaded =
            ChatGptService::test_load(fixture.directory.path(), &fixture.provider.issuer);
        assert_eq!(
            reloaded.state.lock().await.users["user-a"].accounts[0]
                .tokens
                .as_ref()
                .unwrap()
                .access_token,
            "access-new"
        );

        let refreshes = fixture.provider.posts("/api/accounts/oauth/token");
        assert_eq!(refreshes.len(), 1);
        assert!(refreshes[0].contains("grant_type=refresh_token"));
        assert!(refreshes[0].contains("refresh_token=refresh-old"));
    }

    #[tokio::test]
    async fn refresh_server_error_keeps_the_old_tuple_for_retry() {
        let fixture = fixture().await;
        insert(
            &fixture.service,
            "user-a",
            account(
                "connection-1",
                "client-1",
                "subject-1",
                Some(tokens(
                    &fixture,
                    "client-1",
                    "subject-1",
                    "access-old",
                    "refresh-old",
                    now() - 10,
                )),
            ),
        )
        .await;
        fixture.provider.set_token(500, String::new());
        let error = fixture
            .service
            .for_user("user-a".into())
            .credential()
            .await
            .err()
            .unwrap()
            .to_string();
        assert!(error.contains("temporarily unavailable"), "{error}");
        let stored = stored_account(&fixture.service, "user-a", "connection-1").await;
        let tokens = stored.tokens.unwrap();
        assert_eq!(tokens.access_token, "access-old");
        assert!(!tokens.refresh_in_flight);
    }

    #[tokio::test]
    async fn refresh_terminal_error_disconnects_and_rotates_the_session() {
        let fixture = fixture().await;
        let user_credentials = fixture.service.for_user("user-a".into());
        let mut watch = user_credentials.connection();
        let original = account(
            "connection-1",
            "client-1",
            "subject-1",
            Some(tokens(
                &fixture,
                "client-1",
                "subject-1",
                "access-old",
                "refresh-old",
                now() - 10,
            )),
        );
        let original_session = original.session_id.clone();
        insert(&fixture.service, "user-a", original).await;
        watch.borrow_and_update();
        fixture.provider.set_token(
            400,
            serde_json::json!({"error": "invalid_grant"}).to_string(),
        );

        let error = user_credentials
            .credential()
            .await
            .err()
            .unwrap()
            .to_string();
        assert!(error.contains("Reconnect"), "{error}");
        let stored = stored_account(&fixture.service, "user-a", "connection-1").await;
        assert!(stored.tokens.is_none());
        assert_ne!(stored.session_id, original_session);
        assert_eq!(*watch.borrow_and_update(), None);
    }

    #[tokio::test]
    async fn refresh_rejects_a_different_returned_identity() {
        let fixture = fixture().await;
        insert(
            &fixture.service,
            "user-a",
            account(
                "connection-1",
                "client-1",
                "subject-1",
                Some(tokens(
                    &fixture,
                    "client-1",
                    "subject-1",
                    "access-old",
                    "refresh-old",
                    now() - 10,
                )),
            ),
        )
        .await;
        let other_id = id_token(ISSUER, "client-1", "subject-2", None, now() + 3600);
        fixture.provider.set_token(
            200,
            token_response(
                "access-new",
                "refresh-new",
                Some(other_id),
                Some(GRANTED),
                3600,
            ),
        );
        let error = fixture
            .service
            .for_user("user-a".into())
            .credential()
            .await
            .err()
            .unwrap()
            .to_string();
        assert!(error.contains("another identity"), "{error}");
        let stored = stored_account(&fixture.service, "user-a", "connection-1").await;
        assert!(
            stored.tokens.is_none(),
            "identity mismatch must not retain the old grant"
        );
    }

    #[tokio::test]
    async fn exchange_rejects_a_different_subject_for_a_returning_account() {
        let fixture = fixture().await;
        let nonce = Uuid::new_v4().to_string();
        insert(
            &fixture.service,
            "user-a",
            account("connection-1", "client-1", "subject-1", None),
        )
        .await;
        let other_id = id_token(ISSUER, "client-1", "subject-2", Some(&nonce), now() + 3600);
        fixture.provider.set_token(
            200,
            token_response("access-1", "refresh-1", Some(other_id), Some(GRANTED), 3600),
        );
        let error = fixture
            .service
            .exchange(
                "user-a",
                Some("connection-1"),
                "http://127.0.0.1:1/auth/callback",
                &nonce,
                "verifier",
                "code-1",
                Some("client-1"),
            )
            .await
            .err()
            .unwrap()
            .to_string();
        assert!(error.contains("different account"), "{error}");
        assert!(
            !fixture.provider.posts("/revoke").is_empty(),
            "failed exchange must revoke the issued grant"
        );
    }

    #[tokio::test]
    async fn sprocket_accounts_have_separate_state_and_watch_sessions() {
        let fixture = fixture().await;
        let credentials_a = fixture.service.for_user("user-a".into());
        let credentials_b = fixture.service.for_user("user-b".into());
        let watch_a = credentials_a.connection();
        let watch_b = credentials_b.connection();
        assert_eq!(*watch_a.borrow(), None);
        assert_eq!(*watch_b.borrow(), None);

        insert(
            &fixture.service,
            "user-a",
            account(
                "connection-1",
                "client-1",
                "subject-1",
                Some(tokens(
                    &fixture,
                    "client-1",
                    "subject-1",
                    "access-a",
                    "refresh-a",
                    now() + 3600,
                )),
            ),
        )
        .await;
        insert(
            &fixture.service,
            "user-b",
            account(
                "connection-2",
                "client-1",
                "subject-2",
                Some(tokens(
                    &fixture,
                    "client-1",
                    "subject-2",
                    "access-b",
                    "refresh-b",
                    now() + 3600,
                )),
            ),
        )
        .await;

        let session_a = watch_a.borrow().clone().unwrap();
        let session_b = watch_b.borrow().clone().unwrap();
        assert_ne!(session_a, session_b);
        assert_eq!(
            credentials_a.credential().await.unwrap().connection_id,
            session_a
        );
        assert_eq!(
            credentials_b.credential().await.unwrap().connection_id,
            session_b
        );

        fixture
            .service
            .disconnect("user-a", "connection-1")
            .await
            .unwrap();
        assert_eq!(*watch_a.borrow(), None);
        assert_eq!(watch_b.borrow().as_deref(), Some(session_b.as_str()));
        let error = credentials_a.credential().await.err().unwrap().to_string();
        assert!(error.contains("Connect ChatGPT locally"), "{error}");
        assert_eq!(
            credentials_b.credential().await.unwrap().access_token,
            "access-b"
        );
    }

    #[tokio::test]
    async fn select_rotates_the_watch_session_and_persists_it() {
        let fixture = fixture().await;
        let mut first = account(
            "connection-1",
            "client-1",
            "subject-1",
            Some(tokens(
                &fixture,
                "client-1",
                "subject-1",
                "access-1",
                "refresh-1",
                now() + 3600,
            )),
        );
        first.session_id = "first-session".into();
        let mut second = account(
            "connection-2",
            "client-1",
            "subject-2",
            Some(tokens(
                &fixture,
                "client-1",
                "subject-2",
                "access-2",
                "refresh-2",
                now() + 3600,
            )),
        );
        second.session_id = "second-session".into();
        insert(&fixture.service, "user-a", first).await;
        insert(&fixture.service, "user-a", second).await;
        let credentials = fixture.service.for_user("user-a".into());
        let mut watch = credentials.connection();
        assert_eq!(watch.borrow_and_update().as_deref(), Some("first-session"));

        fixture
            .service
            .select("user-a", "connection-2")
            .await
            .unwrap();
        watch.changed().await.unwrap();
        let session_id = watch.borrow().clone().unwrap();
        assert_ne!(
            session_id, "second-session",
            "selection rotates the session id"
        );
        assert_ne!(session_id, "first-session");
        assert_eq!(
            credentials.credential().await.unwrap().connection_id,
            session_id
        );

        let reloaded =
            ChatGptService::test_load(fixture.directory.path(), &fixture.provider.issuer);
        let state = reloaded.state.lock().await;
        assert_eq!(
            state.users["user-a"].active.as_deref(),
            Some("connection-2")
        );
        assert_eq!(
            session(&state.users["user-a"]).as_deref(),
            Some(session_id.as_str())
        );
    }

    #[tokio::test]
    async fn load_forgets_legacy_signed_out_accounts_and_preserves_other_users() {
        let fixture = fixture().await;
        insert(
            &fixture.service,
            "user-a",
            account("signed-out", "client-old", "subject-old", None),
        )
        .await;
        insert(
            &fixture.service,
            "user-b",
            account(
                "connected",
                "client-current",
                "subject-current",
                Some(tokens(
                    &fixture,
                    "client-current",
                    "subject-current",
                    "access-current",
                    "refresh-current",
                    now() + 3600,
                )),
            ),
        )
        .await;
        let before = fixture.service.state.lock().await.clone();
        let reloaded =
            ChatGptService::test_load(fixture.directory.path(), &fixture.provider.issuer);
        let state = reloaded.state.lock().await;
        assert_eq!(state.host_id, before.host_id);
        assert_eq!(state.users.len(), 1);
        assert_eq!(
            serde_json::to_value(&state.users["user-b"]).unwrap(),
            serde_json::to_value(&before.users["user-b"]).unwrap()
        );
        let disk: Store = serde_json::from_slice(
            &std::fs::read(fixture.directory.path().join("chatgpt-siwc.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(disk.users.len(), 1);
        assert_eq!(disk.host_id, before.host_id);
        assert_eq!(
            serde_json::to_value(&disk.users["user-b"]).unwrap(),
            serde_json::to_value(&before.users["user-b"]).unwrap()
        );
    }

    #[tokio::test]
    async fn status_revokes_retained_tokens_before_forgetting_legacy_accounts() {
        for revoke_status in [200, 500] {
            let fixture = fixture().await;
            fixture.provider.set_revoke_status(revoke_status);
            let mut signed_out = account("signed-out", "client-old", "subject-old", None);
            signed_out.retired_refresh_tokens = vec!["refresh-retired".into()];
            insert(&fixture.service, "user-a", signed_out).await;

            let reloaded =
                ChatGptService::test_load(fixture.directory.path(), &fixture.provider.issuer);
            assert_eq!(
                stored_account(&reloaded, "user-a", "signed-out")
                    .await
                    .retired_refresh_tokens,
                vec!["refresh-retired"]
            );
            let status = reloaded.status("user-a").await.unwrap();
            assert!(status.accounts.is_empty());
            assert_eq!(status.active_connection_id, None);
            assert_eq!(status.error.is_some(), revoke_status != 200);
            let posts = fixture.provider.posts("/revoke");
            assert!(posts[0].contains("token=refresh-retired"));
            assert!(posts[0].contains("client_id=client-old"));
            let restarted =
                ChatGptService::test_load(fixture.directory.path(), &fixture.provider.issuer);
            assert!(restarted.state.lock().await.users.is_empty());
        }
    }

    #[tokio::test]
    async fn cleanup_warning_preserves_healthy_account_status() {
        let fixture = fixture().await;
        fixture.provider.set_revoke_status(500);
        insert(
            &fixture.service,
            "user-a",
            account(
                "healthy",
                "client-current",
                "subject-current",
                Some(tokens(
                    &fixture,
                    "client-current",
                    "subject-current",
                    "access-current",
                    "refresh-current",
                    now() + 3600,
                )),
            ),
        )
        .await;
        let mut signed_out = account("signed-out", "client-old", "subject-old", None);
        signed_out.retired_refresh_tokens = vec!["refresh-retired".into()];
        insert(&fixture.service, "user-a", signed_out).await;
        let status = fixture.service.status("user-a").await.unwrap();
        assert_eq!(status.accounts.len(), 1);
        assert_eq!(status.active_connection_id.as_deref(), Some("healthy"));
        assert!(status.accounts[0].connected);
        assert!(status.error.unwrap().contains("could not be confirmed"));
    }

    #[tokio::test]
    async fn sign_out_keeps_interrupted_revocations_durable_and_hidden() {
        for revoke_status in [200, 500] {
            let fixture = fixture().await;
            fixture.provider.set_revoke_status(revoke_status);
            insert(
                &fixture.service,
                "user-a",
                account(
                    "connection-1",
                    "client-1",
                    "subject-1",
                    Some(tokens(
                        &fixture,
                        "client-1",
                        "subject-1",
                        "access-1",
                        "refresh-1",
                        now() + 3600,
                    )),
                ),
            )
            .await;
            let watch = fixture.service.for_user("user-a".into()).connection();
            fixture.provider.shared.lock().unwrap().hold_revoke = true;
            let sign_out = tokio::spawn({
                let service = Arc::clone(&fixture.service);
                async move { service.disconnect("user-a", "connection-1").await }
            });
            tokio::time::timeout(Duration::from_secs(5), async {
                while fixture.provider.posts("/revoke").is_empty() {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            assert_eq!(*watch.borrow(), None);
            let restarted =
                ChatGptService::test_load(fixture.directory.path(), &fixture.provider.issuer);
            let marker = stored_account(&restarted, "user-a", "connection-1").await;
            assert!(marker.tokens.is_none());
            assert_eq!(marker.subject, "signed-out");
            assert_eq!(marker.email, None);
            assert_eq!(marker.retired_refresh_tokens, vec!["refresh-1"]);
            assert!(restarted.select("user-a", "connection-1").await.is_err());
            let interrupted =
                std::fs::read(fixture.directory.path().join("chatgpt-siwc.json")).unwrap();
            fixture.provider.shared.lock().unwrap().hold_revoke = false;
            sign_out.await.unwrap().unwrap();
            crate::profile::write_private_file(
                &fixture.directory.path().join("chatgpt-siwc.json"),
                &interrupted,
            )
            .unwrap();
            let restarted =
                ChatGptService::test_load(fixture.directory.path(), &fixture.provider.issuer);
            let status = restarted.status("user-a").await.unwrap();
            assert!(status.accounts.is_empty());
            assert_eq!(status.active_connection_id, None);
            assert_eq!(status.error.is_some(), revoke_status != 200);
            assert!(fixture.provider.posts("/revoke").len() >= 2);
            let reloaded =
                ChatGptService::test_load(fixture.directory.path(), &fixture.provider.issuer);
            assert!(reloaded.state.lock().await.users.is_empty());
        }
    }

    #[tokio::test]
    async fn sign_out_revokes_when_account_removal_cannot_be_saved() {
        for revoke_status in [200, 500] {
            let fixture = fixture().await;
            fixture.provider.set_revoke_status(revoke_status);
            insert(
                &fixture.service,
                "user-a",
                account(
                    "connection-1",
                    "client-1",
                    "subject-1",
                    Some(tokens(
                        &fixture,
                        "client-1",
                        "subject-1",
                        "access-1",
                        "refresh-1",
                        now() + 3600,
                    )),
                ),
            )
            .await;
            let watch = fixture.service.for_user("user-a".into()).connection();
            *fixture.service.persist_failure_after.lock().unwrap() = Some(1);
            let error = fixture
                .service
                .disconnect("user-a", "connection-1")
                .await
                .unwrap_err()
                .to_string();
            assert!(error.contains("Could not save local ChatGPT credentials"));
            assert_eq!(
                error.contains("could not be confirmed"),
                revoke_status != 200
            );
            assert_eq!(*watch.borrow(), None);
            let revocations = fixture.provider.posts("/revoke");
            assert!(revocations[0].contains("token=refresh-1"));
            let status = fixture.service.status("user-a").await.unwrap();
            assert!(status.accounts.is_empty());
            let reloaded =
                ChatGptService::test_load(fixture.directory.path(), &fixture.provider.issuer);
            assert!(reloaded.state.lock().await.users.is_empty());
        }
    }

    #[tokio::test]
    async fn credential_refresh_failure_preserves_legacy_revocation_guidance() {
        let fixture = fixture().await;
        fixture.provider.set_revoke_status(500);
        insert(
            &fixture.service,
            "user-a",
            account(
                "healthy",
                "client-current",
                "subject-current",
                Some(tokens(
                    &fixture,
                    "client-current",
                    "subject-current",
                    "access-current",
                    "refresh-current",
                    now() - 10,
                )),
            ),
        )
        .await;
        let mut signed_out = account("signed-out", "client-old", "subject-old", None);
        signed_out.retired_refresh_tokens = vec!["refresh-retired".into()];
        insert(&fixture.service, "user-a", signed_out).await;
        let status = fixture.service.status("user-a").await.unwrap();
        assert_eq!(status.accounts.len(), 1);
        assert!(status.accounts[0].connected);
        let error = status.error.unwrap();
        assert!(error.contains("ChatGPT refresh is temporarily unavailable"));
        assert!(error.contains("OpenAI revocation could not be confirmed"));
        assert!(error.contains("Remove the agent in ChatGPT settings"));
    }

    #[tokio::test]
    async fn legacy_revocation_does_not_block_other_users_credentials() {
        let fixture = fixture().await;
        let mut signed_out = account("signed-out", "client-old", "subject-old", None);
        signed_out.retired_refresh_tokens = vec!["refresh-retired".into()];
        insert(&fixture.service, "user-a", signed_out).await;
        insert(
            &fixture.service,
            "user-b",
            account(
                "healthy",
                "client-current",
                "subject-current",
                Some(tokens(
                    &fixture,
                    "client-current",
                    "subject-current",
                    "access-current",
                    "refresh-current",
                    now() + 3600,
                )),
            ),
        )
        .await;
        fixture.provider.shared.lock().unwrap().hold_revoke = true;
        let cleanup = tokio::spawn({
            let service = Arc::clone(&fixture.service);
            async move { service.status("user-a").await }
        });
        tokio::time::timeout(Duration::from_secs(5), async {
            while fixture.provider.posts("/revoke").is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let access = tokio::time::timeout(Duration::from_secs(1), fixture.service.access("user-b"))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(access.access_token, "access-current");
        fixture.provider.shared.lock().unwrap().hold_revoke = false;
        assert!(cleanup.await.unwrap().unwrap().accounts.is_empty());
    }

    #[tokio::test]
    async fn disconnect_preserves_other_accounts_without_selecting_one() {
        let fixture = fixture().await;
        for connection in ["connection-1", "connection-2", "connection-3"] {
            insert(
                &fixture.service,
                "user-a",
                account(
                    connection,
                    connection,
                    connection,
                    Some(tokens(
                        &fixture,
                        connection,
                        connection,
                        connection,
                        connection,
                        now() + 3600,
                    )),
                ),
            )
            .await;
        }
        let credentials = fixture.service.for_user("user-a".into());
        let watch = credentials.connection();
        let session = watch.borrow().clone();
        fixture
            .service
            .disconnect("user-a", "connection-2")
            .await
            .unwrap();
        assert_eq!(*watch.borrow(), session);
        let before = fixture.service.state.lock().await.users["user-a"].clone();
        assert_eq!(before.accounts.len(), 2);
        assert_eq!(before.active.as_deref(), Some("connection-1"));

        fixture
            .service
            .disconnect("user-a", "connection-1")
            .await
            .unwrap();
        assert_eq!(*watch.borrow(), None);
        let reloaded =
            ChatGptService::test_load(fixture.directory.path(), &fixture.provider.issuer);
        let state = reloaded.state.lock().await;
        let accounts = &state.users["user-a"];
        assert_eq!(accounts.active, None);
        assert_eq!(accounts.accounts.len(), 1);
        assert_eq!(
            serde_json::to_value(&accounts.accounts[0]).unwrap(),
            serde_json::to_value(&before.accounts[1]).unwrap()
        );
        let status = fixture.service.status("user-a").await.unwrap();
        assert_eq!(status.accounts.len(), 1);
        assert_eq!(status.accounts[0].connection_id, "connection-3");
    }

    #[tokio::test]
    async fn disconnect_revokes_and_forgets_the_account_across_restart() {
        let fixture = fixture().await;
        insert(
            &fixture.service,
            "user-a",
            account(
                "connection-1",
                "client-1",
                "subject-1",
                Some(tokens(
                    &fixture,
                    "client-1",
                    "subject-1",
                    "access-1",
                    "refresh-1",
                    now() + 3600,
                )),
            ),
        )
        .await;
        let credentials = fixture.service.for_user("user-a".into());
        let mut watch = credentials.connection();
        watch.borrow_and_update();

        let warning = fixture
            .service
            .disconnect("user-a", "connection-1")
            .await
            .unwrap();
        assert_eq!(warning, None);
        assert_eq!(*watch.borrow(), None);
        assert!(fixture.service.state.lock().await.users.is_empty());
        let status = fixture.service.status("user-a").await.unwrap();
        assert!(status.accounts.is_empty());
        assert_eq!(status.active_connection_id, None);

        let revocations = fixture.provider.posts("/revoke");
        assert_eq!(revocations.len(), 1, "disconnect must attempt revocation");
        assert!(revocations[0].contains("token=refresh-1"));
        assert!(revocations[0].contains("client_id=client-1"));
        let reloaded =
            ChatGptService::test_load(fixture.directory.path(), &fixture.provider.issuer);
        assert!(reloaded.state.lock().await.users.is_empty());
    }

    #[tokio::test]
    async fn disconnect_warns_when_revocation_is_not_confirmed() {
        let fixture = fixture().await;
        fixture.provider.set_revoke_status(500);
        insert(
            &fixture.service,
            "user-a",
            account(
                "connection-1",
                "client-1",
                "subject-1",
                Some(tokens(
                    &fixture,
                    "client-1",
                    "subject-1",
                    "access-1",
                    "refresh-1",
                    now() + 3600,
                )),
            ),
        )
        .await;
        let warning = fixture
            .service
            .disconnect("user-a", "connection-1")
            .await
            .unwrap()
            .unwrap();
        assert!(warning.contains("could not be confirmed"), "{warning}");
        let reloaded =
            ChatGptService::test_load(fixture.directory.path(), &fixture.provider.issuer);
        assert!(reloaded.state.lock().await.users.is_empty());
    }

    #[tokio::test]
    async fn authorization_builds_pkce_urls_for_dynamic_and_returning_clients() {
        let fixture = fixture().await;
        let nonce = Uuid::new_v4().to_string();
        let url = fixture
            .service
            .authorization(
                "user-a",
                None,
                "http://127.0.0.1:1/auth/callback",
                "state-1",
                &nonce,
                "verifier-1",
            )
            .await
            .unwrap();
        let url = url::Url::parse(&url).unwrap();
        let pairs: HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(pairs["client_id"], DYNAMIC_CLIENT);
        assert_eq!(pairs["agent_name_hint"], "Sprocket");
        assert_eq!(pairs["state"], "state-1");
        assert_eq!(pairs["nonce"], nonce);
        assert_eq!(pairs["scope"], SCOPES);
        assert_eq!(pairs["redirect_uri"], "http://127.0.0.1:1/auth/callback");
        let expected =
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(b"verifier-1"));
        assert_eq!(pairs["code_challenge"], expected);
        assert_eq!(pairs["code_challenge_method"], "S256");
        assert!(pairs["ext_agent_host_id"].starts_with("urn:uuid:"));

        insert(
            &fixture.service,
            "user-a",
            account("connection-1", "client-1", "subject-1", None),
        )
        .await;
        let nonce = Uuid::new_v4().to_string();
        let url = fixture
            .service
            .authorization(
                "user-a",
                Some("connection-1"),
                "http://127.0.0.1:1/auth/callback",
                "state-2",
                &nonce,
                "verifier-2",
            )
            .await
            .unwrap();
        let pairs: HashMap<_, _> = url::Url::parse(&url)
            .unwrap()
            .query_pairs()
            .into_owned()
            .collect();
        assert_eq!(pairs["client_id"], "client-1");
        assert!(!pairs.contains_key("agent_name_hint"));
    }

    #[tokio::test]
    async fn status_reports_a_connected_account_with_fresh_credentials() {
        let fixture = fixture().await;
        insert(
            &fixture.service,
            "user-a",
            account(
                "connection-1",
                "client-1",
                "subject-1",
                Some(tokens(
                    &fixture,
                    "client-1",
                    "subject-1",
                    "access",
                    "refresh",
                    now() + 3600,
                )),
            ),
        )
        .await;
        let status = fixture.service.status("user-a").await.unwrap();
        assert_eq!(
            serde_json::to_value(status).unwrap(),
            serde_json::json!({
                "accounts": [{
                    "connectionId": "connection-1",
                    "label": "agent@example.com",
                    "connected": true
                }],
                "activeConnectionId": "connection-1"
            })
        );
    }

    #[tokio::test]
    async fn status_refreshes_expired_credentials() {
        let fixture = fixture().await;
        insert(
            &fixture.service,
            "user-a",
            account(
                "connection-1",
                "client-1",
                "subject-1",
                Some(tokens(
                    &fixture,
                    "client-1",
                    "subject-1",
                    "access-old",
                    "refresh-old",
                    now() - 10,
                )),
            ),
        )
        .await;
        fixture.provider.set_token(
            200,
            token_response("access-new", "refresh-new", None, None, 3600),
        );
        let status = fixture.service.status("user-a").await.unwrap();
        assert_eq!(status.active_connection_id.as_deref(), Some("connection-1"));
        assert!(status.accounts[0].connected);
        assert_eq!(status.error, None);
        let refreshed = stored_account(&fixture.service, "user-a", "connection-1")
            .await
            .tokens
            .unwrap();
        assert_eq!(refreshed.access_token, "access-new");
        assert_eq!(refreshed.refresh_token, "refresh-new");
    }

    #[tokio::test]
    async fn status_reports_revoked_credentials_as_disconnected() {
        let fixture = fixture().await;
        insert(
            &fixture.service,
            "user-a",
            account(
                "connection-1",
                "client-1",
                "subject-1",
                Some(tokens(
                    &fixture,
                    "client-1",
                    "subject-1",
                    "access-old",
                    "refresh-old",
                    now() - 10,
                )),
            ),
        )
        .await;
        fixture.provider.set_token(
            400,
            serde_json::json!({"error": "invalid_grant"}).to_string(),
        );
        let status = fixture.service.status("user-a").await.unwrap();
        assert!(status.accounts.is_empty());
        assert!(status.error.unwrap().contains("session expired"));
        assert!(
            stored_account(&fixture.service, "user-a", "connection-1")
                .await
                .tokens
                .is_none()
        );
    }

    #[tokio::test]
    async fn unavailable_storage_preserves_the_file_and_reports_repair_guidance() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("chatgpt-siwc.json");
        std::fs::write(&path, b"unreadable credential state").unwrap();
        let service = ChatGptService::load_or_unavailable(directory.path()).unwrap();
        assert!(!service.available());
        let status = service.status("user-a").await.unwrap();
        assert!(status.error.unwrap().contains("repair or restore"));
        let nonce = Uuid::new_v4().to_string();
        assert!(
            service
                .authorization("user-a", None, "callback", "state", &nonce, "verifier")
                .await
                .is_err()
        );
        assert_eq!(std::fs::read(path).unwrap(), b"unreadable credential state");
    }

    #[tokio::test]
    async fn reconnect_tracks_and_revokes_replaced_grants() {
        let fixture = fixture().await;
        insert(
            &fixture.service,
            "user-a",
            account(
                "connection-1",
                "client-1",
                "subject-1",
                Some(tokens(
                    &fixture,
                    "client-1",
                    "subject-1",
                    "access-old",
                    "refresh-old",
                    now() + 3600,
                )),
            ),
        )
        .await;
        let old = stored_account(&fixture.service, "user-a", "connection-1").await;
        fixture.provider.set_revoke_status(400);
        let grant = PendingGrant {
            user: "user-a".into(),
            expected_connection: Some("connection-1".into()),
            expected_session: Some(old.session_id),
            client_id: "client-1".into(),
            subject: "subject-1".into(),
            email: None,
            tokens: tokens(
                &fixture,
                "client-1",
                "subject-1",
                "access-new",
                "refresh-new",
                now() + 3600,
            ),
        };
        fixture.service.commit("user-a", grant).await.unwrap();
        assert!(fixture.provider.posts("/revoke")[0].contains("token=refresh-old"));
        assert_eq!(
            stored_account(&fixture.service, "user-a", "connection-1")
                .await
                .retired_refresh_tokens,
            vec!["refresh-old"]
        );
        fixture.provider.set_revoke_status(200);
        fixture
            .service
            .disconnect("user-a", "connection-1")
            .await
            .unwrap();
        let posts = fixture.provider.posts("/revoke");
        assert!(posts[1].contains("token=refresh-old"));
        assert!(posts[2].contains("token=refresh-new"));
    }

    #[tokio::test]
    async fn connection_failure_preserves_refresh_credentials_for_retry() {
        let mut fixture = fixture().await;
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let endpoint = format!(
            "http://{}/api/accounts/oauth/token",
            listener.local_addr().unwrap()
        );
        drop(listener);
        Arc::get_mut(&mut fixture.service).unwrap().token_endpoint = endpoint;
        insert(
            &fixture.service,
            "user-a",
            account(
                "connection-1",
                "client-1",
                "subject-1",
                Some(tokens(
                    &fixture,
                    "client-1",
                    "subject-1",
                    "access-old",
                    "refresh-old",
                    now() - 10,
                )),
            ),
        )
        .await;
        assert!(
            fixture
                .service
                .access("user-a")
                .await
                .err()
                .unwrap()
                .to_string()
                .contains("connect")
        );
        let stored = stored_account(&fixture.service, "user-a", "connection-1").await;
        assert_eq!(stored.tokens.as_ref().unwrap().refresh_token, "refresh-old");
        assert!(!stored.tokens.unwrap().refresh_in_flight);
    }

    #[tokio::test]
    async fn rotated_credentials_retry_persistence_before_use() {
        let fixture = fixture().await;
        insert(
            &fixture.service,
            "user-a",
            account(
                "connection-1",
                "client-1",
                "subject-1",
                Some(tokens(
                    &fixture,
                    "client-1",
                    "subject-1",
                    "access-old",
                    "refresh-old",
                    now() - 10,
                )),
            ),
        )
        .await;
        fixture.provider.set_token(
            200,
            token_response("access-new", "refresh-new", None, None, 3600),
        );
        fixture.provider.hold_token(true);
        let credentials = fixture.service.for_user("user-a".into());
        let refresh = tokio::spawn({
            let credentials = Arc::clone(&credentials);
            async move { credentials.credential().await }
        });
        fixture.provider.await_token_requests(1).await;
        let path = fixture.directory.path().join("chatgpt-siwc.json");
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        fixture.provider.hold_token(false);
        assert!(refresh.await.unwrap().is_err());
        assert!(credentials.credential().await.is_err());
        std::fs::remove_dir(&path).unwrap();
        assert_eq!(
            credentials.credential().await.unwrap().access_token,
            "access-new"
        );
        let reloaded =
            ChatGptService::test_load(fixture.directory.path(), &fixture.provider.issuer);
        assert_eq!(
            stored_account(&reloaded, "user-a", "connection-1")
                .await
                .tokens
                .unwrap()
                .refresh_token,
            "refresh-new"
        );
        assert_eq!(fixture.provider.posts("/api/accounts/oauth/token").len(), 1);
    }

    #[tokio::test]
    async fn concurrent_refresh_requests_serialize_on_the_state_lock() {
        let fixture = fixture().await;
        insert(
            &fixture.service,
            "user-a",
            account(
                "connection-1",
                "client-1",
                "subject-1",
                Some(tokens(
                    &fixture,
                    "client-1",
                    "subject-1",
                    "access-old",
                    "refresh-old",
                    now() - 10,
                )),
            ),
        )
        .await;
        fixture.provider.set_token(
            200,
            token_response("access-new", "refresh-new", None, None, 3600),
        );
        fixture.provider.hold_token(true);

        let credentials = fixture.service.for_user("user-a".into());
        let first = tokio::spawn({
            let credentials = Arc::clone(&credentials);
            async move { credentials.credential().await }
        });
        fixture.provider.await_token_requests(1).await;
        let second = tokio::spawn({
            let credentials = Arc::clone(&credentials);
            async move { credentials.credential().await }
        });
        tokio::task::yield_now().await;
        fixture.provider.hold_token(false);

        let (first, second) = tokio::join!(first, second);
        assert_eq!(first.unwrap().unwrap().access_token, "access-new");
        assert_eq!(second.unwrap().unwrap().access_token, "access-new");
        assert_eq!(
            fixture.provider.posts("/api/accounts/oauth/token").len(),
            1,
            "a single refresh must satisfy concurrent callers"
        );
    }
}
