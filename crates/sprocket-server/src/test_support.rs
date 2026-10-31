use super::*;

impl AppState {
    pub(crate) fn for_test(
        auth: Arc<auth::AuthState>,
        native_auth: Arc<sprocket_host::native_auth::NativeAuthManager>,
        data_dir: PathBuf,
        loopback_desktop_login_supported: bool,
        package_updates: Arc<sprocket_host::package_update::PackageUpdateManager>,
    ) -> Self {
        let host = Host::for_test(native_auth, &data_dir, package_updates);
        let chatgpt_oauth = chatgpt_oauth::PendingLogins::new(
            Arc::clone(&host.chatgpt_credentials),
            Arc::clone(&auth),
        );
        Self {
            cli_sessions: Arc::new(cli_sessions::CliSessions::new(
                Arc::clone(&host.lifetime),
                false,
            )),
            host,
            auth,
            chatgpt_oauth,
            http_base_url: "http://127.0.0.1:7731".to_string(),
            loopback_desktop_login_supported,
            web_ui_enabled: true,
            desktop_bootstrap_token: None,
        }
    }
}

/// A state whose browser session and native sign-in belong to `browser-user`, and the session token.
pub(crate) async fn signed_in_state() -> (AppState, String, tempfile::TempDir) {
    let directory = tempfile::tempdir().unwrap();
    let auth = auth::AuthState::load(directory.path()).unwrap();
    let (_, token) = auth.bootstrap_browser_session(true).await.unwrap();
    auth.bind_session_user(&token, "browser-user")
        .await
        .unwrap();
    let native = sprocket_host::native_auth::NativeAuthManager::configured_for_test(
        sprocket_host::native_auth::NativeAuthConfig {
            workos_client_id: "client_test".into(),
        },
        auth::desktop_login_callback_url(7731),
    );
    native.authenticate_for_test("browser-user").await;
    (
        AppState::for_test(
            auth,
            native,
            directory.path().into(),
            true,
            sprocket_host::package_update::PackageUpdateManager::disabled(),
        ),
        token,
        directory,
    )
}

pub(crate) fn cookie_request(
    path: &str,
    token: Option<&str>,
    origin: Option<&str>,
    method: axum::http::Method,
) -> axum::http::Request<axum::body::Body> {
    use axum::http::header;
    let mut request = axum::http::Request::builder()
        .uri(path)
        .method(method)
        .header(header::HOST, "127.0.0.1:7731");
    if let Some(token) = token {
        request = request.header(header::COOKIE, format!("{}={token}", SESSION_COOKIE_NAME));
    }
    if let Some(origin) = origin {
        request = request.header(header::ORIGIN, origin);
    }
    request.body(axum::body::Body::empty()).unwrap()
}
