use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::Duration;

use convex::Value;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio::time::{sleep, timeout};

use crate::machine_identity::MachineIdentity;
use crate::transcript_client::UserConvexClient;

const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);
const RPC_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisteredMachine {
    machine_id: String,
    user_id: String,
}

struct AccountPresence {
    auth_token: String,
    heartbeat: JoinHandle<()>,
}

pub struct MachineManager {
    deployment_url: String,
    identity: Arc<MachineIdentity>,
    accounts: Mutex<HashMap<String, AccountPresence>>,
    lifecycle: Mutex<LifecycleState>,
}

#[derive(Default)]
struct LifecycleState {
    shutting_down: bool,
    locks: HashMap<String, Arc<Mutex<()>>>,
}

impl MachineManager {
    pub(crate) fn new(deployment_url: String, identity: Arc<MachineIdentity>) -> Arc<Self> {
        Arc::new(Self {
            deployment_url,
            identity,
            accounts: Mutex::new(HashMap::new()),
            lifecycle: Mutex::new(LifecycleState::default()),
        })
    }

    pub async fn register(
        self: &Arc<Self>,
        user_id: &str,
        auth_token: String,
    ) -> anyhow::Result<()> {
        let account = self.account_lock(user_id, false).await?;
        let _account = account.lock().await;
        self.ensure_running().await?;
        if self.reuse_live(user_id, &auth_token).await {
            return Ok(());
        }
        let registered = self.register_remote(auth_token.clone()).await?;
        if registered.user_id != user_id || registered.machine_id != self.identity.installation_id {
            anyhow::bail!("machine registration does not match the requested account");
        }
        let user_id = user_id.to_string();
        let manager = Arc::clone(self);
        let heartbeat_user_id = user_id.clone();
        let heartbeat = tokio::spawn(async move {
            loop {
                sleep(HEARTBEAT_INTERVAL).await;
                if manager.heartbeat(&heartbeat_user_id).await.is_err() {
                    tracing::warn!("machine heartbeat failed");
                    break;
                }
            }
        });
        let previous = self.accounts.lock().await.insert(
            user_id,
            AccountPresence {
                auth_token,
                heartbeat,
            },
        );
        if let Some(previous) = previous {
            previous.heartbeat.abort();
        }
        Ok(())
    }

    pub async fn end(&self, user_id: &str) -> anyhow::Result<()> {
        let account = self.account_lock(user_id, true).await?;
        let _account = account.lock().await;
        let Some(presence) = self.accounts.lock().await.remove(user_id) else {
            return Ok(());
        };
        presence.heartbeat.abort();
        self.end_remote(&presence.auth_token).await
    }

    pub async fn shutdown(&self) {
        let locks = {
            let mut lifecycle = self.lifecycle.lock().await;
            lifecycle.shutting_down = true;
            lifecycle.locks.values().cloned().collect::<Vec<_>>()
        };
        for lock in locks {
            let _lock = lock.lock().await;
            let accounts = self
                .accounts
                .lock()
                .await
                .drain()
                .map(|(_, presence)| presence)
                .collect::<Vec<_>>();
            for presence in accounts {
                presence.heartbeat.abort();
                if let Err(error) = self.end_remote(&presence.auth_token).await {
                    tracing::warn!("failed to end machine presence during shutdown: {error:#}");
                }
            }
        }
    }

