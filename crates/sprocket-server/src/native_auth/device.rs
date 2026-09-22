use super::*;
use crate::cli_protocol::{CredentialStore, DeviceLoginResponse};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const MAX_PENDING_REMOTE_LOGINS: usize = 32;

pub(super) struct PendingDeviceLogin {
    id: String,
    pub cancel: CancellationToken,
    pub result: Option<Result<NativeUser, String>>,
}

impl NativeAuthManager {
    pub async fn select_credential_store(
        self: &Arc<Self>,
        store: CredentialStore,
    ) -> anyhow::Result<()> {
        let manager = Arc::clone(self);
        tokio::spawn(async move { manager.select_credential_store_inner(store).await })
            .await
            .context("credential-store selection task failed")?
    }

    async fn select_credential_store_inner(&self, store: CredentialStore) -> anyhow::Result<()> {
        let _operation = self.credential_operation.lock().await;
        {
            let session = self.session.lock().await;
            anyhow::ensure!(
                session.user.is_none() && session.refresh_token.is_none(),
                "sign out before changing the credential store"
            );
            anyhow::ensure!(
                session.devices.is_empty()
                    && session.remote_devices.is_empty()
                    && session.pending.by_state.is_empty(),
                "cancel pending sign-ins before changing the credential store"
            );
        }
        let credentials = Arc::clone(&self.refresh_tokens);
        tokio::task::spawn_blocking(move || {
            anyhow::ensure!(
                !matches!(credentials.load(), Ok(Some(_))),
                "sign out before changing the credential store"
            );
            credentials.select(store)
        })
        .await??;
        let mut session = self.session.lock().await;
        session.login_generation = session.login_generation.wrapping_add(1);
        Ok(())
    }

    pub async fn start_device_login(
        self: &Arc<Self>,
        session_token: String,
    ) -> anyhow::Result<DeviceLoginResponse> {
        let client = self.client().await?.clone();
        let generation = self.session.lock().await.login_generation;
        let authorization = timeout(
            CLIENT_CONFIG_TIMEOUT,
            client.authkit().start_device_authorization(),
        )
        .await
        .context("device authorization timed out")??;
        let expires = Duration::try_from_secs_f64(authorization.expires_in)
            .context("invalid device authorization lifetime")?
            .min(Duration::from_secs(900));
        anyhow::ensure!(!expires.is_zero(), "device authorization already expired");
        let interval = Duration::try_from_secs_f64(authorization.interval.unwrap_or(5.0))
            .context("invalid device polling interval")?
            .max(Duration::from_secs(1));
        let response = DeviceLoginResponse {
            verification_uri: authorization.verification_uri,
            user_code: authorization.user_code.into_inner(),
            expires_in: expires.as_secs(),
        };
        let id = Uuid::new_v4().to_string();
        let cancel = CancellationToken::new();
        {
            let _operation = self.credential_operation.lock().await;
            let mut session = self.session.lock().await;
            anyhow::ensure!(
                session.login_generation == generation,
                "login was invalidated by another authentication operation"
            );
            if let Some(previous) = session.devices.insert(
                session_token.clone(),
                PendingDeviceLogin {
                    id: id.clone(),
                    cancel: cancel.clone(),
                    result: None,
                },
            ) {
                previous.cancel.cancel();
            }
        }
        let manager = Arc::clone(self);
        tokio::spawn(async move {
            let authkit = client.authkit();
            let polled = tokio::select! {
                _ = cancel.cancelled() => return,
                result = timeout(expires, authkit.poll_device_code(authorization.device_code.expose(), interval)) => result,
            };
            let _operation = manager.credential_operation.lock().await;
            {
                let session = manager.session.lock().await;
                if cancel.is_cancelled()
                    || session.login_generation != generation
                    || !session
                        .devices
                        .get(&session_token)
                        .is_some_and(|attempt| attempt.id == id)
                {
                    return;
                }
            }
            let result = match polled {
                Ok(Ok(response)) => manager
                    .accept_login(response)
                    .await
                    .map_err(|error| error.to_string()),
                Ok(Err(_)) => {
                    Err("Device login failed or was denied. Run sprocket login again.".to_string())
                }
                Err(_) => Err("Device login expired. Run sprocket login again.".to_string()),
            };
            if let Some(attempt) = manager.session.lock().await.devices.get_mut(&session_token) {
                attempt.result = Some(result);
            }
        });
        Ok(response)
    }

