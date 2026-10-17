#[test]
fn cancelled_request_keeps_session_writes_serialized_until_persistence_finishes() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .max_blocking_threads(1)
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let directory = tempfile::tempdir().unwrap();
        let state = super::AuthState::load(directory.path()).unwrap();
        let (release, blocked) = std::sync::mpsc::channel();
        let (ready, started) = tokio::sync::oneshot::channel();
        let blocker = tokio::task::spawn_blocking(move || {
            ready.send(()).unwrap();
            blocked.recv().unwrap();
        });
        started.await.unwrap();
        let (saving, queued) = tokio::sync::oneshot::channel();
        let writer = std::sync::Arc::clone(&state);
        let request = tokio::spawn(async move {
            let sessions = std::sync::Arc::clone(&writer.sessions).write_owned().await;
            saving.send(()).unwrap();
            writer.save_sessions(sessions).await
        });
        queued.await.unwrap();
        request.abort();
        let _ = request.await;
        let locked = state.sessions.try_write().is_err();
        release.send(()).unwrap();
        blocker.await.unwrap();
        let _finished = state.sessions.read().await;
        assert!(locked);
        assert!(directory.path().join(super::SESSIONS_FILE).is_file());
    });
}

use super::*;
use std::thread;

#[test]
fn reading_a_missing_pairing_credential_has_no_side_effects() {
    let temp_dir = std::env::temp_dir().join(format!("sprocket-auth-test-{}", Uuid::new_v4()));

    assert_eq!(read_pairing_credential(&temp_dir).unwrap(), None);
    assert!(!temp_dir.exists());
}

#[test]
fn exclusive_publish_does_not_replace_an_existing_credential() {
    let temp_dir = std::env::temp_dir().join(format!("sprocket-auth-link-{}", Uuid::new_v4()));
    fs::create_dir_all(&temp_dir).unwrap();
    let dest = temp_dir.join(PAIRING_CREDENTIAL_FILE);
    fs::write(&dest, "winner\n").unwrap();
    let tmp_path = temp_dir.join(format!("{PAIRING_CREDENTIAL_FILE}.loser.tmp"));
    fs::write(&tmp_path, "loser\n").unwrap();

    let error = publish_exclusive_file(&tmp_path, &dest).unwrap_err();
    assert_eq!(error.kind(), ErrorKind::AlreadyExists);
    assert_eq!(fs::read_to_string(&dest).unwrap(), "winner\n");

    let _ = fs::remove_dir_all(temp_dir);
}

#[test]
fn concurrent_first_load_shares_one_pairing_credential() {
    let temp_dir = std::env::temp_dir().join(format!("sprocket-auth-race-{}", Uuid::new_v4()));
    let joiners: Vec<_> = (0..8)
        .map(|_| {
            let dir = temp_dir.clone();
            thread::spawn(move || {
                AuthState::load(&dir)
                    .expect("auth state")
                    .pairing_credential()
                    .to_string()
            })
        })
        .collect();
    let credentials: Vec<_> = joiners
        .into_iter()
        .map(|worker| worker.join().expect("join"))
        .collect();
    let first = credentials[0].as_str();
    assert!(credentials.iter().all(|credential| credential == first));
    assert_eq!(
        read_pairing_credential(&temp_dir).unwrap().as_deref(),
        Some(first)
    );
    let _ = fs::remove_dir_all(temp_dir);
}

#[tokio::test]
async fn bootstrap_creates_authenticated_session() {
    let temp_dir = std::env::temp_dir().join(format!("sprocket-auth-test-{}", Uuid::new_v4()));
    let auth = AuthState::load(&temp_dir).expect("auth state");
    let (response, session_token) = auth
        .bootstrap_browser_session(true)
        .await
        .expect("bootstrap should succeed");
    assert!(response.authenticated);
    assert_eq!(response.role, "owner");

    let session = auth.session_state(Some(&session_token)).await;
    assert!(session.authenticated);

    let _ = fs::remove_dir_all(temp_dir);
}

#[tokio::test]
async fn bootstrap_persists_authenticated_session() {
    let temp_dir = std::env::temp_dir().join(format!("sprocket-auth-test-{}", Uuid::new_v4()));
    let auth = AuthState::load(&temp_dir).expect("auth state");
    let (_, session_token) = auth
        .bootstrap_browser_session(true)
        .await
        .expect("bootstrap should succeed");

    let reloaded = AuthState::load(&temp_dir).expect("reloaded auth state");
    let session = reloaded.session_state(Some(&session_token)).await;
    assert!(session.authenticated);

    let _ = fs::remove_dir_all(temp_dir);
}

