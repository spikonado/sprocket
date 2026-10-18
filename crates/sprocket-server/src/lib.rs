mod auth;
pub mod cli_protocol;
mod cli_sessions;
mod config;
pub mod repo_env;
mod routes;
mod static_dir;
mod static_files;

pub use config::{DEFAULT_DEV_WEB_URL, DEFAULT_PORT, SESSION_COOKIE_NAME, ServerConfig};
pub use sprocket_host::profile::read_server_address;
use static_dir::is_valid_static_dir;
pub use static_dir::{INSTALLED_WEB_DIR, resolve_static_dir};

use std::io::ErrorKind;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Context as _;
use axum::Json;
use axum::Router;
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum_extra::extract::CookieJar;
use sprocket_host::profile::ProfileLock;
use sprocket_host::{Host, HostConfig};
use tokio::sync::Mutex;
use tokio::time::{Duration, sleep};

#[derive(Debug, Clone, Default)]
pub struct RunOptions {
    pub quiet: bool,
    pub open_browser: bool,
    pub workspace_path: Option<String>,
    pub temporary: bool,
}

#[derive(Debug, Clone)]
pub struct StartupInfo {
    pub listen_url: String,
    pub web_ui_enabled: bool,
    pub workspace_path: Option<String>,
}

impl StartupInfo {
    pub fn browser_url(&self, base_url: &str) -> String {
        browser_launch_url(base_url, self.workspace_path.as_deref())
    }

    pub fn print_startup(&self, dev_web_url: Option<&str>) {
        if let Some(dev_web_url) = dev_web_url {
            eprintln!("Sprocket API is running at {}", self.listen_url);
            eprintln!("Open the web app (Vite dev server):");
            eprintln!("{dev_web_url}");
            eprintln!("Open in your browser:");
            eprintln!("{}", self.browser_url(dev_web_url));
            return;
        }

        eprintln!("Sprocket is running. Open in your browser:");
        eprintln!("{}", self.browser_url(&self.listen_url));
    }
}

#[derive(Clone)]
pub struct AppState {
    pub host: Host,
    pub(crate) cli_sessions: Arc<cli_sessions::CliSessions>,
    pub auth: Arc<auth::AuthState>,
    pub(crate) chatgpt_oauth: Arc<routes::chatgpt::PendingLogins>,
    pub http_base_url: String,
    pub loopback_desktop_login_supported: bool,
    pub web_ui_enabled: bool,
    pub desktop_bootstrap_token: Option<Arc<Mutex<Option<String>>>>,
}

impl AppState {
    pub(crate) async fn require_session_user(
        &self,
        headers: &HeaderMap,
        jar: &CookieJar,
        user_id: &str,
    ) -> Result<(), routes::api_error::ApiError> {
        crate::auth::require_session_user(&self.auth, headers, jar, user_id)
            .await
            .map_err(routes::api_error::ApiError::unauthorized)?;
        self.host
            .native_auth
            .require_user(user_id)
            .await
            .map_err(routes::api_error::ApiError::unauthorized)
    }
}

pub fn build_router(state: AppState, static_dir: Option<PathBuf>) -> Router {
    let api = Router::new()
        .merge(routes::health::routes())
        .merge(routes::config::routes())
        .merge(routes::auth::routes())
        .merge(routes::chatgpt::routes())
        .merge(routes::github::routes())
        .merge(routes::cli::routes())
        .merge(routes::workspace::routes())
        .merge(routes::agent::routes())
        .merge(routes::transcript::routes())
        .merge(routes::threads::routes())
        .merge(routes::update::routes())
        .merge(routes::browser::routes())
        .merge(routes::artifacts::routes())
        .fallback(api_not_found)
        .with_state(state);

    match static_dir {
        Some(dir) => static_files::static_router(dir, api),
        None => Router::new().nest("/api", api),
    }
}

