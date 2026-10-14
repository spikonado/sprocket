use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use axum::Json;
use axum::http::StatusCode;
use axum::routing::post;

use super::*;

impl NativeAuthManager {
    async fn access_token(self: &Arc<Self>, force_refresh: bool) -> anyhow::Result<String> {
        self.browser_session(force_refresh)
            .await?
            .map(|session| session.access_token)
            .context(NATIVE_SESSION_SIGNED_OUT)
    }

    async fn remote_device_status(&self, session_token: &str) -> NativeLoginStatus {
        let session = self.session.lock().await;
        let Some(attempt) = session.remote_devices.get(session_token) else {
            return NativeLoginStatus::SignedOut;
        };
        match &attempt.result {
            None => NativeLoginStatus::Pending,
            Some(Ok(user)) => NativeLoginStatus::Authenticated { user: user.clone() },
            Some(Err(error)) => NativeLoginStatus::Failed {
                error: error.clone(),
            },
        }
    }
}

#[derive(Default)]
struct MemoryRefreshTokenStore {
    token: std::sync::Mutex<Option<String>>,
    fail_save: AtomicBool,
    fail_clear: AtomicBool,
    fail_load: AtomicBool,
}

impl MemoryRefreshTokenStore {
    fn empty() -> Arc<Self> {
        Arc::new(Self::default())
    }

    fn with_token(token: &str) -> Arc<Self> {
        Arc::new(Self {
            token: std::sync::Mutex::new(Some(token.to_string())),
            fail_save: AtomicBool::new(false),
            fail_clear: AtomicBool::new(false),
            fail_load: AtomicBool::new(false),
        })
    }

    fn token(&self) -> Option<String> {
        self.token.lock().unwrap().clone()
    }
}

impl RefreshTokenStore for MemoryRefreshTokenStore {
    fn load(&self) -> anyhow::Result<Option<String>> {
        if self.fail_load.load(Ordering::SeqCst) {
            anyhow::bail!("credential store unavailable");
        }
        Ok(self.token())
    }

    fn save(&self, refresh_token: &str) -> anyhow::Result<()> {
        if self.fail_save.load(Ordering::SeqCst) {
            anyhow::bail!("credential store unavailable");
        }
        *self.token.lock().unwrap() = Some(refresh_token.to_string());
        Ok(())
    }

    fn clear(&self) -> anyhow::Result<()> {
        if self.fail_clear.load(Ordering::SeqCst) {
            anyhow::bail!("credential deletion failed");
        }
        *self.token.lock().unwrap() = None;
        Ok(())
    }
}

