mod oauth;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use anyhow::{Context, bail, ensure};
use futures::future::BoxFuture;
use serde::{Deserialize, Serialize};
use sprocket_agent::{ChatGptAccess, ChatGptCredentials};
use tokio::sync::{Mutex, watch};
use uuid::Uuid;

use oauth::{
    DYNAMIC_CLIENT, ISSUER, Refresh, ReturningAccount, authorization_url, issued_client,
    require_scopes,
};

#[derive(Clone)]
pub struct ChatGptService {
    state: Arc<Mutex<Store>>,
    path: Arc<PathBuf>,
    issuer: String,
    token_endpoint: String,
    client: reqwest::Client,
    watches: Arc<StdMutex<HashMap<String, watch::Sender<Option<String>>>>>,
    memory_ahead_of_disk: Arc<AtomicBool>,
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

pub struct PendingGrant {
    user: String,
    expected_connection: Option<String>,
    expected_session: Option<String>,
    client_id: String,
    subject: String,
    email: Option<String>,
    tokens: Tokens,
}

#[derive(Clone)]
pub struct SignIn {
    pub user: String,
    pub connection: Option<String>,
    pub redirect_uri: String,
    pub nonce: String,
    pub verifier: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceStatus {
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

fn active_account<'a>(state: &'a mut Store, user: &str) -> anyhow::Result<&'a mut Account> {
    let accounts = state
        .users
        .get_mut(user)
        .context("Connect ChatGPT locally in Settings before starting a run.")?;
    let active = accounts
        .active
        .as_deref()
        .context("Select a ChatGPT account in Settings.")?;
    accounts
        .accounts
        .iter_mut()
        .find(|account| account.connection_id == active)
        .context("Select a ChatGPT account in Settings.")
}

impl ChatGptService {
    pub fn load(data_dir: &Path) -> anyhow::Result<Arc<Self>> {
        Self::load_with_issuer(data_dir, ISSUER)
    }

    pub fn load_or_unavailable(data_dir: &Path) -> anyhow::Result<Arc<Self>> {
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

    pub fn available(&self) -> bool {
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
            memory_ahead_of_disk: Arc::new(AtomicBool::new(false)),
            storage_error,
            #[cfg(test)]
            persist_failure_after: Arc::new(StdMutex::new(None)),
        }))
    }

    async fn persist(&self, state: &Store) -> anyhow::Result<()> {
        self.require_storage()?;
        self.memory_ahead_of_disk.store(true, Ordering::Release);
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
        self.memory_ahead_of_disk.store(false, Ordering::Release);
        Ok(())
    }

    async fn persist_refresh_in_flight(&self, state: &Store, user: &str) -> anyhow::Result<()> {
        let mut on_disk = state.clone();
        active_account(&mut on_disk, user)?
            .tokens
            .as_mut()
            .context("Reconnect ChatGPT locally in Settings.")?
            .refresh_in_flight = true;
        self.persist(&on_disk).await
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

    pub fn for_user(self: &Arc<Self>, user: String) -> Arc<dyn ChatGptCredentials> {
        Arc::new(UserCredentials {
            service: Arc::clone(self),
            user,
        })
    }

    pub async fn authorization(&self, sign_in: &SignIn, state: &str) -> anyhow::Result<String> {
        self.require_storage()?;
        let stored = self.state.lock().await;
        let account = sign_in
            .connection
            .as_deref()
            .map(|connection| {
                stored
                    .users
                    .get(&sign_in.user)
                    .and_then(|accounts| {
                        accounts
                            .accounts
                            .iter()
                            .find(|account| account.connection_id == connection)
                    })
                    .context("Saved ChatGPT account was not found.")
            })
            .transpose()?;
        authorization_url(
            sign_in,
            state,
            &stored.host_id,
            account.map_or(DYNAMIC_CLIENT, |account| account.client_id.as_str()),
            account.map(|account| ReturningAccount {
                id_token: account
                    .tokens
                    .as_ref()
                    .map(|tokens| tokens.id_token.as_str()),
                email: account.email.as_deref(),
            }),
        )
    }

    pub async fn exchange(
        &self,
        sign_in: &SignIn,
        code: &str,
        callback_client: Option<&str>,
    ) -> anyhow::Result<PendingGrant> {
        let account = {
            let state = self.state.lock().await;
            sign_in
                .connection
                .as_deref()
                .map(|connection| {
                    state
                        .users
                        .get(&sign_in.user)
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
        let (tokens, identity) = oauth::exchange(
            &self.client,
            &self.token_endpoint,
            &self.issuer,
            &client_id,
            code,
            sign_in,
            account.as_ref().map(|account| account.subject.as_str()),
        )
        .await?;
        Ok(PendingGrant {
            user: sign_in.user.clone(),
            expected_connection: sign_in.connection.clone(),
            expected_session: account.as_ref().map(|account| account.session_id.clone()),
            client_id,
            subject: identity.sub,
            email: identity.email,
            tokens,
        })
    }

    pub async fn discard(&self, grant: PendingGrant) {
        self.revoke(&grant.client_id, &grant.tokens.refresh_token)
            .await;
    }

    pub async fn commit(&self, user: &str, grant: PendingGrant) -> anyhow::Result<()> {
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

    pub async fn select(&self, user: &str, connection: &str) -> anyhow::Result<()> {
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
        oauth::revoke(&self.client, &self.issuer, client_id, refresh_token).await
    }

    pub async fn disconnect(&self, user: &str, connection: &str) -> anyhow::Result<Option<String>> {
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
        if self.memory_ahead_of_disk.load(Ordering::Acquire) {
            self.persist(&state).await?;
        }
        let account = active_account(&mut state, user)?;
        let tokens = account
            .tokens
            .clone()
            .context("Reconnect ChatGPT locally in Settings.")?;
        require_scopes(&tokens.scopes)?;
        if tokens.expires_at > now().saturating_add(60) {
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
        self.persist_refresh_in_flight(&state, user).await?;
        let outcome = self.refresh(&client_id, &subject, &tokens).await;
        let account = active_account(&mut state, user)?;
        let result = match outcome {
            Refresh::Refreshed(refreshed) => {
                let access = ChatGptAccess {
                    connection_id: account.session_id.clone(),
                    access_token: refreshed.access_token.clone(),
                    expires_at: refreshed.expires_at.saturating_mul(1000),
                };
                account.tokens = Some(refreshed);
                Ok(access)
            }
            Refresh::Retry(message) => Err(anyhow::anyhow!(message)),
            Refresh::Disconnect(error) => {
                account.tokens = None;
                account.session_id = Uuid::new_v4().to_string();
                self.notify(user, &state.users[user]);
                Err(error)
            }
        };
        self.persist(&state).await?;
        result
    }

    async fn refresh(&self, client_id: &str, subject: &str, tokens: &Tokens) -> Refresh {
        oauth::refresh(
            &self.client,
            &self.token_endpoint,
            &self.issuer,
            client_id,
            subject,
            tokens,
        )
        .await
    }

    pub async fn status(&self, user: &str) -> anyhow::Result<ServiceStatus> {
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
                if service.memory_ahead_of_disk.load(Ordering::Acquire)
                    && let Err(failure) = service.persist(&state).await
                {
                    error = Some(failure.to_string());
                }
                state.users.get(&user).and_then(session).is_some()
            };
            if connected
                && error.is_none()
                && let Err(failure) = service.access(&user).await
            {
                error = Some(failure.to_string());
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
            crate::run_to_completion(async move { service.access(&user).await })
                .await
                .context("ChatGPT refresh task stopped.")?
        })
    }
}

#[cfg(test)]
mod tests;