#[tokio::test]
async fn bootstrap_evicts_unbound_then_oldest_bound_sessions_at_capacity() {
    let temp_dir = std::env::temp_dir().join(format!("sprocket-auth-test-{}", Uuid::new_v4()));
    let auth = AuthState::load(&temp_dir).expect("auth state");
    let now = sprocket_host::now_ms();
    {
        let mut sessions = auth.sessions.write().await;
        for index in 0..(MAX_PERSISTED_BROWSER_SESSIONS - 1) {
            sessions.insert(
                format!("bound-{index}"),
                SessionRecord {
                    ephemeral: false,
                    local_browser: false,
                    role: "owner".into(),
                    created_at: now.saturating_sub(10_000 - index as u64),
                    user_id: Some("user-1".into()),
                },
            );
        }
        sessions.insert(
            "unbound".into(),
            SessionRecord {
                ephemeral: false,
                local_browser: false,
                role: "owner".into(),
                created_at: now.saturating_sub(20_000),
                user_id: None,
            },
        );
    }

    let (_, first_new) = auth.bootstrap_browser_session(false).await.unwrap();
    assert!(!auth.session_state(Some("unbound")).await.authenticated);
    assert!(auth.session_state(Some("bound-0")).await.authenticated);

    auth.bind_session_user(&first_new, "user-1").await.unwrap();
    auth.bootstrap_browser_session(false).await.unwrap();
    assert!(!auth.session_state(Some("bound-0")).await.authenticated);
    assert!(auth.session_state(Some("bound-1")).await.authenticated);
    assert!(auth.session_state(Some(&first_new)).await.authenticated);

    let _ = fs::remove_dir_all(temp_dir);
}

#[tokio::test]
async fn ephemeral_cli_sessions_may_access_machine_routes_without_a_user() {
    let temp_dir = std::env::temp_dir().join(format!("sprocket-auth-test-{}", Uuid::new_v4()));
    let auth = AuthState::load(&temp_dir).expect("auth state");
    let token = Uuid::new_v4().to_string();
    auth.create_cli_session(token.clone()).await;
    let mut headers = HeaderMap::new();
    headers.insert(
        header::AUTHORIZATION,
        format!("Bearer {token}").parse().unwrap(),
    );

    assert_eq!(
        require_session(&auth, &headers, &CookieJar::new())
            .await
            .unwrap(),
        token
    );
    let _ = fs::remove_dir_all(temp_dir);
}

#[tokio::test]
async fn rejects_persisted_sessions_without_an_account_binding_field() {
    let temp_dir = std::env::temp_dir().join(format!("sprocket-auth-test-{}", Uuid::new_v4()));
    fs::create_dir_all(&temp_dir).unwrap();
    fs::write(
        temp_dir.join(SESSIONS_FILE),
        serde_json::json!([{
            "token": "old-session",
            "role": "owner",
            "createdAt": sprocket_host::now_ms()
        }])
        .to_string(),
    )
    .unwrap();

    let auth = AuthState::load(&temp_dir).expect("auth state");
    assert!(!auth.session_state(Some("old-session")).await.authenticated);

    let _ = fs::remove_dir_all(temp_dir);
}

#[tokio::test]
async fn account_scoped_access_requires_the_bound_session_user() {
    let temp_dir = std::env::temp_dir().join(format!("sprocket-auth-test-{}", Uuid::new_v4()));
    let auth = AuthState::load(&temp_dir).expect("auth state");
    let (_, session_token) = auth
        .bootstrap_browser_session(true)
        .await
        .expect("bootstrap should succeed");

    assert!(
        auth.require_session_user(&session_token, "user-1")
            .await
            .unwrap_err()
            .to_string()
            .contains("sign in again")
    );
    auth.bind_session_user(&session_token, "user-1")
        .await
        .unwrap();
    auth.require_session_user(&session_token, "user-1")
        .await
        .unwrap();
    assert_eq!(
        auth.require_session_user(&session_token, "user-2")
            .await
            .unwrap_err()
            .to_string(),
        "local session belongs to a different user"
    );
    assert_eq!(
        auth.bind_session_user(&session_token, "user-2")
            .await
            .unwrap_err()
            .to_string(),
        "local session belongs to a different user"
    );

    let reloaded = AuthState::load(&temp_dir).expect("reloaded auth state");
    reloaded
        .require_session_user(&session_token, "user-1")
        .await
        .unwrap();
    let _ = fs::remove_dir_all(temp_dir);
}

#[tokio::test]
async fn owner_changes_unbind_other_accounts_without_binding_new_sessions() {
    let directory = tempfile::tempdir().unwrap();
    let auth = AuthState::load(directory.path()).unwrap();
    let (_, bound) = auth.bootstrap_browser_session(true).await.unwrap();
    let (_, unbound) = auth.bootstrap_browser_session(true).await.unwrap();
    auth.bind_session_user(&bound, "user-1").await.unwrap();

    auth.sync_sessions_with_owner(Some("user-1")).await.unwrap();
    auth.require_session_user(&bound, "user-1").await.unwrap();
    assert!(!auth.session_has_user(&unbound).await);

    auth.sync_sessions_with_owner(Some("user-2")).await.unwrap();
    assert!(!auth.session_has_user(&bound).await);
    assert!(!auth.session_has_user(&unbound).await);
    auth.bind_session_user(&bound, "user-2").await.unwrap();

    auth.sync_sessions_with_owner(None).await.unwrap();
    assert!(!auth.session_has_user(&bound).await);
}

