use super::*;
use crate::cli_protocol::{CredentialStore, DeviceLoginResponse};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

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
                session.devices.is_empty() && session.pending.by_state.is_empty(),
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
            user_code: authorization.user_code,
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
                result = timeout(expires, authkit.poll_device_code(&authorization.device_code, interval)) => result,
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
}
