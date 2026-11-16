use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::{Mutex, watch};

use crate::native_auth::NativeAuthManager;
use crate::transcript_client::UserConvexClient;

/// Every caller shares one Convex connection per user instead of paying for its own handshake.
pub struct ConvexClients {
    deployment_url: String,
    native_auth: Arc<NativeAuthManager>,
    cache: Mutex<Cache>,
}

struct Cache {
    session_changes: watch::Receiver<u64>,
    clients: HashMap<String, UserConvexClient>,
}

impl ConvexClients {
    pub fn new(deployment_url: String, native_auth: Arc<NativeAuthManager>) -> Arc<Self> {
        let session_changes = native_auth.subscribe_changes();
        Arc::new(Self {
            deployment_url,
            native_auth,
            cache: Mutex::new(Cache {
                session_changes,
                clients: HashMap::new(),
            }),
        })
    }

    pub fn deployment_url(&self) -> &str {
        &self.deployment_url
    }

    pub async fn client_for(&self, user_id: &str) -> anyhow::Result<UserConvexClient> {
        let mut cache = self.cache.lock().await;
        // After a sign-out the SDK falls back to anonymous and only asks for a token again on
        // reconnect, so a client from an earlier session can stay signed out for good.
        if cache.session_changes.has_changed().unwrap_or(false) {
            cache.session_changes.borrow_and_update();
            cache.clients.clear();
        }
        if let Some(client) = cache.clients.get(user_id)
            && !client.is_closed().await
        {
            return Ok(client.clone());
        }
        let client = UserConvexClient::connect_with_fetcher(
            &self.deployment_url,
            self.native_auth
                .auth_token_fetcher_for_user(user_id.to_owned()),
        )
        .await?;
        cache.clients.insert(user_id.to_owned(), client.clone());
        Ok(client)
    }
}