fn access_token(expires_at: u64) -> String {
    let claims = URL_SAFE_NO_PAD.encode(format!(r#"{{"exp":{expires_at}}}"#));
    format!("e30.{claims}.signature")
}

fn native_user() -> NativeUser {
    NativeUser {
        id: "user_123".to_string(),
        email: "ada@example.com".to_string(),
        first_name: Some("Ada".to_string()),
        last_name: Some("Lovelace".to_string()),
        profile_picture_url: None,
    }
}

fn authentication_response(access_token: String, refresh_token: &str) -> AuthenticateResponse {
    serde_json::from_value(serde_json::json!({
        "user": {
            "object": "user",
            "id": "user_123",
            "first_name": "Ada",
            "last_name": "Lovelace",
            "profile_picture_url": null,
            "email": "ada@example.com",
            "email_verified": true,
            "external_id": null,
            "metadata": null,
            "last_sign_in_at": null,
            "locale": null,
            "created_at": "2025-01-01T00:00:00Z",
            "updated_at": "2025-01-01T00:00:00Z"
        },
        "organization_id": null,
        "authkit_authorization_code": null,
        "access_token": access_token,
        "refresh_token": refresh_token,
        "authentication_method": null,
        "impersonator": null,
        "oauth_tokens": null
    }))
    .expect("authentication response")
}

async fn manager_with_handler<H>(
    store: Arc<MemoryRefreshTokenStore>,
    handler: H,
) -> Arc<NativeAuthManager>
where
    H: Fn(serde_json::Value) -> (StatusCode, serde_json::Value) + Clone + Send + Sync + 'static,
{
    manager_with_delayed_handler(store, Duration::ZERO, handler).await
}

async fn manager_with_delayed_handler<H>(
    store: Arc<MemoryRefreshTokenStore>,
    delay: Duration,
    handler: H,
) -> Arc<NativeAuthManager>
where
    H: Fn(serde_json::Value) -> (StatusCode, serde_json::Value) + Clone + Send + Sync + 'static,
{
    let app = axum::Router::new().route("/user_management/authorize/device", post(|| async {
        Json(serde_json::json!({
            "device_code": "private-device-code", "user_code": "ABCD-EFGH",
            "verification_uri": "https://auth.example.test/device", "expires_in": 300, "interval": 1
        }))
    })).route(
        "/user_management/authenticate",
        post(move |Json(body): Json<serde_json::Value>| {
            let handler = handler.clone();
            async move {
                if !delay.is_zero() {
                    tokio::time::sleep(delay).await;
                }
                let (status, body) = handler(body);
                (status, Json(body))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("mock listener");
    let address = listener.local_addr().expect("mock address");
    tokio::spawn(async move {
        axum::serve(listener, app)
            .await
            .expect("mock WorkOS server");
    });
    let client = WorkOsClient::builder()
        .client_id("client_test")
        .base_url(format!("http://{address}"))
        .build();
    NativeAuthManager::with_client(client, "http://127.0.0.1/callback".to_string(), store)
}

async fn manager_with_response(
    store: Arc<MemoryRefreshTokenStore>,
    status: StatusCode,
    body: serde_json::Value,
) -> Arc<NativeAuthManager> {
    manager_with_handler(store, move |_| (status, body.clone())).await
}

async fn wait_for_remote_device_status(
    manager: &Arc<NativeAuthManager>,
    session_token: &str,
) -> NativeLoginStatus {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let status = manager.remote_device_status(session_token).await;
            if !matches!(status, NativeLoginStatus::Pending) {
                return status;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("remote device login should finish")
}

#[tokio::test]
async fn credential_selection_cannot_skip_a_persisted_login() {
    let store = MemoryRefreshTokenStore::with_token("persisted");
    let manager =
        manager_with_response(store.clone(), StatusCode::OK, serde_json::Value::Null).await;
    let error = manager
        .select_credential_store(crate::cli_protocol::CredentialStore::File)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("sign out"));
    assert_eq!(store.token().as_deref(), Some("persisted"));
}

#[tokio::test]
async fn accepting_a_login_invalidates_other_pending_browser_and_device_flows() {
    let manager = manager_with_response(
        MemoryRefreshTokenStore::empty(),
        StatusCode::BAD_REQUEST,
        serde_json::Value::Null,
    )
    .await;
    let pending = manager
        .start_login("browser", NativeLoginFlow::SignIn)
        .await
        .unwrap();
    manager.start_device_login("cli".into()).await.unwrap();
    let generation = manager.session.lock().await.login_generation;
    manager
        .accept_login(authentication_response(
            access_token(unix_time_secs() + 3600),
            "fresh",
        ))
        .await
        .unwrap();
    assert!(
        manager
            .complete_login("stale", &pending.login_id)
            .await
            .is_err()
    );
    assert!(matches!(
        manager.device_status("cli").await,
        NativeLoginStatus::Failed { .. }
    ));
    assert_ne!(manager.session.lock().await.login_generation, generation);
}

fn config_result(client_id: Value) -> FunctionResult {
    FunctionResult::Value(Value::Object(BTreeMap::from([(
        "workosClientId".to_string(),
        client_id,
    )])))
}

#[tokio::test]
async fn device_login_uses_the_shared_session_and_never_discloses_the_device_secret() {
    let store = MemoryRefreshTokenStore::empty();
    let response = serde_json::to_value(authentication_response(
        access_token(unix_time_secs() + 3600),
        "device-refresh",
    ))
    .unwrap();
    let mut manager = manager_with_response(store.clone(), StatusCode::OK, response).await;
    let directory = tempfile::tempdir().unwrap();
    let local = crate::auth::AuthState::load(directory.path()).unwrap();
    let (_, browser_session) = local.bootstrap_browser_session(true).await.unwrap();
    Arc::get_mut(&mut manager).unwrap().local_sessions = Some(Arc::clone(&local));
    let mut changes = manager.subscribe_changes();
    let login = manager
        .start_device_login("cli-session".into())
        .await
        .unwrap();
    assert!(
        !serde_json::to_string(&login)
            .unwrap()
            .contains("private-device-code")
    );
    tokio::time::timeout(Duration::from_secs(5), changes.changed())
        .await
        .unwrap()
        .unwrap();
    let session = manager.browser_session(false).await.unwrap().unwrap();
    local
        .bind_session_user(&browser_session, &session.user.id)
        .await
        .unwrap();
    assert_eq!(
        store.token.lock().unwrap().as_deref(),
        Some("device-refresh")
    );
    assert!(
        matches!(manager.device_status("cli-session").await, NativeLoginStatus::Authenticated { user } if user.id == session.user.id)
    );
    manager.sign_out().await.unwrap();
    assert!(manager.browser_session(false).await.unwrap().is_none());
    assert!(!local.session_has_user(&browser_session).await);
}

#[tokio::test]
async fn remote_device_login_matches_the_host_owner_without_replacing_its_credentials() {
    let store = MemoryRefreshTokenStore::empty();
    let response = serde_json::to_value(authentication_response(
        access_token(unix_time_secs() + 7_200),
        "remote-refresh",
    ))
    .unwrap();
    let mut manager = manager_with_response(store.clone(), StatusCode::OK, response).await;
    let directory = tempfile::tempdir().unwrap();
    let local = crate::auth::AuthState::load(directory.path()).unwrap();
    let (_, browser_session) = local.bootstrap_browser_session(false).await.unwrap();
    Arc::get_mut(&mut manager).unwrap().local_sessions = Some(Arc::clone(&local));
    manager.authenticate_for_test("user_123").await;

    let login = manager
        .start_remote_device_login(browser_session.clone())
        .await
        .unwrap();
    assert!(login.authorization_url.contains("ABCD-EFGH"));
    assert!(matches!(
        wait_for_remote_device_status(&manager, &browser_session).await,
        NativeLoginStatus::Authenticated { user } if user.id == "user_123"
    ));
    assert!(matches!(
        manager
            .complete_remote_device_login(&browser_session)
            .await
            .unwrap(),
        NativeLoginStatus::Authenticated { user } if user.id == "user_123"
    ));
    local
        .require_session_user(&browser_session, "user_123")
        .await
        .unwrap();
    assert!(matches!(
        manager.remote_device_status(&browser_session).await,
        NativeLoginStatus::SignedOut
    ));

    let host = manager.browser_session(false).await.unwrap().unwrap();
    assert_eq!(host.user.id, "user_123");
    assert_eq!(host.access_token, "test-access-token");
    assert_eq!(store.token(), None);
}

#[tokio::test]
async fn remote_device_login_rejects_another_account_without_changing_the_host_owner() {
    let store = MemoryRefreshTokenStore::empty();
    let mut response = serde_json::to_value(authentication_response(
        access_token(unix_time_secs() + 7_200),
        "remote-refresh",
    ))
    .unwrap();
    response["user"]["id"] = serde_json::Value::String("user_other".into());
    let manager = manager_with_response(store.clone(), StatusCode::OK, response).await;
    manager.authenticate_for_test("user_123").await;

    manager
        .start_remote_device_login("browser-session".into())
        .await
        .unwrap();
    assert!(matches!(
        wait_for_remote_device_status(&manager, "browser-session").await,
        NativeLoginStatus::Failed { error } if error.contains("same account")
    ));

    let host = manager.browser_session(false).await.unwrap().unwrap();
    assert_eq!(host.user.id, "user_123");
    assert_eq!(host.access_token, "test-access-token");
    assert_eq!(store.token(), None);
}

#[tokio::test]
async fn remote_device_login_fails_if_the_host_owner_changes_while_polling() {
    let store = MemoryRefreshTokenStore::empty();
    let response = serde_json::to_value(authentication_response(
        access_token(unix_time_secs() + 7_200),
        "remote-refresh",
    ))
    .unwrap();
    let manager =
        manager_with_delayed_handler(store.clone(), Duration::from_millis(100), move |_| {
            (StatusCode::OK, response.clone())
        })
        .await;
    manager.authenticate_for_test("user_123").await;
    manager
        .start_remote_device_login("browser-session".into())
        .await
        .unwrap();

    manager.authenticate_for_test("user_other").await;

    assert!(matches!(
        wait_for_remote_device_status(&manager, "browser-session").await,
        NativeLoginStatus::Failed { error } if error.contains("same account")
    ));
    let host = manager.browser_session(false).await.unwrap().unwrap();
    assert_eq!(host.user.id, "user_other");
    assert_eq!(store.token(), None);
}

#[tokio::test]
async fn host_sign_out_cancels_remote_device_login() {
    let store = MemoryRefreshTokenStore::empty();
    let response = serde_json::to_value(authentication_response(
        access_token(unix_time_secs() + 7_200),
        "remote-refresh",
    ))
    .unwrap();
    let manager = manager_with_delayed_handler(store, Duration::from_secs(1), move |_| {
        (StatusCode::OK, response.clone())
    })
    .await;
    manager.authenticate_for_test("user_123").await;
    manager
        .start_remote_device_login("browser-session".into())
        .await
        .unwrap();

    manager.sign_out().await.unwrap();

    assert!(matches!(
        manager.remote_device_status("browser-session").await,
        NativeLoginStatus::SignedOut
    ));
}

#[tokio::test]
async fn remote_device_login_limit_counts_only_active_attempts_when_full() {
    let response = serde_json::to_value(authentication_response(
        access_token(unix_time_secs() + 7_200),
        "remote-refresh",
    ))
    .unwrap();
    let manager = manager_with_delayed_handler(
        MemoryRefreshTokenStore::empty(),
        Duration::from_secs(2),
        move |_| (StatusCode::OK, response.clone()),
    )
    .await;
    manager.authenticate_for_test("user_123").await;
    for index in 0..32 {
        manager
            .start_remote_device_login(format!("browser-{index}"))
            .await
            .unwrap();
    }

    assert!(
        manager
            .start_remote_device_login("one-too-many".into())
            .await
            .unwrap_err()
            .to_string()
            .contains("too many remote sign-ins")
    );

    manager.cancel_remote_device_login("browser-0", None).await;
    manager
        .start_remote_device_login("replacement".into())
        .await
        .unwrap();
    for index in 1..32 {
        manager
            .cancel_remote_device_login(&format!("browser-{index}"), None)
            .await;
    }
    manager
        .cancel_remote_device_login("replacement", None)
        .await;
}

#[tokio::test]
async fn cancelled_device_login_cannot_restore_a_session() {
    let store = MemoryRefreshTokenStore::empty();
    let manager = manager_with_response(
        store.clone(),
        StatusCode::BAD_REQUEST,
        serde_json::json!({"error": "authorization_pending"}),
    )
    .await;
    manager
        .start_device_login("cli-session".into())
        .await
        .unwrap();
    manager.cancel_device_login("cli-session").await;
    assert!(matches!(
        manager.device_status("cli-session").await,
        NativeLoginStatus::SignedOut
    ));
    assert!(store.token.lock().unwrap().is_none());
}

#[tokio::test]
async fn loads_and_normalizes_client_id() {
    let config =
        load_from_query(|| async { Ok(config_result(Value::String(" client_123 ".to_string()))) })
            .await
            .expect("valid configuration");

    assert_eq!(config.workos_client_id, "client_123");
}

#[tokio::test]
async fn rejects_empty_client_id() {
    let error = load_from_query(|| async { Ok(config_result(Value::String("  ".to_string()))) })
        .await
        .expect_err("empty client ID must fail");

    assert!(error.to_string().contains("empty WorkOS client ID"));
}

#[tokio::test]
async fn rejects_malformed_configuration() {
    let error =
        load_from_query(|| async { Ok(FunctionResult::Value(Value::Object(BTreeMap::new()))) })
            .await
            .expect_err("missing client ID must fail");

    assert!(error.to_string().contains("malformed"));
}

#[tokio::test]
async fn preserves_convex_query_failures() {
    let error = load_from_query(|| async {
        Ok(FunctionResult::ErrorMessage(
            "deployment unavailable".to_string(),
        ))
    })
    .await
    .expect_err("query failure must fail");

    assert_eq!(
        error.to_string(),
        "authBootstrap:getClientConfig: deployment unavailable"
    );
}

#[tokio::test]
async fn refresh_resumes_a_persisted_session_and_rotates_the_token() {
    let store = MemoryRefreshTokenStore::with_token("refresh-old");
    let expected_access_token = access_token(unix_time_secs() + 3_600);
    let manager = manager_with_response(
        Arc::clone(&store),
        StatusCode::OK,
        serde_json::to_value(authentication_response(
            expected_access_token.clone(),
            "refresh-new",
        ))
        .unwrap(),
    )
    .await;

    let session = manager
        .browser_session(false)
        .await
        .unwrap()
        .expect("persisted WorkOS session resumes");
    assert_eq!(session.access_token, expected_access_token);
    assert_eq!(session.user, native_user());
    assert!(matches!(
        manager.status("paired-session").await,
        NativeLoginStatus::Authenticated { .. }
    ));
    assert_eq!(store.token().as_deref(), Some("refresh-new"));
}

#[tokio::test]
async fn require_user_rejects_a_different_native_identity() {
    let manager = manager_with_response(
        MemoryRefreshTokenStore::with_token("refresh-old"),
        StatusCode::OK,
        serde_json::to_value(authentication_response(
            access_token(unix_time_secs() + 3_600),
            "refresh-new",
        ))
        .unwrap(),
    )
    .await;

    manager.require_user("user_123").await.unwrap();
    assert_eq!(
        manager
            .require_user("user_456")
            .await
            .unwrap_err()
            .to_string(),
        "native and browser sessions belong to different users"
    );
}

#[tokio::test]
async fn user_bound_fetcher_rejects_an_account_transition() {
    let manager = Arc::new(
        manager_with_response(
            MemoryRefreshTokenStore::with_token("refresh-old"),
            StatusCode::OK,
            serde_json::to_value(authentication_response(
                access_token(unix_time_secs() + 3_600),
                "refresh-new",
            ))
            .unwrap(),
        )
        .await,
    );
    let fetcher = manager.auth_token_fetcher_for_user("user_123".to_string());

    fetcher(false).await.unwrap();
    manager.session.lock().await.user.as_mut().unwrap().id = "user_456".to_string();

    assert_eq!(
        fetcher(false).await.unwrap_err().to_string(),
        "native and browser sessions belong to different users"
    );
}

#[tokio::test]
async fn signed_out_fetcher_returns_a_terminal_auth_error() {
    let manager = NativeAuthManager::configured_for_test(
        NativeAuthConfig {
            workos_client_id: "client_test".to_string(),
        },
        "http://127.0.0.1/callback".to_string(),
    );
    let fetcher = manager.auth_token_fetcher_for_user("user_123".to_string());
    assert!(fetcher(false).await.unwrap_err().is::<AuthSignedOut>());
}

#[tokio::test]
async fn authorization_code_exchange_installs_the_native_session() {
    let store = MemoryRefreshTokenStore::with_token("refresh-old");
    let expected_access_token = access_token(unix_time_secs() + 3_600);
    let manager = manager_with_response(
        Arc::clone(&store),
        StatusCode::OK,
        serde_json::to_value(authentication_response(
            expected_access_token.clone(),
            "refresh-new",
        ))
        .unwrap(),
    )
    .await;
    let login = manager
        .start_login("paired-session", NativeLoginFlow::SignIn)
        .await
        .unwrap();

    let (user, session_token) = manager
        .complete_login("authorization-code", &login.login_id)
        .await
        .unwrap();

    assert_eq!(user.id, "user_123");
    assert_eq!(session_token, "paired-session");
    assert_eq!(store.token().as_deref(), Some("refresh-new"));
    assert_eq!(
        manager.access_token(false).await.unwrap(),
        expected_access_token
    );
}

#[tokio::test]
async fn failed_login_persistence_does_not_change_local_sessions() {
    let store = MemoryRefreshTokenStore::with_token("refresh-old");
    let mut manager = manager_with_response(
        Arc::clone(&store),
        StatusCode::BAD_REQUEST,
        serde_json::Value::Null,
    )
    .await;
    let directory = tempfile::tempdir().unwrap();
    let local = crate::auth::AuthState::load(directory.path()).unwrap();
    let (_, local_session) = local.bootstrap_browser_session(true).await.unwrap();
    local
        .bind_session_user(&local_session, "user_old")
        .await
        .unwrap();
    Arc::get_mut(&mut manager).unwrap().local_sessions = Some(Arc::clone(&local));
    let changes = manager.subscribe_changes();
    let login_generation = manager.session.lock().await.login_generation;
    store.fail_save.store(true, Ordering::SeqCst);

    let error = manager
        .accept_login(authentication_response(
            access_token(unix_time_secs() + 3_600),
            "refresh-new",
        ))
        .await
        .expect_err("failed persistence must reject the login");

    assert!(error.to_string().contains("credential store unavailable"));
    assert_eq!(store.token().as_deref(), Some("refresh-old"));
    assert!(manager.session.lock().await.user.is_none());
    assert_eq!(
        manager.session.lock().await.login_generation,
        login_generation
    );
    assert!(!changes.has_changed().unwrap());
    local
        .require_session_user(&local_session, "user_old")
        .await
        .unwrap();
}

#[tokio::test]
async fn empty_persisted_refresh_token_is_rejected_without_network_io() {
    let store = MemoryRefreshTokenStore::with_token("   ");
    let manager = NativeAuthManager::with_store(
        NativeAuthConfig {
            workos_client_id: "client_test".to_string(),
        },
        "http://127.0.0.1/callback".to_string(),
        store,
    );

    let error = manager.access_token(false).await.unwrap_err();

    assert!(error.to_string().contains("refresh token is empty"));
}

#[tokio::test]
async fn persist_failure_keeps_the_rotated_refresh_token_in_memory() {
    let store = MemoryRefreshTokenStore::with_token("refresh-old");
    let manager = NativeAuthManager::with_store(
        NativeAuthConfig {
            workos_client_id: "client_test".to_string(),
        },
        "http://127.0.0.1/callback".to_string(),
        store.clone(),
    );
    store.fail_save.store(true, Ordering::SeqCst);
    let expected_access_token = access_token(unix_time_secs() + 3_600);

    let error = manager
        .accept_authentication(authentication_response(
            expected_access_token.clone(),
            "refresh-new",
        ))
        .await
        .expect_err("failed persistence must surface a store error");

    assert!(error.to_string().contains("credential store unavailable"));
    assert_eq!(store.token().as_deref(), Some("refresh-old"));
    assert_eq!(
        manager.session.lock().await.refresh_token.as_deref(),
        Some("refresh-new")
    );
    assert!(
        manager
            .browser_session(false)
            .await
            .expect_err("unpersisted rotation is unavailable, not signed out")
            .to_string()
            .contains("credential store unavailable")
    );

    store.fail_save.store(false, Ordering::SeqCst);
    let session = manager
        .browser_session(false)
        .await
        .expect("retrying persist must succeed without contacting WorkOS")
        .expect("session remains signed in");

    assert_eq!(session.access_token, expected_access_token);
    assert_eq!(session.user, native_user());
    assert_eq!(store.token().as_deref(), Some("refresh-new"));
}

#[tokio::test]
async fn invalid_grant_clears_the_persisted_session() {
    let store = MemoryRefreshTokenStore::with_token("expired-refresh");
    let manager = manager_with_response(
        Arc::clone(&store),
        StatusCode::BAD_REQUEST,
        serde_json::json!({
            "error": "invalid_grant",
            "error_description": "refresh token expired"
        }),
    )
    .await;

    assert!(manager.access_token(false).await.is_err());
    assert_eq!(store.token(), None);
}

#[tokio::test]
async fn transient_refresh_failure_retains_a_still_valid_token() {
    let store = MemoryRefreshTokenStore::with_token("refresh-current");
    let manager = manager_with_response(
        Arc::clone(&store),
        StatusCode::SERVICE_UNAVAILABLE,
        serde_json::json!({ "error": "unavailable" }),
    )
    .await;
    let current_access_token = access_token(unix_time_secs() + 30);
    manager
        .accept_authentication(authentication_response(
            current_access_token.clone(),
            "refresh-current",
        ))
        .await
        .unwrap();

    assert_eq!(
        manager.access_token(false).await.unwrap(),
        current_access_token
    );
    assert_eq!(store.token().as_deref(), Some("refresh-current"));
}

#[tokio::test]
async fn unexpected_refresh_failure_preserves_the_session_for_retry() {
    let store = MemoryRefreshTokenStore::with_token("refresh-current");
    let manager = manager_with_response(
        Arc::clone(&store),
        StatusCode::IM_A_TEAPOT,
        serde_json::json!({ "error": "unexpected" }),
    )
    .await;
    let current_access_token = access_token(unix_time_secs() + 30);
    manager
        .accept_authentication(authentication_response(
            current_access_token.clone(),
            "refresh-current",
        ))
        .await
        .unwrap();

    assert_eq!(
        manager.access_token(false).await.unwrap(),
        current_access_token
    );
    assert_eq!(store.token().as_deref(), Some("refresh-current"));
    assert!(matches!(
        manager.status("paired-session").await,
        NativeLoginStatus::Authenticated { .. }
    ));
}

#[tokio::test]
async fn forced_refresh_does_not_return_a_rejected_token_after_transient_failure() {
    let store = MemoryRefreshTokenStore::with_token("refresh-current");
    let manager = manager_with_response(
        Arc::clone(&store),
        StatusCode::SERVICE_UNAVAILABLE,
        serde_json::json!({ "error": "unavailable" }),
    )
    .await;
    manager
        .accept_authentication(authentication_response(
            access_token(unix_time_secs() + 3_600),
            "refresh-current",
        ))
        .await
        .unwrap();

    let current_access_token = manager
        .session
        .lock()
        .await
        .access_token
        .as_ref()
        .unwrap()
        .value
        .clone();
    assert!(manager.access_token(true).await.is_err());
    assert_eq!(
        manager.access_token(false).await.unwrap(),
        current_access_token
    );
    assert_eq!(store.token().as_deref(), Some("refresh-current"));
}

#[tokio::test]
async fn concurrent_fetches_share_one_refresh() {
    let store = MemoryRefreshTokenStore::with_token("refresh-current");
    let requests = Arc::new(AtomicUsize::new(0));
    let expected_access_token = access_token(unix_time_secs() + 3_600);
    let manager = Arc::new(
        manager_with_delayed_handler(store, Duration::from_millis(25), {
            let requests = Arc::clone(&requests);
            let expected_access_token = expected_access_token.clone();
            move |_| {
                requests.fetch_add(1, Ordering::SeqCst);
                (
                    StatusCode::OK,
                    serde_json::to_value(authentication_response(
                        expected_access_token.clone(),
                        "refresh-new",
                    ))
                    .unwrap(),
                )
            }
        })
        .await,
    );

    let first_manager = Arc::clone(&manager);
    let second_manager = Arc::clone(&manager);
    let (first, second) = tokio::join!(
        first_manager.access_token(false),
        second_manager.access_token(false)
    );

    assert_eq!(first.unwrap(), expected_access_token);
    assert_eq!(second.unwrap(), expected_access_token);
    assert_eq!(requests.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn cancelling_a_token_consumer_does_not_cancel_refresh_rotation() {
    let started = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let app = axum::Router::new().route(
        "/user_management/authenticate",
        post({
            let started = Arc::clone(&started);
            let release = Arc::clone(&release);
            move || {
                let started = Arc::clone(&started);
                let release = Arc::clone(&release);
                async move {
                    started.notify_one();
                    release.notified().await;
                    Json(authentication_response(
                        access_token(unix_time_secs() + 3_600),
                        "rotated",
                    ))
                }
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let store = MemoryRefreshTokenStore::with_token("old");
    let manager = NativeAuthManager::with_client(
        WorkOsClient::builder()
            .client_id("client_test")
            .base_url(format!("http://{address}"))
            .build(),
        "http://127.0.0.1/callback".to_string(),
        store.clone(),
    );
    let request = tokio::spawn({
        let manager = Arc::clone(&manager);
        async move { manager.browser_session(false).await }
    });
    timeout(Duration::from_secs(2), started.notified())
        .await
        .unwrap();
    request.abort();
    assert!(request.await.unwrap_err().is_cancelled());
    release.notify_one();
    let session = timeout(Duration::from_secs(2), manager.browser_session(false))
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(session.user, native_user());
    assert_eq!(store.token().as_deref(), Some("rotated"));
    server.abort();
}

#[tokio::test]
async fn sign_out_clears_memory_when_credential_deletion_fails() {
    let store = MemoryRefreshTokenStore::with_token("refresh-current");
    let manager = NativeAuthManager::with_store(
        NativeAuthConfig {
            workos_client_id: "client_test".to_string(),
        },
        "http://127.0.0.1/callback".to_string(),
        store.clone(),
    );
    manager
        .accept_authentication(authentication_response(
            access_token(unix_time_secs() + 3_600),
            "refresh-current",
        ))
        .await
        .unwrap();
    store.fail_clear.store(true, Ordering::SeqCst);

    assert!(manager.sign_out().await.is_err());
    assert!(manager.session.lock().await.user.is_none());
    assert!(manager.session.lock().await.access_token.is_none());
    assert!(manager.browser_session(false).await.unwrap().is_none());
}

#[tokio::test]
async fn browser_session_is_none_when_signed_out() {
    let manager = NativeAuthManager::with_store(
        NativeAuthConfig {
            workos_client_id: "client_test".to_string(),
        },
        "http://127.0.0.1/callback".to_string(),
        MemoryRefreshTokenStore::empty(),
    );

    assert!(manager.browser_session(false).await.unwrap().is_none());
    assert!(matches!(
        manager.status("paired-session").await,
        NativeLoginStatus::SignedOut
    ));
}

#[tokio::test]
async fn browser_session_is_none_after_a_terminal_refresh_failure() {
    let store = MemoryRefreshTokenStore::with_token("expired-refresh");
    let manager = manager_with_response(
        Arc::clone(&store),
        StatusCode::BAD_REQUEST,
        serde_json::json!({
            "error": "invalid_grant",
            "error_description": "refresh token expired"
        }),
    )
    .await;

    assert!(manager.browser_session(false).await.unwrap().is_none());
    assert_eq!(store.token(), None);
    assert!(matches!(
        manager.status("paired-session").await,
        NativeLoginStatus::SignedOut
    ));
}

#[tokio::test]
async fn browser_session_errors_when_the_credential_store_cannot_load() {
    let store = MemoryRefreshTokenStore::with_token("refresh-current");
    store.fail_load.store(true, Ordering::SeqCst);
    let manager = NativeAuthManager::with_store(
        NativeAuthConfig {
            workos_client_id: "client_test".to_string(),
        },
        "http://127.0.0.1/callback".to_string(),
        store,
    );

    assert!(
        manager
            .browser_session(false)
            .await
            .expect_err("store outage is transient")
            .to_string()
            .contains("credential store unavailable")
    );
    assert!(matches!(
        manager.status("paired-session").await,
        NativeLoginStatus::Unavailable { .. }
    ));
}

#[tokio::test]
async fn status_does_not_trust_a_stale_in_memory_user() {
    let manager = manager_with_response(
        MemoryRefreshTokenStore::with_token("expired-refresh"),
        StatusCode::BAD_REQUEST,
        serde_json::json!({
            "error": "invalid_grant",
            "error_description": "refresh token expired"
        }),
    )
    .await;
    {
        let mut session = manager.session.lock().await;
        session.user = Some(native_user());
        session.access_token = Some(AccessToken {
            value: access_token(unix_time_secs().saturating_sub(30)),
            expires_at: unix_time_secs().saturating_sub(30),
        });
    }

    assert!(matches!(
        manager.status("paired-session").await,
        NativeLoginStatus::SignedOut
    ));
    assert!(manager.browser_session(false).await.unwrap().is_none());
}

#[tokio::test]
async fn status_reports_unavailable_when_a_stale_user_cannot_refresh() {
    let manager = manager_with_response(
        MemoryRefreshTokenStore::with_token("refresh-current"),
        StatusCode::SERVICE_UNAVAILABLE,
        serde_json::json!({ "error": "unavailable" }),
    )
    .await;
    {
        let mut session = manager.session.lock().await;
        session.user = Some(native_user());
        session.access_token = Some(AccessToken {
            value: access_token(unix_time_secs().saturating_sub(30)),
            expires_at: unix_time_secs().saturating_sub(30),
        });
    }

    assert!(matches!(
        manager.status("paired-session").await,
        NativeLoginStatus::Unavailable { .. }
    ));
    assert!(manager.browser_session(false).await.is_err());
}

#[tokio::test]
async fn refresh_after_persist_failure_uses_the_rotated_token() {
    let store = MemoryRefreshTokenStore::with_token("refresh-old");
    let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
    let expected_access_token = access_token(unix_time_secs() + 3_600);
    let manager = manager_with_handler(Arc::clone(&store), {
        let seen = Arc::clone(&seen);
        let expected_access_token = expected_access_token.clone();
        move |body| {
            seen.lock().unwrap().push(
                body["refresh_token"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string(),
            );
            (
                StatusCode::OK,
                serde_json::to_value(authentication_response(
                    expected_access_token.clone(),
                    "refresh-newer",
                ))
                .unwrap(),
            )
        }
    })
    .await;
    store.fail_save.store(true, Ordering::SeqCst);
    manager
        .accept_authentication(authentication_response(
            access_token(unix_time_secs() + 30),
            "refresh-new",
        ))
        .await
        .expect_err("rotation must be remembered even when persist fails");
    store.fail_save.store(false, Ordering::SeqCst);

    let session = manager
        .browser_session(false)
        .await
        .unwrap()
        .expect("session recovers with the rotated refresh token");

    assert_eq!(session.access_token, expected_access_token);
    assert_eq!(seen.lock().unwrap().as_slice(), ["refresh-new"]);
    assert_eq!(store.token().as_deref(), Some("refresh-newer"));
}

#[tokio::test]
async fn queued_force_refresh_reuses_a_completed_rotation() {
    let store = MemoryRefreshTokenStore::with_token("refresh-current");
    let requests = Arc::new(AtomicUsize::new(0));
    let expected_access_token = access_token(unix_time_secs() + 3_600);
    let manager = manager_with_delayed_handler(Arc::clone(&store), Duration::from_millis(25), {
        let requests = Arc::clone(&requests);
        let expected_access_token = expected_access_token.clone();
        move |_| {
            requests.fetch_add(1, Ordering::SeqCst);
            (
                StatusCode::OK,
                serde_json::to_value(authentication_response(
                    expected_access_token.clone(),
                    "refresh-new",
                ))
                .unwrap(),
            )
        }
    })
    .await;
    manager
        .accept_authentication(authentication_response(
            access_token(unix_time_secs() + 3_600),
            "refresh-current",
        ))
        .await
        .unwrap();
    let manager = Arc::new(manager);

    let first_manager = Arc::clone(&manager);
    let second_manager = Arc::clone(&manager);
    let (first, second) = tokio::join!(
        first_manager.browser_session(true),
        second_manager.browser_session(true)
    );

    let first = first.unwrap().expect("forced refresh stays signed in");
    let second = second
        .unwrap()
        .expect("queued force refresh stays signed in");
    assert_eq!(first.access_token, expected_access_token);
    assert_eq!(second.access_token, expected_access_token);
    assert_eq!(requests.load(Ordering::SeqCst), 1);
    assert_eq!(store.token().as_deref(), Some("refresh-new"));
}
