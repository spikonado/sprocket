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
