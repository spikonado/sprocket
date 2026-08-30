use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, bail};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use tokio::time::sleep;
use uuid::Uuid;

use crate::Client;

pub const SESSION_CREDENTIAL_REFRESH: Duration = Duration::from_secs(5 * 60);
const SESSION_CREDENTIAL_RETRY: Duration = Duration::from_secs(15);

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct SessionTicket {
    pub session_id: String,
    pub user_id: String,
    pub current: String,
    pub next: String,
}

pub type SessionSnapshot = SessionTicket;

#[derive(Clone)]
struct CredentialState {
    ticket: SessionTicket,
    generation: u64,
}

#[derive(Clone)]
pub struct SessionCredentialProvider {
    state: Arc<Mutex<CredentialState>>,
    persist_path: Option<Arc<PathBuf>>,
    client: Arc<Client>,
}

impl SessionCredentialProvider {
    pub fn from_snapshot(
        client: Arc<Client>,
        snapshot: SessionSnapshot,
        persist_path: Option<PathBuf>,
    ) -> Self {
        Self {
            state: Arc::new(Mutex::new(CredentialState {
                ticket: snapshot,
                generation: 0,
            })),
            persist_path: persist_path.map(Arc::new),
            client,
        }
    }

    pub async fn load_persist(path: &Path) -> Option<SessionSnapshot> {
        let contents = tokio::fs::read_to_string(path).await.ok()?;
        serde_json::from_str(contents.trim()).ok()
    }

    pub async fn replace(&self, snapshot: SessionSnapshot) -> anyhow::Result<()> {
        {
            let mut state = self.state.lock().await;
            state.ticket = snapshot;
            state.generation = state.generation.wrapping_add(1);
        }
        self.persist_now().await
    }

    pub async fn persist_now(&self) -> anyhow::Result<()> {
        let Some(path) = &self.persist_path else {
            return Ok(());
        };
        let ticket = self.current_ticket().await;
        let data = serde_json::to_vec_pretty(&ticket).context("serialize session credential")?;
        write_private_file(path, &data).await
    }

    pub async fn current_ticket(&self) -> SessionTicket {
        self.state.lock().await.ticket.clone()
    }

    pub async fn run_rotator(self) -> anyhow::Result<()> {
        sleep(SESSION_CREDENTIAL_REFRESH).await;
        loop {
            match self.rotate_once().await {
                Ok(()) => sleep(SESSION_CREDENTIAL_REFRESH).await,
                Err(error) => {
                    tracing::warn!("session credential rotation failed: {error:#}");
                    sleep(SESSION_CREDENTIAL_RETRY).await;
                }
            }
        }
    }

    async fn rotate_once(&self) -> anyhow::Result<()> {
        let state = self.state.lock().await.clone();
        let mut args = std::collections::BTreeMap::new();
        args.insert("ticket".to_string(), session_ticket_value(&state.ticket));
        match self
            .client
            .mutation("sessionCredentials:rotate", args)
            .await
        {
            Ok(convex::FunctionResult::Value(_)) => {}
            Ok(convex::FunctionResult::ErrorMessage(message)) => {
                bail!("rotate rejected: {message}")
            }
            Ok(convex::FunctionResult::ConvexError(error)) => {
                bail!("rotate convex error: {}", error.message)
            }
            Err(error) => return Err(error).context("sessionCredentials:rotate"),
        }

        {
            let mut current = self.state.lock().await;
            if current.generation != state.generation || current.ticket != state.ticket {
                return Ok(());
            }
            current.ticket = SessionTicket {
                session_id: state.ticket.session_id,
                user_id: state.ticket.user_id,
                current: state.ticket.next,
                next: Uuid::new_v4().to_string(),
            };
            current.generation = current.generation.wrapping_add(1);
        }
        if let Err(error) = self.persist_now().await {
            tracing::warn!("failed to persist rotated session credential: {error:#}");
        }
        Ok(())
    }
}

async fn write_private_file(path: &Path, data: &[u8]) -> anyhow::Result<()> {
    let temporary = path.with_extension(format!("tmp-{}", Uuid::new_v4()));
    let mut options = tokio::fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .await
        .with_context(|| format!("create {}", temporary.display()))?;
    let result = async {
        use tokio::io::AsyncWriteExt;
        file.write_all(data).await?;
        file.sync_all().await?;
        tokio::fs::rename(&temporary, path).await?;
        anyhow::Ok(())
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&temporary).await;
    }
    result.with_context(|| format!("persist session credential to {}", path.display()))
}

pub fn session_proof_value(ticket: &SessionTicket) -> convex::Value {
    let mut map = std::collections::BTreeMap::new();
    map.insert("sessionId".to_string(), ticket.session_id.clone().into());
    map.insert("userId".to_string(), ticket.user_id.clone().into());
    map.insert("current".to_string(), ticket.current.clone().into());
    convex::Value::Object(map)
}

pub fn session_ticket_value(ticket: &SessionTicket) -> convex::Value {
    let mut map = std::collections::BTreeMap::new();
    let convex::Value::Object(mut fields) = session_proof_value(ticket) else {
        unreachable!("session proof is an object");
    };
    map.append(&mut fields);
    map.insert("next".to_string(), ticket.next.clone().into());
    convex::Value::Object(map)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ticket_value_uses_convex_field_names() {
        let ticket = SessionTicket {
            session_id: "session".to_string(),
            user_id: "owner".to_string(),
            current: "current".to_string(),
            next: "next".to_string(),
        };
        let proof = session_proof_value(&ticket);
        let convex::Value::Object(proof_fields) = &proof else {
            panic!("proof should be an object");
        };
        assert!(proof_fields.get("next").is_none());
        let value = session_ticket_value(&ticket);
        let convex::Value::Object(fields) = value else {
            panic!("ticket should be an object");
        };
        assert_eq!(
            fields.get("sessionId"),
            Some(&convex::Value::String("session".into()))
        );
        assert_eq!(
            fields.get("userId"),
            Some(&convex::Value::String("owner".into()))
        );
        assert_eq!(
            fields.get("current"),
            Some(&convex::Value::String("current".into()))
        );
        assert_eq!(
            fields.get("next"),
            Some(&convex::Value::String("next".into()))
        );
    }
}
