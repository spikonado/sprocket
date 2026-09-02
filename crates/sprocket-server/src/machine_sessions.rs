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
const SESSION_RPC_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisteredSession {
    session_id: String,
    user_id: String,
}

struct AccountSession {
    auth_token: String,
    session_id: String,
    heartbeat: JoinHandle<()>,
}

pub struct MachineSessionManager {
    deployment_url: String,
    identity: Arc<MachineIdentity>,
    sessions: Mutex<HashMap<String, AccountSession>>,
    process_session_ids: Mutex<HashMap<String, String>>,
    lifecycle: Mutex<LifecycleState>,
}

#[derive(Default)]
struct LifecycleState {
    shutting_down: bool,
    accounts: HashMap<String, Arc<Mutex<()>>>,
}

impl MachineSessionManager {
    pub(crate) fn new(deployment_url: String, identity: Arc<MachineIdentity>) -> Arc<Self> {
        Arc::new(Self {
            deployment_url,
            identity,
            sessions: Mutex::new(HashMap::new()),
            process_session_ids: Mutex::new(HashMap::new()),
            lifecycle: Mutex::new(LifecycleState::default()),
        })
    }

    pub async fn register(
        self: &Arc<Self>,
        user_id: &str,
        auth_token: String,
    ) -> anyhow::Result<String> {
        let account = self.account_lock(user_id, false).await?;
        let _account = account.lock().await;
        self.ensure_running().await?;
        if let Some(session_id) = self.reuse_live_session(user_id, &auth_token).await {
            return Ok(session_id);
        }
        let registered = self
            .register_remote(
                auth_token.clone(),
                self.process_session_id_for(user_id).await,
            )
            .await?;
        if registered.user_id != user_id {
            anyhow::bail!("machine session account does not match the requested account");
        }
        let session_id = registered.session_id.clone();
        let user_id = user_id.to_string();
        let manager = Arc::clone(self);
        let heartbeat_user_id = user_id.clone();
        let heartbeat = tokio::spawn(async move {
            loop {
                sleep(HEARTBEAT_INTERVAL).await;
                if manager.heartbeat(&heartbeat_user_id).await.is_err() {
                    tracing::warn!("machine session heartbeat failed");
                    break;
                }
            }
        });
        let previous = self.sessions.lock().await.insert(
            user_id,
            AccountSession {
                auth_token,
                session_id: registered.session_id,
                heartbeat,
            },
        );
        if let Some(previous) = previous {
            previous.heartbeat.abort();
        }
        Ok(session_id)
    }

    pub async fn end(&self, user_id: &str) -> anyhow::Result<()> {
        let account = self.account_lock(user_id, true).await?;
        let _account = account.lock().await;
        let Some(session) = self.sessions.lock().await.remove(user_id) else {
            return Ok(());
        };
        session.heartbeat.abort();
        self.rotate_process_session_id(user_id).await;
        self.end_remote(&session).await
    }

