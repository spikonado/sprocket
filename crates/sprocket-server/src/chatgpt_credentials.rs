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
mod tests;