pub async fn run(config: ServerConfig, options: RunOptions) -> anyhow::Result<()> {
    let convex_deployment_url = config.resolve_convex_deployment_url()?;
    let data_dir = config.resolve_data_dir();
    let profile = ProfileLock::acquire(&data_dir)?;
    let auth = auth::AuthState::load(&data_dir)?;
    let host = Host::load(HostConfig {
        data_dir: data_dir.clone(),
        convex_deployment_url,
        native_login_callback_url: auth::desktop_login_callback_url(config.port),
        browser_sessions: Some(
            Arc::clone(&auth) as Arc<dyn sprocket_host::native_auth::BrowserSessions>
        ),
    })?;
    let http_base_url = config.listen_url();
    let web_ui_enabled = config
        .resolve_static_dir()
        .is_some_and(|dir| is_valid_static_dir(&dir));

    let static_dir = config.resolve_static_dir();
    let desktop_bootstrap_token = std::env::var("SPROCKET_DESKTOP_BOOTSTRAP_TOKEN")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(|value| Arc::new(Mutex::new(Some(value))));

    let pending_chatgpt_oauth = routes::chatgpt::PendingLogins::new(
        Arc::clone(&host.chatgpt_credentials),
        Arc::clone(&auth),
    );
    let cli_sessions = Arc::new(cli_sessions::CliSessions::new(
        Arc::clone(&host.lifetime),
        options.temporary,
    ));

    let state = AppState {
        host: host.clone(),
        cli_sessions: Arc::clone(&cli_sessions),
        auth,
        chatgpt_oauth: Arc::clone(&pending_chatgpt_oauth),
        http_base_url: http_base_url.clone(),
        loopback_desktop_login_supported: auth::host_supports_loopback_desktop_login(&config.host),
        web_ui_enabled,
        desktop_bootstrap_token,
    };

    let startup = StartupInfo {
        listen_url: config.listen_url(),
        web_ui_enabled,
        workspace_path: options.workspace_path.clone(),
    };

    let dev_web_url = config.api_only.then(default_dev_web_url).flatten();
    let listener = match tokio::net::TcpListener::bind(config.bind_address()).await {
        Ok(listener) => listener,
        Err(error) => {
            let hint = match error.kind() {
                // Covers a real port conflict and Windows WSAEACCES on reserved port ranges.
                ErrorKind::AddrInUse | ErrorKind::PermissionDenied => {
                    "the port may already be in use or reserved; set SPROCKET_PORT to a free port"
                }
                _ => "check that SPROCKET_HOST and SPROCKET_PORT form a valid, available address",
            };
            return Err(error).context(format!("failed to bind {}: {hint}", config.bind_address()));
        }
    };

    if options.quiet {
        println!("SPROCKET_LISTENING={}", startup.listen_url);
        println!("SPROCKET_DATA_DIR={}", data_dir.display());
        if let Some(dev_web_url) = &dev_web_url {
            println!("SPROCKET_DEV_WEB_URL={dev_web_url}");
        }
    } else {
        eprintln!("Data directory: {}", data_dir.display());
        startup.print_startup(dev_web_url.as_deref());
    }

    profile.publish(http_base_url.clone())?;

    if options.open_browser {
        let open_target =
            startup.browser_url(dev_web_url.as_deref().unwrap_or(&startup.listen_url));
        if dev_web_url.is_some() || web_ui_enabled {
            tokio::spawn(open_browser_when_ready(
                startup.listen_url.clone(),
                open_target,
            ));
        }
    }

    let host_tasks = host.start();
    let lease_auth = Arc::clone(&state.auth);
    let router = build_router(state, static_dir);

    let lifetime = Arc::clone(&host.lifetime);
    let shutdown = lifetime.shutdown.clone();
    let server = axum::serve(
        listener,
        router.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown({
        let host = host.clone();
        async move {
            tokio::select! {
                _ = shutdown_signal() => {},
                _ = async {
                    loop {
                        tokio::time::sleep(Duration::from_millis(500)).await;
                        let (stop, expired) = cli_sessions.tick(std::time::Instant::now());
                        for session in expired {
                            host.native_auth.cancel_device_login(&session).await;
                            let _ = lease_auth.end_session(&session).await;
                        }
                        if stop { break; }
                    }
                } => {},
            }
            lifetime.shutdown.cancel();
            host.machines.stop_registration();
        }
    })
    .into_future();
    tokio::pin!(server);
    let result = tokio::select! {
        result = &mut server => result,
        _ = shutdown.cancelled() => {
            tokio::time::timeout(Duration::from_secs(10), &mut server).await.unwrap_or(Ok(()))
        }
    };
    host_tasks.shutdown().await;
    routes::chatgpt::shutdown(&pending_chatgpt_oauth).await;
    result?;
    Ok(())
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("install SIGTERM handler");
        tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {} }
    }
    #[cfg(not(unix))]
    let _ = tokio::signal::ctrl_c().await;
}

async fn open_browser_when_ready(health_base_url: String, open_target: String) {
    let health_url = format!("{}/api/health", health_base_url.trim_end_matches('/'));
    let client = match reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_millis(250))
        .retry(reqwest::retry::never())
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            tracing::warn!("failed to prepare the browser readiness check: {error}");
            return;
        }
    };
    for _ in 0..100 {
        if client
            .get(&health_url)
            .send()
            .await
            .is_ok_and(|response| response.status().is_success())
        {
            if let Err(error) = open::that_detached(&open_target) {
                tracing::warn!("failed to open browser: {error}");
            }
            return;
        }
        sleep(Duration::from_millis(50)).await;
    }
    tracing::warn!("timed out waiting to open the browser at {open_target}");
}

async fn api_not_found() -> impl IntoResponse {
    (
        StatusCode::NOT_FOUND,
        Json(serde_json::json!({ "error": "API route not found" })),
    )
}

fn default_dev_web_url() -> Option<String> {
    std::env::var("SPROCKET_DEV_WEB_URL")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| Some(config::DEFAULT_DEV_WEB_URL.to_string()))
}

pub fn browser_launch_url(base_url: &str, workspace_path: Option<&str>) -> String {
    let mut fragment = url::form_urlencoded::Serializer::new(String::new());
    if let Some(workspace_path) = workspace_path {
        fragment.append_pair("workspace", workspace_path);
    }
    let fragment = fragment.finish();
    let base_url = base_url.trim_end_matches('/');
    if fragment.is_empty() {
        base_url.to_string()
    } else {
        format!("{base_url}/#{fragment}")
    }
}

pub fn pairing_proof_message(challenge: &str, http_base_url: &str, web_ui_enabled: bool) -> String {
    format!("{challenge}\n{http_base_url}\nweb-ui={web_ui_enabled}")
}

/// Wire types for `/api/auth/pairing-proof`, shared with clients such as the CLI.
#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct PairingProofRequest {
    pub challenge: String,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingProofResponse {
    pub http_base_url: String,
    pub web_ui_enabled: bool,
    pub proof: Vec<u8>,
}

pub fn read_pairing_credential(config: &ServerConfig) -> anyhow::Result<Option<String>> {
    auth::read_pairing_credential(&config.resolve_data_dir())
}

pub use auth::{sign_pairing_proof, verify_pairing_proof};
pub use repo_env::load_repo_env;

#[cfg(test)]
mod test_support;
#[cfg(test)]
mod tests;
