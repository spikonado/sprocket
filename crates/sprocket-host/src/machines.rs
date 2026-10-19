use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use convex::Value;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio::time::{sleep, timeout};
use tokio_util::sync::CancellationToken;

use crate::machine_identity::MachineIdentity;
use crate::native_auth::NativeAuthManager;
use crate::transcript_client::UserConvexClient;

const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);
const RPC_TIMEOUT: Duration = Duration::from_secs(10);
// Covers a 90-second lease plus two RPCs.
const REGISTRATION_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisteredMachine {
    machine_id: String,
    user_id: String,
}

#[derive(serde::Deserialize)]
#[serde(tag = "status", rename_all = "camelCase")]
enum RegistrationResult {
    Registered(RegisteredMachine),
    Busy {
        #[serde(
            rename = "retryAfterMs",
            deserialize_with = "sprocket_convex::deserialize_convex_u64"
        )]
        retry_after_ms: u64,
    },
}

async fn register_when_available<F, Fut>(
    shutdown: &CancellationToken,
    mut attempt: F,
) -> anyhow::Result<RegisteredMachine>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = anyhow::Result<RegistrationResult>>,
{
    let registration = timeout(REGISTRATION_TIMEOUT, async {
        loop {
            match attempt().await? {
                RegistrationResult::Registered(machine) => return Ok(machine),
                RegistrationResult::Busy { retry_after_ms } => {
                    sleep(Duration::from_millis(retry_after_ms.max(1))).await;
                }
            }
        }
    });
    tokio::select! {
        biased;
        _ = shutdown.cancelled() => anyhow::bail!("machine manager is shutting down"),
        result = registration => result.map_err(|_| anyhow::anyhow!(
            "Machine is still active in another Sprocket process. Close that process and try again."
        ))?,
    }
}

struct AccountPresence {
    heartbeat: JoinHandle<()>,
}

pub struct MachineManager {
    deployment_url: String,
    native_auth: Arc<NativeAuthManager>,
    identity: Arc<MachineIdentity>,
    accounts: Mutex<HashMap<String, AccountPresence>>,
    account_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    shutdown: CancellationToken,
}

impl MachineManager {
    pub fn new(
        deployment_url: String,
        native_auth: Arc<NativeAuthManager>,
        identity: Arc<MachineIdentity>,
    ) -> Arc<Self> {
        Arc::new(Self {
            deployment_url,
            native_auth,
            identity,
            accounts: Mutex::new(HashMap::new()),
            account_locks: Mutex::new(HashMap::new()),
            shutdown: CancellationToken::new(),
        })
    }

    pub async fn register(self: &Arc<Self>, expected_user_id: &str) -> anyhow::Result<()> {
        let account = self.account_lock(expected_user_id, false).await?;
        let _account = account.lock().await;
        self.ensure_running()?;
        let registered = self.register_remote(expected_user_id).await?;
        if registered.machine_id != self.identity.installation_id {
            anyhow::bail!("machine registration returned a different installation");
        }
        if registered.user_id != expected_user_id {
            anyhow::bail!("native and browser sessions belong to different users");
        }
        let user_id = registered.user_id;
        if self.reuse_live(&user_id).await {
            return Ok(());
        }
        let heartbeat = self.spawn_heartbeat(user_id.clone());
        let previous = self
            .accounts
            .lock()
            .await
            .insert(user_id.clone(), AccountPresence { heartbeat });
        if let Some(previous) = previous {
            previous.heartbeat.abort();
        }
        Ok(())
    }

    fn spawn_heartbeat(self: &Arc<Self>, user_id: String) -> JoinHandle<()> {
        let manager = Arc::clone(self);
        tokio::spawn(async move {
            loop {
                sleep(HEARTBEAT_INTERVAL).await;
                if !manager.reuse_live(&user_id).await {
                    break;
                }
                if let Err(error) = manager.heartbeat(&user_id).await {
                    tracing::warn!("machine heartbeat failed: {error:#}");
                    if is_terminal_heartbeat_error(&error) || !manager.reuse_live(&user_id).await {
                        break;
                    }
                }
            }
        })
    }

    pub async fn end(&self, user_id: &str) -> anyhow::Result<()> {
        let account = self.account_lock(user_id, true).await?;
        let _account = account.lock().await;
        let Some(presence) = self.accounts.lock().await.remove(user_id) else {
            return Ok(());
        };
        presence.heartbeat.abort();
        self.end_remote(user_id).await
    }

