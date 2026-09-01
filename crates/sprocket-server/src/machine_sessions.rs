use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::Duration;

use convex::Value;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio::time::sleep;

use crate::machine_identity::MachineIdentity;
use crate::transcript_client::UserConvexClient;

const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisteredSession {
    session_id: String,
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
}

impl MachineSessionManager {
    pub(crate) fn new(deployment_url: String, identity: Arc<MachineIdentity>) -> Arc<Self> {
        Arc::new(Self {
            deployment_url,
            identity,
            sessions: Mutex::new(HashMap::new()),
        })
    }

    pub async fn register(
        self: &Arc<Self>,
        user_id: &str,
        auth_token: String,
    ) -> anyhow::Result<()> {
        let client = UserConvexClient::connect(&self.deployment_url, auth_token.clone()).await?;
        let registered: RegisteredSession = client
            .mutate("machineSessions:register", self.registration_args())
            .await?;
        let user_id = user_id.to_string();
        let manager = Arc::clone(self);
        let heartbeat_user_id = user_id.clone();
        let heartbeat = tokio::spawn(async move {
            loop {
                sleep(HEARTBEAT_INTERVAL).await;
                if manager.heartbeat(&heartbeat_user_id).await.is_err() {
                    tracing::warn!("machine session heartbeat failed");
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
        Ok(())
    }

    pub async fn end(&self, user_id: &str) -> anyhow::Result<()> {
        let Some(session) = self.sessions.lock().await.remove(user_id) else {
            return Ok(());
        };
        session.heartbeat.abort();
        self.end_remote(&session).await
    }

    pub async fn shutdown(&self) {
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

    async fn heartbeat(&self, user_id: &str) -> anyhow::Result<()> {
        let (auth_token, session_id) = {
            let sessions = self.sessions.lock().await;
            let Some(session) = sessions.get(user_id) else {
                return Ok(());
            };
            (session.auth_token.clone(), session.session_id.clone())
        };
        let client = UserConvexClient::connect(&self.deployment_url, auth_token).await?;
        let _: serde_json::Value = client
            .mutate("machineSessions:heartbeat", self.session_args(session_id))
            .await?;
        Ok(())
    }

    async fn end_remote(&self, session: &AccountSession) -> anyhow::Result<()> {
        let client =
            UserConvexClient::connect(&self.deployment_url, session.auth_token.clone()).await?;
        let _: serde_json::Value = client
            .mutate(
                "machineSessions:end",
                self.session_args(session.session_id.clone()),
            )
            .await?;
        Ok(())
    }

    fn registration_args(&self) -> BTreeMap<String, Value> {
        BTreeMap::from([
            (
                "installationId".into(),
                self.identity.installation_id.clone().into(),
            ),
            (
                "processSessionId".into(),
                self.identity.process_session_id.clone().into(),
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

    fn session_args(&self, session_id: String) -> BTreeMap<String, Value> {
        BTreeMap::from([
            ("sessionId".into(), session_id.into()),
            ("credential".into(), self.identity.credential.clone().into()),
        ])
    }
}
