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
    pub(crate) fn new(
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

    pub async fn end(&self, user_id: &str) -> anyhow::Result<()> {
        let account = self.account_lock(user_id, true).await?;
        let _account = account.lock().await;
        let Some(presence) = self.accounts.lock().await.remove(user_id) else {
            return Ok(());
        };
        presence.heartbeat.abort();
        self.end_remote(user_id).await
    }

    pub(crate) fn stop_registration(&self) {
        self.shutdown.cancel();
    }

    pub async fn shutdown(&self) {
        self.stop_registration();
        let users = self
            .account_locks
            .lock()
            .await
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        for user_id in users {
            if let Err(error) = self.end(&user_id).await {
                tracing::warn!("failed to end machine presence during shutdown: {error:#}");
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
            let client = UserConvexClient::connect_anonymous(&self.deployment_url).await?;
            let _: serde_json::Value = client
                .mutate("machines:heartbeat", self.machine_args(user_id))
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

    async fn register_remote(&self, expected_user_id: &str) -> anyhow::Result<RegisteredMachine> {
        register_when_available(&self.shutdown, || async {
            self.ensure_running()?;
            timeout(RPC_TIMEOUT, async {
                let client = UserConvexClient::connect_with_fetcher(
                    &self.deployment_url,
                    self.native_auth
                        .auth_token_fetcher_for_user(expected_user_id.to_string()),
                )
                .await?;
                client
                    .mutate("machines:tryRegister", self.registration_args())
                    .await
            })
            .await
            .map_err(|_| anyhow::anyhow!("machine registration timed out"))?
        })
        .await
    }

    async fn end_remote(&self, user_id: &str) -> anyhow::Result<()> {
        timeout(RPC_TIMEOUT, async {
            let client = UserConvexClient::connect_anonymous(&self.deployment_url).await?;
            let _: serde_json::Value = client
                .mutate("machines:end", self.machine_args(user_id))
                .await?;
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
                sprocket_workspace::SPROCKET_VERSION.to_string().into(),
            ),
        ])
    }

    fn machine_args(&self, user_id: &str) -> BTreeMap<String, Value> {
        BTreeMap::from([
            ("userId".into(), user_id.to_string().into()),
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

    #[tokio::test(start_paused = true)]
    async fn registration_recovers_after_a_crashed_process_lease_expires() {
        let started = tokio::time::Instant::now();
        let mut attempts = 0;
        let registered = register_when_available(&CancellationToken::new(), || {
            attempts += 1;
            let result = if attempts == 1 {
                serde_json::from_value::<RegistrationResult>(serde_json::json!({
                    "status": "busy",
                    "retryAfterMs": 90001.0,
                }))
                .unwrap()
            } else {
                serde_json::from_value(serde_json::json!({
                    "status": "registered",
                    "machineId": "machine-a",
                    "userId": "user-a",
                }))
                .unwrap()
            };
            std::future::ready(Ok(result))
        })
        .await
        .unwrap();

        assert_eq!(attempts, 2);
        assert_eq!(started.elapsed(), Duration::from_millis(90_001));
        assert_eq!(registered.machine_id, "machine-a");
        assert_eq!(registered.user_id, "user-a");
    }

    #[tokio::test(start_paused = true)]
    async fn registration_does_not_wait_forever_for_a_live_process() {
        let started = tokio::time::Instant::now();
        let mut attempts = 0;
        let result = register_when_available(&CancellationToken::new(), || {
            attempts += 1;
            std::future::ready(Ok(RegistrationResult::Busy {
                retry_after_ms: 90_001,
            }))
        })
        .await;

        assert!(
            result
                .err()
                .unwrap()
                .to_string()
                .contains("Close that process")
        );
        assert_eq!(attempts, 2);
        assert_eq!(started.elapsed(), REGISTRATION_TIMEOUT);
    }

    #[tokio::test(start_paused = true)]
    async fn registration_does_not_retry_other_errors() {
        let started = tokio::time::Instant::now();
        let mut attempts = 0;
        let result = register_when_available(&CancellationToken::new(), || {
            attempts += 1;
            std::future::ready(Err(anyhow::anyhow!("authentication failed")))
        })
        .await;

        assert_eq!(result.err().unwrap().to_string(), "authentication failed");
        assert_eq!(attempts, 1);
        assert_eq!(started.elapsed(), Duration::ZERO);
    }

    #[tokio::test(start_paused = true)]
    async fn shutdown_interrupts_registration_waiting_for_a_stale_lease() {
        let shutdown = CancellationToken::new();
        let task_shutdown = shutdown.clone();
        let started = tokio::time::Instant::now();
        let (attempted, attempt_received) = tokio::sync::oneshot::channel();
        let registration = tokio::spawn(async move {
            let mut attempted = Some(attempted);
            register_when_available(&task_shutdown, || {
                attempted.take().unwrap().send(()).unwrap();
                std::future::ready(Ok(RegistrationResult::Busy {
                    retry_after_ms: 90_001,
                }))
            })
            .await
        });

        attempt_received.await.unwrap();
        shutdown.cancel();
        let error = registration.await.unwrap().err().unwrap();
        assert!(error.to_string().contains("shutting down"));
        assert_eq!(started.elapsed(), Duration::ZERO);
    }

    fn manager_for_test() -> (std::path::PathBuf, Arc<MachineManager>) {
        let dir = std::env::temp_dir().join(format!("sprocket-machine-{}", uuid::Uuid::new_v4()));
        let identity = Arc::new(MachineIdentity::load(&dir).expect("identity"));
        let native_auth = NativeAuthManager::configured_for_test(
            crate::native_auth::NativeAuthConfig {
                workos_client_id: "client_test".to_string(),
            },
            "http://127.0.0.1/callback".to_string(),
        );
        (
            dir,
            MachineManager::new("not a valid URL".into(), native_auth, identity),
        )
    }

    #[tokio::test]
    async fn shutdown_rejects_late_registration_before_network_io() {
        let (dir, manager) = manager_for_test();

        manager.shutdown().await;
        let error = manager
            .register("user-a")
            .await
            .expect_err("registration after shutdown must fail");
        assert!(error.to_string().contains("shutting down"));

        let _ = tokio::fs::remove_dir_all(dir).await;
    }

    #[tokio::test(start_paused = true)]
    async fn registration_for_one_account_does_not_block_other_accounts() {
        let (dir, manager) = manager_for_test();
        let account = manager.account_lock("user-a", false).await.unwrap();
        let guard = account.lock().await;
        let mut waiting = Box::pin(manager.register("user-a"));
        assert!(futures::poll!(&mut waiting).is_pending());

        let result = timeout(Duration::from_secs(1), manager.register("user-b"))
            .await
            .expect("another account must not wait for user-a's registration");
        assert!(result.is_err(), "invalid deployment must fail registration");

        drop(waiting);
        drop(guard);
        let _ = tokio::fs::remove_dir_all(dir).await;
    }

    #[tokio::test]
    async fn failed_registration_keeps_an_existing_presence() {
        let (dir, manager) = manager_for_test();
        {
            let mut accounts = manager.accounts.lock().await;
            accounts.insert(
                "user-a".into(),
                AccountPresence {
                    heartbeat: tokio::spawn(std::future::pending()),
                },
            );
        }

        manager
            .register("user-a")
            .await
            .expect_err("registration still authenticates with Convex");
        {
            let accounts = manager.accounts.lock().await;
            let presence = accounts.get("user-a").expect("presence");
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
            .register("user-a")
            .await
            .expect_err("cleared presence must register with Convex");

        let _ = tokio::fs::remove_dir_all(dir).await;
    }
}