    pub async fn shutdown(&self) {
        let accounts = {
            let mut lifecycle = self.lifecycle.lock().await;
            lifecycle.shutting_down = true;
            lifecycle.accounts.values().cloned().collect::<Vec<_>>()
        };
        for account in accounts {
            let _account = account.lock().await;
            let sessions = self
                .sessions
                .lock()
                .await
                .drain()
                .map(|(_, session)| session)
                .collect::<Vec<_>>();
            for session in sessions {
                session.heartbeat.abort();
                if let Err(error) = self.end_remote(&session).await {
                    tracing::warn!("failed to end machine session during shutdown: {error:#}");
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
            anyhow::bail!("machine session manager is shutting down");
        }
        Ok(lifecycle
            .accounts
            .entry(user_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone())
    }

    async fn ensure_running(&self) -> anyhow::Result<()> {
        if self.lifecycle.lock().await.shutting_down {
            anyhow::bail!("machine session manager is shutting down");
        }
        Ok(())
    }

    async fn reuse_live_session(&self, user_id: &str, auth_token: &str) -> Option<String> {
        let mut sessions = self.sessions.lock().await;
        let session = sessions.get_mut(user_id)?;
        session.auth_token = auth_token.to_string();
        Some(session.session_id.clone())
    }

    async fn heartbeat(&self, user_id: &str) -> anyhow::Result<()> {
        let account = self.account_lock(user_id, true).await?;
        let _account = account.lock().await;
        let (auth_token, session_id) = {
            let sessions = self.sessions.lock().await;
            let Some(session) = sessions.get(user_id) else {
                return Ok(());
            };
            (session.auth_token.clone(), session.session_id.clone())
        };
        let error = match timeout(SESSION_RPC_TIMEOUT, async {
            let client = UserConvexClient::connect(&self.deployment_url, auth_token).await?;
            let _: serde_json::Value = client
                .mutate("machineSessions:heartbeat", self.session_args(session_id))
                .await?;
            anyhow::Ok(())
        })
        .await
        {
            Ok(Ok(())) => return Ok(()),
            Ok(Err(error)) => error,
            Err(_) => anyhow::anyhow!("machine session heartbeat timed out"),
        };
        if let Some(session) = self.sessions.lock().await.remove(user_id) {
            session.heartbeat.abort();
        }
        Err(error)
    }

    async fn process_session_id_for(&self, user_id: &str) -> String {
        self.process_session_ids
            .lock()
            .await
            .entry(user_id.to_string())
            .or_insert_with(|| self.identity.process_session_id.clone())
            .clone()
    }

    async fn rotate_process_session_id(&self, user_id: &str) -> String {
        let next = uuid::Uuid::new_v4().to_string();
        self.process_session_ids
            .lock()
            .await
            .insert(user_id.to_string(), next.clone());
        next
    }

    async fn register_remote(
        &self,
        auth_token: String,
        process_session_id: String,
    ) -> anyhow::Result<RegisteredSession> {
        timeout(SESSION_RPC_TIMEOUT, async {
            let client = UserConvexClient::connect(&self.deployment_url, auth_token).await?;
            client
                .mutate(
                    "machineSessions:register",
                    self.registration_args(process_session_id),
                )
                .await
        })
        .await
        .map_err(|_| anyhow::anyhow!("machine session registration timed out"))?
    }

    async fn end_remote(&self, session: &AccountSession) -> anyhow::Result<()> {
        timeout(SESSION_RPC_TIMEOUT, async {
            let client =
                UserConvexClient::connect(&self.deployment_url, session.auth_token.clone()).await?;
            let _: serde_json::Value = client
                .mutate(
                    "machineSessions:end",
                    self.session_args(session.session_id.clone()),
                )
                .await?;
            anyhow::Ok(())
        })
        .await
        .map_err(|_| anyhow::anyhow!("ending machine session timed out"))??;
        Ok(())
    }

    fn registration_args(&self, process_session_id: String) -> BTreeMap<String, Value> {
        BTreeMap::from([
            (
                "installationId".into(),
                self.identity.installation_id.clone().into(),
            ),
            ("processSessionId".into(), process_session_id.into()),
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

    fn session_args(&self, session_id: String) -> BTreeMap<String, Value> {
        BTreeMap::from([
            ("sessionId".into(), session_id.into()),
            ("credential".into(), self.identity.credential.clone().into()),
        ])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manager_for_test() -> (std::path::PathBuf, Arc<MachineSessionManager>) {
        let dir =
            std::env::temp_dir().join(format!("sprocket-machine-session-{}", uuid::Uuid::new_v4()));
        let identity = Arc::new(MachineIdentity::load(&dir).expect("identity"));
        (
            dir,
            MachineSessionManager::new("not a valid URL".into(), identity),
        )
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
    async fn live_session_is_reused_without_another_convex_call() {
        let (dir, manager) = manager_for_test();
        {
            let mut sessions = manager.sessions.lock().await;
            sessions.insert(
                "user-a".into(),
                AccountSession {
                    auth_token: "old-token".into(),
                    session_id: "session-1".into(),
                    heartbeat: tokio::spawn(std::future::pending()),
                },
            );
        }

        let session_id = manager
            .register("user-a", "new-token".into())
            .await
            .expect("reuse live session");
        assert_eq!(session_id, "session-1");
        {
            let sessions = manager.sessions.lock().await;
            let session = sessions.get("user-a").expect("session");
            assert_eq!(session.auth_token, "new-token");
            assert!(
                !session.heartbeat.is_finished(),
                "reuse must keep the existing heartbeat"
            );
            session.heartbeat.abort();
        }

        let _ = tokio::fs::remove_dir_all(dir).await;
    }

    #[tokio::test]
    async fn failed_heartbeat_drops_the_cached_session() {
        let (dir, manager) = manager_for_test();
        {
            let mut sessions = manager.sessions.lock().await;
            sessions.insert(
                "user-a".into(),
                AccountSession {
                    auth_token: "old-token".into(),
                    session_id: "session-1".into(),
                    heartbeat: tokio::spawn(std::future::pending()),
                },
            );
        }
        manager
            .process_session_ids
            .lock()
            .await
            .insert("user-a".into(), "process-a".into());

        manager
            .heartbeat("user-a")
            .await
            .expect_err("invalid deployment must fail heartbeat");
        assert!(manager.sessions.lock().await.get("user-a").is_none());
        assert_eq!(
            manager.process_session_id_for("user-a").await,
            "process-a",
            "transient heartbeat failures must keep the process identity"
        );
        manager
            .register("user-a", "new-token".into())
            .await
            .expect_err("cleared session must register with Convex");

        let _ = tokio::fs::remove_dir_all(dir).await;
    }
}
