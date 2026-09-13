use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

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

struct LifetimeState {
    clients: HashMap<String, ClientLease>,
    active_runs: usize,
    accepting: bool,
    used: bool,
}

pub(crate) struct ServerLifetime {
    pub shutdown: WorkspaceCancellation,
    state: Mutex<LifetimeState>,
    temporary: bool,
    started_at: Instant,
}

impl ServerLifetime {
    pub fn new(temporary: bool) -> Arc<Self> {
        Arc::new(Self {
            shutdown: WorkspaceCancellation::new(),
            state: Mutex::new(LifetimeState {
                clients: HashMap::new(),
                active_runs: 0,
                accepting: true,
                used: false,
            }),
            temporary,
            started_at: Instant::now(),
        })
    }

    pub fn connect(&self, client_id: &str, session_token: &str) -> anyhow::Result<()> {
        anyhow::ensure!(
            uuid::Uuid::parse_str(client_id).is_ok(),
            "invalid CLI client ID"
        );
        let mut state = self.state.lock().unwrap();
        anyhow::ensure!(
            state.accepting,
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

    pub fn run_guard(self: &Arc<Self>) -> anyhow::Result<RunGuard> {
        let mut state = self.state.lock().unwrap();
        anyhow::ensure!(state.accepting, "server is shutting down");
        state.active_runs += 1;
        Ok(RunGuard(Arc::clone(self)))
    }

    pub fn tick(&self, now: Instant) -> (bool, Vec<String>) {
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
            && state.active_runs == 0
            && (state.used || now.duration_since(self.started_at) >= STARTUP_GRACE)
        {
            state.accepting = false;
            self.shutdown.cancel();
        }
        (!state.accepting, expired)
    }
}

pub(crate) struct RunGuard(Arc<ServerLifetime>);

impl Drop for RunGuard {
    fn drop(&mut self) {
        self.0.state.lock().unwrap().active_runs -= 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn temporary_server_waits_for_all_clients_and_runs() {
        let lifetime = ServerLifetime::new(true);
        let first = uuid::Uuid::new_v4().to_string();
        let second = uuid::Uuid::new_v4().to_string();
        lifetime.connect(&first, "a").unwrap();
        lifetime.connect(&second, "b").unwrap();
        let run = lifetime.run_guard().unwrap();
        lifetime.release(&first, "a").unwrap();
        assert!(!lifetime.tick(Instant::now()).0);
        lifetime.release(&second, "b").unwrap();
        assert!(!lifetime.tick(Instant::now()).0);
        drop(run);
        assert!(lifetime.tick(Instant::now()).0);
        assert!(lifetime.connect(&first, "a").is_err());
    }

    #[test]
    fn lost_clients_cancel_their_run_but_not_the_shared_server() {
        let lifetime = ServerLifetime::new(false);
        let id = uuid::Uuid::new_v4().to_string();
        lifetime.connect(&id, "a").unwrap();
        let client = lifetime.client(&id, "a").unwrap();
        assert!(lifetime.client(&id, "b").is_err());
        let (stop, expired) = lifetime.tick(Instant::now() + CLIENT_GRACE);
        assert!(!stop);
        assert_eq!(expired, ["a"]);
        assert!(client.cancellation.is_cancelled());
        assert!(lifetime.client(&id, "a").is_err());
    }
}