    pub fn stop_registration(&self) {
        self.shutdown.cancel();
    }

    pub async fn shutdown(&self) {
        self.stop_registration();
        self.end_all().await;
    }

    pub async fn end_all(&self) {
        let users = self
            .account_locks
            .lock()
            .await
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        for user_id in users {
            if let Err(error) = self.end(&user_id).await {
                tracing::warn!("failed to end machine presence: {error:#}");
            }
        }
    }

    async fn account_lock(
        &self,
        user_id: &str,
        allow_shutdown: bool,
    ) -> anyhow::Result<Arc<Mutex<()>>> {
        let mut locks = self.account_locks.lock().await;
        if !allow_shutdown {
            self.ensure_running()?;
        }
        Ok(locks
            .entry(user_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone())
    }

    fn ensure_running(&self) -> anyhow::Result<()> {
        if self.shutdown.is_cancelled() {
            anyhow::bail!("machine manager is shutting down");
        }
        Ok(())
    }

    async fn reuse_live(&self, user_id: &str) -> bool {
        self.accounts.lock().await.contains_key(user_id)
    }

    async fn heartbeat(&self, user_id: &str) -> anyhow::Result<()> {
        let account = self.account_lock(user_id, true).await?;
        let _account = account.lock().await;
        if !self.accounts.lock().await.contains_key(user_id) {
            return Ok(());
        }
        let error = match timeout(RPC_TIMEOUT, async {
            let _: serde_json::Value = self
                .connect(user_id)
                .await?
                .mutate("machines:heartbeatProcess", self.process_args())
                .await?;
            anyhow::Ok(())
        })
        .await
        {
            Ok(Ok(())) => return Ok(()),
            Ok(Err(error)) => error,
            Err(_) => anyhow::anyhow!("machine heartbeat timed out"),
        };
        if is_terminal_heartbeat_error(&error) {
            self.accounts.lock().await.remove(user_id);
        }
        Err(error)
    }

    async fn register_remote(&self, expected_user_id: &str) -> anyhow::Result<RegisteredMachine> {
        register_when_available(&self.shutdown, || async {
            self.ensure_running()?;
            timeout(RPC_TIMEOUT, async {
                self.connect(expected_user_id)
                    .await?
                    .mutate("machines:registerProcess", self.registration_args())
                    .await
            })
            .await
            .map_err(|_| anyhow::anyhow!("machine registration timed out"))?
        })
        .await
    }

    async fn end_remote(&self, user_id: &str) -> anyhow::Result<()> {
        timeout(RPC_TIMEOUT, async {
            let _: serde_json::Value = self
                .connect(user_id)
                .await?
                .mutate("machines:endProcess", self.process_args())
                .await?;
            anyhow::Ok(())
        })
        .await
        .map_err(|_| anyhow::anyhow!("ending machine presence timed out"))??;
        Ok(())
    }

    async fn connect(&self, user_id: &str) -> anyhow::Result<UserConvexClient> {
        UserConvexClient::connect_with_fetcher(
            &self.deployment_url,
            self.native_auth
                .auth_token_fetcher_for_user(user_id.to_string()),
        )
        .await
    }

    fn registration_args(&self) -> BTreeMap<String, Value> {
        BTreeMap::from([
            (
                "machineId".into(),
                self.identity.installation_id.clone().into(),
            ),
            ("processId".into(), self.identity.process_id.clone().into()),
            (
                "friendlyName".into(),
                self.identity.friendly_name.clone().into(),
            ),
            ("platform".into(), self.identity.platform.clone().into()),
            (
                "platformVersion".into(),
                self.identity.platform_version.clone().into(),
            ),
            (
                "architecture".into(),
                self.identity.architecture.clone().into(),
            ),
            ("hostname".into(), self.identity.hostname.clone().into()),
            (
                "appVersion".into(),
                sprocket_workspace::SPROCKET_VERSION.to_string().into(),
            ),
        ])
    }

    fn process_args(&self) -> BTreeMap<String, Value> {
        BTreeMap::from([
            (
                "machineId".into(),
                self.identity.installation_id.clone().into(),
            ),
            ("processId".into(), self.identity.process_id.clone().into()),
        ])
    }
}

fn is_terminal_heartbeat_error(error: &anyhow::Error) -> bool {
    error
        .chain()
        .any(|cause| cause.is::<sprocket_convex::AuthSignedOut>())
}

#[cfg(test)]
mod tests;