    pub async fn device_status(self: &Arc<Self>, session_token: &str) -> NativeLoginStatus {
        {
            let session = self.session.lock().await;
            if let Some(attempt) = session.devices.get(session_token) {
                match &attempt.result {
                    None => return NativeLoginStatus::Pending,
                    Some(Ok(_)) => {}
                    Some(Err(error)) => {
                        return NativeLoginStatus::Failed {
                            error: error.clone(),
                        };
                    }
                }
            }
        }
        self.status(session_token).await
    }

    pub async fn cancel_device_login(&self, session_token: &str) {
        if let Some(attempt) = self.session.lock().await.devices.remove(session_token) {
            attempt.cancel.cancel();
        }
    }

    pub async fn start_remote_device_login(
        self: &Arc<Self>,
        session_token: String,
    ) -> anyhow::Result<NativeLoginStart> {
        let owner = self
            .browser_session(false)
            .await?
            .context("The host is signed out. Run `sprocket login` on the host first.")?
            .user;
        let client = self.client().await?.clone();
        let generation = self.session.lock().await.login_generation;
        let id = Uuid::new_v4().to_string();
        let cancel = CancellationToken::new();
        {
            let mut session = self.session.lock().await;
            anyhow::ensure!(
                session.login_generation == generation,
                "login was invalidated by another authentication operation"
            );
            if !session.remote_devices.contains_key(&session_token)
                && session.remote_devices.len() >= MAX_PENDING_REMOTE_LOGINS
                && let Some(completed) = session
                    .remote_devices
                    .iter()
                    .find(|(_, attempt)| attempt.result.is_some())
                    .map(|(token, _)| token.clone())
                && let Some(attempt) = session.remote_devices.remove(&completed)
            {
                attempt.cancel.cancel();
            }
            anyhow::ensure!(
                session.remote_devices.contains_key(&session_token)
                    || session.remote_devices.len() < MAX_PENDING_REMOTE_LOGINS,
                "too many remote sign-ins are pending"
            );
            if let Some(previous) = session.remote_devices.insert(
                session_token.clone(),
                PendingDeviceLogin {
                    id: id.clone(),
                    cancel: cancel.clone(),
                    result: None,
                },
            ) {
                previous.cancel.cancel();
            }
        }
        let authorization = match timeout(
            CLIENT_CONFIG_TIMEOUT,
            client.authkit().start_device_authorization(),
        )
        .await
        {
            Ok(Ok(authorization)) => authorization,
            result => {
                self.cancel_remote_device_login(&session_token, Some(&id))
                    .await;
                return match result {
                    Ok(Err(error)) => Err(error.into()),
                    Err(error) => Err(error).context("device authorization timed out"),
                    Ok(Ok(_)) => unreachable!(),
                };
            }
        };
        let setup = (|| -> anyhow::Result<_> {
            let expires = Duration::try_from_secs_f64(authorization.expires_in)
                .context("invalid device authorization lifetime")?
                .min(Duration::from_secs(900));
            anyhow::ensure!(!expires.is_zero(), "device authorization already expired");
            let interval = Duration::try_from_secs_f64(authorization.interval.unwrap_or(5.0))
                .context("invalid device polling interval")?
                .max(Duration::from_secs(1));
            let authorization_url = match authorization.verification_uri_complete.clone() {
                Some(url) => url.into_inner(),
                None => {
                    let mut url = url::Url::parse(&authorization.verification_uri)
                        .context("WorkOS returned an invalid verification URI")?;
                    url.query_pairs_mut()
                        .append_pair("user_code", authorization.user_code.expose());
                    url.to_string()
                }
            };
            Ok((expires, interval, authorization_url))
        })();
        let (expires, interval, authorization_url) = match setup {
            Ok(setup) => setup,
            Err(error) => {
                self.cancel_remote_device_login(&session_token, Some(&id))
                    .await;
                return Err(error);
            }
        };
        let current = {
            let session = self.session.lock().await;
            session.login_generation == generation
                && session
                    .remote_devices
                    .get(&session_token)
                    .is_some_and(|attempt| attempt.id == id)
        };
        if !current {
            self.cancel_remote_device_login(&session_token, Some(&id))
                .await;
            anyhow::bail!("login was invalidated by another authentication operation");
        }
        let owner_id = owner.id;
        let manager = Arc::clone(self);
        let task_id = id.clone();
        tokio::spawn(async move {
            let authkit = client.authkit();
            let polled = tokio::select! {
                _ = cancel.cancelled() => return,
                result = timeout(expires, authkit.poll_device_code(authorization.device_code.expose(), interval)) => result,
            };
            let result = match polled {
                Ok(Ok(response)) => {
                    let user = NativeUser {
                        id: response.user.id,
                        email: response.user.email,
                        first_name: response.user.first_name,
                        last_name: response.user.last_name,
                        profile_picture_url: response.user.profile_picture_url,
                    };
                    let current_owner = manager.session.lock().await.user.clone();
                    if user.id != owner_id
                        || current_owner.as_ref().map(|user| user.id.as_str())
                            != Some(owner_id.as_str())
                    {
                        Err(
                            "Sign in with the same account used by `sprocket login` on the host."
                                .to_string(),
                        )
                    } else {
                        Ok(user)
                    }
                }
                Ok(Err(_)) => Err("Device login failed or was denied. Try again.".to_string()),
                Err(_) => Err("Device login expired. Try again.".to_string()),
            };
            let mut session = manager.session.lock().await;
            if cancel.is_cancelled()
                || session.login_generation != generation
                || !session
                    .remote_devices
                    .get(&session_token)
                    .is_some_and(|attempt| attempt.id == task_id)
            {
                return;
            }
            if let Some(attempt) = session.remote_devices.get_mut(&session_token) {
                attempt.result = Some(result);
            }
        });
        Ok(NativeLoginStart {
            authorization_url,
            login_id: id,
        })
    }