#[tokio::test]
async fn session_guard_serializes_sign_in_commit_with_logout() {
    let directory = tempfile::tempdir().unwrap();
    let auth = AuthState::load(directory.path()).unwrap();
    let (_, token) = auth.bootstrap_browser_session(true).await.unwrap();
    auth.bind_session_user(&token, "user-1").await.unwrap();
    let guard = auth.lock_session_user(&token, "user-1").await.unwrap();
    let logout = auth.end_session(&token);
    tokio::pin!(logout);
    assert!(futures::poll!(&mut logout).is_pending());
    drop(guard);
    logout.await.unwrap();
    assert!(auth.lock_session_user(&token, "user-1").await.is_err());
}

#[test]
fn peer_loopback_gate_uses_socket_address() {
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

    assert!(peer_may_complete_desktop_login_callback(SocketAddr::new(
        IpAddr::V4(Ipv4Addr::LOCALHOST),
        54321
    )));
    assert!(peer_may_complete_desktop_login_callback(SocketAddr::new(
        IpAddr::V4(Ipv4Addr::new(127, 0, 0, 42)),
        1
    )));
    assert!(peer_may_complete_desktop_login_callback(SocketAddr::new(
        IpAddr::V6(Ipv6Addr::LOCALHOST),
        1
    )));
    assert!(!peer_may_complete_desktop_login_callback(SocketAddr::new(
        IpAddr::V4(Ipv4Addr::new(192, 168, 1, 10)),
        54321
    )));
    assert!(!peer_may_complete_desktop_login_callback(SocketAddr::new(
        IpAddr::V4(Ipv4Addr::UNSPECIFIED),
        54321
    )));
}

#[test]
fn desktop_login_callback_url_uses_loopback() {
    assert_eq!(
        desktop_login_callback_url(7731),
        "http://127.0.0.1:7731/api/auth/desktop-login/callback"
    );
    assert!(host_supports_loopback_desktop_login("127.0.0.1"));
    assert!(host_supports_loopback_desktop_login("0.0.0.0"));
    assert!(!host_supports_loopback_desktop_login("localhost"));
    assert!(!host_supports_loopback_desktop_login("::"));
    assert!(!host_supports_loopback_desktop_login("[::]"));
    assert!(!host_supports_loopback_desktop_login("::1"));
    assert!(!host_supports_loopback_desktop_login("192.168.1.10"));
}

#[test]
fn origin_matching_rejects_cross_origin_and_missing_headers() {
    let mut headers = HeaderMap::new();
    assert!(!origin_matches_host(&headers));
    assert!(!origin_host_is_loopback(&headers));
    headers.insert(header::HOST, "127.0.0.1:7731".parse().unwrap());
    assert!(!origin_matches_host(&headers));
    assert!(cookie_get_is_csrf_safe(&headers));
    assert!(!cookie_request_is_csrf_safe(&headers));
    headers.insert(header::ORIGIN, "http://127.0.0.1:7731".parse().unwrap());
    assert!(origin_matches_host(&headers));
    assert!(origin_host_is_loopback(&headers));
    assert!(cookie_get_is_csrf_safe(&headers));
    assert!(cookie_request_is_csrf_safe(&headers));

    headers.insert(header::ORIGIN, "https://attacker.example".parse().unwrap());
    assert!(!origin_matches_host(&headers));
    assert!(!cookie_get_is_csrf_safe(&headers));
    assert!(!cookie_request_is_csrf_safe(&headers));

    headers.insert(header::ORIGIN, "null".parse().unwrap());
    assert!(!cookie_get_is_csrf_safe(&headers));

    headers.insert(header::HOST, "192.168.1.10:7731".parse().unwrap());
    headers.insert(header::ORIGIN, "http://192.168.1.10:7731".parse().unwrap());
    assert!(origin_matches_host(&headers));
    assert!(cookie_request_is_csrf_safe(&headers));
    assert!(!origin_host_is_loopback(&headers));

    headers.insert(header::AUTHORIZATION, "Bearer secret".parse().unwrap());
    assert!(cookie_request_is_csrf_safe(&headers));
}

#[test]
fn origin_matching_normalizes_default_ports_but_rejects_paths() {
    let mut headers = HeaderMap::new();
    headers.insert(header::HOST, "machine.example:443".parse().unwrap());
    headers.insert(header::ORIGIN, "https://machine.example".parse().unwrap());
    assert!(origin_matches_host(&headers));

    headers.insert(header::ORIGIN, "https://machine.example/".parse().unwrap());
    assert!(!origin_matches_host(&headers));

    headers.insert(header::HOST, "127.0.0.1:80".parse().unwrap());
    headers.insert(header::ORIGIN, "http://127.0.0.1".parse().unwrap());
    assert!(origin_matches_host(&headers));
}
