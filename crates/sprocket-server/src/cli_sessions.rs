use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use sprocket_host::lifetime::HostLifetime;
use sprocket_host::native_auth::NativeAuthManager;
use sprocket_workspace::WorkspaceCancellation;
use tokio::sync::Mutex as AsyncMutex;

use crate::auth::AuthState;
use crate::cli_protocol::{CliRunRequest, RunStarted};

const CLIENT_GRACE: Duration = Duration::from_secs(60);
const STARTUP_GRACE: Duration = Duration::from_secs(30);

pub(crate) struct Submission {
    pub request: CliRunRequest,
    pub result: Result<StartedRun, String>,
}

#[derive(Clone)]
pub(crate) struct StartedRun {
    pub user_id: String,
    pub run: RunStarted,
}

pub(crate) struct CliSession {
    pub session_token: String,
    pub cancellation: WorkspaceCancellation,
    pub submission: AsyncMutex<Option<Submission>>,
    pub output: Arc<sprocket_agent::RunOutput>,
}

struct ClientLease {
    session: Arc<CliSession>,
    expires_at: Instant,
}

struct ClientState {
    clients: HashMap<String, ClientLease>,
    used: bool,
}

pub(crate) struct CliSessions {
    host: Arc<HostLifetime>,
    native_auth: Arc<NativeAuthManager>,
    auth: Arc<AuthState>,
    state: Mutex<ClientState>,
    temporary: bool,
    started_at: Instant,
}

impl CliSessions {
    pub fn new(
        host: Arc<HostLifetime>,
        native_auth: Arc<NativeAuthManager>,
        auth: Arc<AuthState>,
        temporary: bool,
    ) -> Self {
        Self {
            host,
            native_auth,
            auth,
            state: Mutex::new(ClientState {
                clients: HashMap::new(),
                used: false,
            }),
            temporary,
            started_at: Instant::now(),
        }
    }

    pub async fn connect(&self, client_id: &str, session_token: &str) -> anyhow::Result<()> {
        anyhow::ensure!(
            uuid::Uuid::parse_str(client_id).is_ok(),
            "invalid CLI client ID"
        );
        {
            let mut state = self.state.lock().unwrap();
            anyhow::ensure!(
                !self.host.is_stopping(),
                "server is shutting down; retry the command"
            );
            anyhow::ensure!(
                !state.clients.contains_key(client_id),
                "CLI client is already connected"
            );
            anyhow::ensure!(state.clients.len() < 256, "too many CLI clients");
            state.used = true;
            state.clients.insert(
                client_id.to_owned(),
                ClientLease {
                    expires_at: Instant::now() + CLIENT_GRACE,
                    session: Arc::new(CliSession {
                        session_token: session_token.to_owned(),
                        cancellation: WorkspaceCancellation::new(),
                        submission: AsyncMutex::new(None),
                        output: Arc::new(sprocket_agent::RunOutput::default()),
                    }),
                },
            );
        }
        self.auth.create_cli_session(session_token.to_owned()).await;
        Ok(())
    }

    pub fn client(&self, client_id: &str, session_token: &str) -> anyhow::Result<Arc<CliSession>> {
        let mut state = self.state.lock().unwrap();
        let lease = state
            .clients
            .get_mut(client_id)
            .ok_or_else(|| anyhow::anyhow!("CLI session was lost; the run was not resubmitted"))?;
        anyhow::ensure!(
            lease.session.session_token == session_token,
            "CLI client belongs to another session"
        );
        anyhow::ensure!(
            lease.expires_at > Instant::now(),
            "CLI client lease expired"
        );
        lease.expires_at = Instant::now() + CLIENT_GRACE;
        Ok(Arc::clone(&lease.session))
    }

    pub async fn release(&self, client_id: &str, session_token: &str) -> anyhow::Result<()> {
        {
            let mut state = self.state.lock().unwrap();
            if let Some(lease) = state.clients.get(client_id) {
                anyhow::ensure!(
                    lease.session.session_token == session_token,
                    "CLI client belongs to another session"
                );
                lease.session.cancellation.cancel();
                state.clients.remove(client_id);
            }
        }
        self.end_auth_session(session_token).await
    }

    pub async fn tick(&self, now: Instant) {
        let mut expired = Vec::new();
        {
            let mut state = self.state.lock().unwrap();
            state.clients.retain(|_, lease| {
                if lease.expires_at > now {
                    return true;
                }
                lease.session.cancellation.cancel();
                expired.push(lease.session.session_token.clone());
                false
            });
            if self.temporary
                && state.clients.is_empty()
                && (state.used || now.duration_since(self.started_at) >= STARTUP_GRACE)
            {
                self.host.stop_if_idle();
            }
        }
        for session_token in expired {
            if let Err(error) = self.end_auth_session(&session_token).await {
                tracing::warn!("failed to end an expired CLI session: {error:#}");
            }
        }
    }

    async fn end_auth_session(&self, session_token: &str) -> anyhow::Result<()> {
        self.native_auth.cancel_device_login(session_token).await;
        self.auth.end_session(session_token).await
    }
}

#[cfg(test)]
mod tests;