    #[cfg(test)]
    pub async fn remote_device_status(&self, session_token: &str) -> NativeLoginStatus {
        let session = self.session.lock().await;
        let Some(attempt) = session.remote_devices.get(session_token) else {
            return NativeLoginStatus::SignedOut;
        };
        match &attempt.result {
            None => NativeLoginStatus::Pending,
            Some(Ok(user)) => NativeLoginStatus::Authenticated { user: user.clone() },
            Some(Err(error)) => NativeLoginStatus::Failed {
                error: error.clone(),
            },
        }
    }

    pub async fn complete_remote_device_login(
        &self,
        session_token: &str,
    ) -> anyhow::Result<NativeLoginStatus> {
        let mut session = self.session.lock().await;
        let Some(attempt) = session.remote_devices.get(session_token) else {
            return Ok(NativeLoginStatus::SignedOut);
        };
        let user = match &attempt.result {
            None => return Ok(NativeLoginStatus::Pending),
            Some(Err(error)) => {
                return Ok(NativeLoginStatus::Failed {
                    error: error.clone(),
                });
            }
            Some(Ok(user)) => {
                if session.user.as_ref().map(|owner| owner.id.as_str()) != Some(user.id.as_str()) {
                    return Ok(NativeLoginStatus::Failed {
                        error: "The host account changed. Sign in again.".to_string(),
                    });
                }
                user.clone()
            }
        };
        let local_sessions = self
            .local_sessions
            .as_ref()
            .context("local browser sessions are unavailable")?;
        local_sessions
            .bind_session_user(session_token, &user.id)
            .await?;
        if let Some(attempt) = session.remote_devices.remove(session_token) {
            attempt.cancel.cancel();
        }
        Ok(NativeLoginStatus::Authenticated { user })
    }

    pub async fn cancel_remote_device_login(&self, session_token: &str, login_id: Option<&str>) {
        let mut session = self.session.lock().await;
        if session
            .remote_devices
            .get(session_token)
            .is_some_and(|attempt| login_id.is_none_or(|login_id| attempt.id == login_id))
            && let Some(attempt) = session.remote_devices.remove(session_token)
        {
            attempt.cancel.cancel();
        }
    }
}
