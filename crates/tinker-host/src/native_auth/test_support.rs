use super::*;

struct EmptyRefreshTokenStore;

impl RefreshTokenStore for EmptyRefreshTokenStore {
    fn load(&self) -> anyhow::Result<Option<String>> {
        Ok(None)
    }

    fn save(&self, _refresh_token: &str) -> anyhow::Result<CredentialStore> {
        Ok(CredentialStore::Keyring)
    }

    fn clear(&self) -> anyhow::Result<()> {
        Ok(())
    }
}

impl NativeAuthManager {
    pub(super) fn with_client(
        client: WorkOsClient,
        callback_url: String,
        refresh_tokens: Arc<dyn RefreshTokenStore>,
    ) -> Arc<Self> {
        let client_cell = OnceCell::new();
        assert!(client_cell.set(client).is_ok());
        Arc::new(Self {
            changes: watch::channel(0).0,
            browser_sessions: None,
            deployment_url: None,
            client: client_cell,
            callback_url,
            refresh_tokens,
            credential_operation: Mutex::new(()),
            session: Mutex::new(NativeSession::default()),
        })
    }

    pub(super) fn with_store(
        config: NativeAuthConfig,
        callback_url: String,
        refresh_tokens: Arc<dyn RefreshTokenStore>,
    ) -> Arc<Self> {
        let client = WorkOsClient::builder()
            .client_id(config.workos_client_id)
            .build();
        Self::with_client(client, callback_url, refresh_tokens)
    }

    pub fn configured_for_test(config: NativeAuthConfig, callback_url: String) -> Arc<Self> {
        Self::with_store(config, callback_url, Arc::new(EmptyRefreshTokenStore))
    }

    pub async fn authenticate_for_test(&self, user_id: &str) {
        let mut session = self.session.lock().await;
        session.access_token = Some(AccessToken {
            value: "test-access-token".to_string(),
            expires_at: unix_time_secs() + 3_600,
        });
        session.user = Some(NativeUser {
            id: user_id.to_string(),
            email: "test@example.com".to_string(),
            first_name: None,
            last_name: None,
            profile_picture_url: None,
        });
    }

    pub async fn expire_login_for_test(&self, session_token: &str) {
        let mut session = self.session.lock().await;
        let Some(state) = session.pending.by_session.get(session_token).cloned() else {
            return;
        };
        if let Some(pending) = session.pending.by_state.get_mut(&state) {
            pending.created_at = Instant::now() - LOGIN_ATTEMPT_TTL - Duration::from_secs(1);
        }
    }
}