    async fn account_lock(
        &self,
        user_id: &str,
        allow_shutdown: bool,
    ) -> anyhow::Result<Arc<Mutex<()>>> {
        let mut lifecycle = self.lifecycle.lock().await;
        if lifecycle.shutting_down && !allow_shutdown {
            anyhow::bail!("machine manager is shutting down");
        }
        Ok(lifecycle
            .locks
            .entry(user_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone())
    }

    async fn ensure_running(&self) -> anyhow::Result<()> {
        if self.lifecycle.lock().await.shutting_down {
            anyhow::bail!("machine manager is shutting down");
        }
        Ok(())
    }

    async fn reuse_live(&self, user_id: &str, auth_token: &str) -> bool {
        let mut accounts = self.accounts.lock().await;
        let Some(presence) = accounts.get_mut(user_id) else {
            return false;
        };
        presence.auth_token = auth_token.to_string();
        true
    }

    async fn heartbeat(&self, user_id: &str) -> anyhow::Result<()> {
        let account = self.account_lock(user_id, true).await?;
        let _account = account.lock().await;
        let auth_token = {
            let accounts = self.accounts.lock().await;
            let Some(presence) = accounts.get(user_id) else {
                return Ok(());
            };
            presence.auth_token.clone()
        };
        let error = match timeout(RPC_TIMEOUT, async {
            let client = UserConvexClient::connect(&self.deployment_url, auth_token).await?;
            let _: serde_json::Value = client
                .mutate("machines:heartbeat", self.machine_args())
                .await?;
            anyhow::Ok(())
        })
        .await
        {
            Ok(Ok(())) => return Ok(()),
            Ok(Err(error)) => error,
            Err(_) => anyhow::anyhow!("machine heartbeat timed out"),
        };
        if let Some(presence) = self.accounts.lock().await.remove(user_id) {
            presence.heartbeat.abort();
        }
        Err(error)
    }

    async fn register_remote(&self, auth_token: String) -> anyhow::Result<RegisteredMachine> {
        timeout(RPC_TIMEOUT, async {
            let client = UserConvexClient::connect(&self.deployment_url, auth_token).await?;
            client
                .mutate("machines:register", self.registration_args())
                .await
        })
        .await
        .map_err(|_| anyhow::anyhow!("machine registration timed out"))?
    }

    async fn end_remote(&self, auth_token: &str) -> anyhow::Result<()> {
        timeout(RPC_TIMEOUT, async {
            let client =
                UserConvexClient::connect(&self.deployment_url, auth_token.to_string()).await?;
            let _: serde_json::Value = client.mutate("machines:end", self.machine_args()).await?;
            anyhow::Ok(())
        })
        .await
        .map_err(|_| anyhow::anyhow!("ending machine presence timed out"))??;
        Ok(())
    }

    fn registration_args(&self) -> BTreeMap<String, Value> {
        BTreeMap::from([
            (
                "machineId".into(),
                self.identity.installation_id.clone().into(),
            ),
            (
                "credentialHash".into(),
                self.identity.credential_hash.clone().into(),
            ),
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
                env!("CARGO_PKG_VERSION").to_string().into(),
            ),
        ])
    }

    fn machine_args(&self) -> BTreeMap<String, Value> {
        BTreeMap::from([
            (
                "machineId".into(),
                self.identity.installation_id.clone().into(),
            ),
            ("credential".into(), self.identity.credential.clone().into()),
        ])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manager_for_test() -> (std::path::PathBuf, Arc<MachineManager>) {
        let dir = std::env::temp_dir().join(format!("sprocket-machine-{}", uuid::Uuid::new_v4()));
        let identity = Arc::new(MachineIdentity::load(&dir).expect("identity"));
        (dir, MachineManager::new("not a valid URL".into(), identity))
    }

    #[tokio::test]
    async fn shutdown_rejects_late_registration_before_network_io() {
        let (dir, manager) = manager_for_test();

        manager.shutdown().await;
        let error = manager
            .register("user-a", "browser-token".into())
            .await
            .expect_err("registration after shutdown must fail");
        assert!(error.to_string().contains("shutting down"));

        let _ = tokio::fs::remove_dir_all(dir).await;
    }

    #[tokio::test]
    async fn live_registration_is_reused_without_another_convex_call() {
        let (dir, manager) = manager_for_test();
        {
            let mut accounts = manager.accounts.lock().await;
            accounts.insert(
                "user-a".into(),
                AccountPresence {
                    auth_token: "old-token".into(),
                    heartbeat: tokio::spawn(std::future::pending()),
                },
            );
        }

        manager
            .register("user-a", "new-token".into())
            .await
            .expect("reuse live registration");
        {
            let accounts = manager.accounts.lock().await;
            let presence = accounts.get("user-a").expect("presence");
            assert_eq!(presence.auth_token, "new-token");
            assert!(
                !presence.heartbeat.is_finished(),
                "reuse must keep the existing heartbeat"
            );
            presence.heartbeat.abort();
        }

        let _ = tokio::fs::remove_dir_all(dir).await;
    }

    #[tokio::test]
    async fn failed_heartbeat_drops_cached_presence() {
        let (dir, manager) = manager_for_test();
        {
            let mut accounts = manager.accounts.lock().await;
            accounts.insert(
                "user-a".into(),
                AccountPresence {
                    auth_token: "old-token".into(),
                    heartbeat: tokio::spawn(std::future::pending()),
                },
            );
        }

        manager
            .heartbeat("user-a")
            .await
            .expect_err("invalid deployment must fail heartbeat");
        assert!(manager.accounts.lock().await.get("user-a").is_none());
        manager
            .register("user-a", "new-token".into())
            .await
            .expect_err("cleared presence must register with Convex");

        let _ = tokio::fs::remove_dir_all(dir).await;
    }
}
