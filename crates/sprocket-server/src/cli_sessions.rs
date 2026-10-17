use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use sprocket_host::lifetime::HostLifetime;
use sprocket_workspace::WorkspaceCancellation;
use tokio::sync::Mutex as AsyncMutex;

use crate::cli_protocol::{CliRunRequest, RunStarted};

const CLIENT_GRACE: Duration = Duration::from_secs(60);
const STARTUP_GRACE: Duration = Duration::from_secs(30);

#[derive(Default)]
pub(crate) struct Submission {
    pub request: Option<CliRunRequest>,
    pub result: Option<Result<RunStarted, String>>,
    pub user_id: Option<String>,
}

pub(crate) struct CliSession {
    pub session_token: String,
    pub cancellation: WorkspaceCancellation,
    pub submission: AsyncMutex<Submission>,
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

/// CLI client leases, which also end a temporary server once every client leaves.
pub(crate) struct CliSessions {
    host: Arc<HostLifetime>,
    state: Mutex<ClientState>,
    temporary: bool,
    started_at: Instant,
}

impl CliSessions {
    pub fn new(host: Arc<HostLifetime>, temporary: bool) -> Self {
        Self {
            host,
            state: Mutex::new(ClientState {
                clients: HashMap::new(),
                used: false,
            }),
            temporary,
            started_at: Instant::now(),
        }
    }

    pub fn connect(&self, client_id: &str, session_token: &str) -> anyhow::Result<()> {
        anyhow::ensure!(
            uuid::Uuid::parse_str(client_id).is_ok(),
            "invalid CLI client ID"
        );
        let mut state = self.state.lock().unwrap();
        anyhow::ensure!(
            !self.host.is_stopping(),
            "server is shutting down; retry the command"
        );
        if let Some(lease) = state.clients.get_mut(client_id) {
            anyhow::ensure!(
                lease.session.session_token == session_token,
                "CLI client belongs to another session"
            );
            anyhow::ensure!(
                lease.expires_at > Instant::now(),
                "CLI client lease expired"
            );
            lease.expires_at = Instant::now() + CLIENT_GRACE;
            return Ok(());
        }
        anyhow::ensure!(state.clients.len() < 256, "too many CLI clients");
        state.used = true;
        state.clients.insert(
            client_id.to_owned(),
            ClientLease {
                expires_at: Instant::now() + CLIENT_GRACE,
                session: Arc::new(CliSession {
                    session_token: session_token.to_owned(),
                    cancellation: WorkspaceCancellation::new(),
                    submission: AsyncMutex::new(Submission::default()),
                    output: Arc::new(sprocket_agent::RunOutput::default()),
                }),
            },
        );
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

    pub fn release(&self, client_id: &str, session_token: &str) -> anyhow::Result<()> {
        let mut state = self.state.lock().unwrap();
        if let Some(lease) = state.clients.get(client_id) {
            anyhow::ensure!(
                lease.session.session_token == session_token,
                "CLI client belongs to another session"
            );
            lease.session.cancellation.cancel();
            state.clients.remove(client_id);
        }
        Ok(())
    }

    pub fn tick(&self, now: Instant) -> (bool, Vec<String>) {
        // Holding the client lock keeps a new CLI connection from racing the idle check.
        let mut state = self.state.lock().unwrap();
        let mut expired = Vec::new();
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
        (self.host.is_stopping(), expired)
    }
}

#[cfg(test)]
mod tests;
