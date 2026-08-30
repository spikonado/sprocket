mod auth;
mod config;
mod convex_auth;
mod project_attachments;
pub mod repo_env;
mod routes;
mod static_dir;
mod static_files;
mod transcript_client;
mod transcript_watch;

pub use config::{DEFAULT_DEV_WEB_URL, DEFAULT_PORT, SESSION_COOKIE_NAME, ServerConfig};
use sprocket_convex::SessionCredentialProvider;
use static_dir::is_valid_static_dir;
pub use static_dir::{INSTALLED_WEB_DIR, resolve_static_dir};

use std::io::ErrorKind;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Context as _;
use axum::Json;
use axum::Router;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use sprocket_agent::{LiveCompletionHub, TranscriptStore};
use tokio::sync::Mutex;
use tokio::time::{Duration, sleep};

use crate::transcript_watch::TranscriptWatchers;
pub use convex_auth::{ConvexTokenProvider, matching_session_credential};

pub(crate) fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Debug, Clone, Default)]
pub struct RunOptions {
    pub quiet: bool,
    pub open_browser: bool,
    pub workspace_path: Option<String>,
}

#[derive(Debug, Clone)]
pub struct StartupInfo {
    pub listen_url: String,
    pub pairing_credential: String,
    pub web_ui_enabled: bool,
    pub workspace_path: Option<String>,
}

impl StartupInfo {
    pub fn browser_url(&self, base_url: &str) -> String {
        browser_launch_url(
            base_url,
            &self.pairing_credential,
            self.workspace_path.as_deref(),
        )
    }

    pub fn print_startup(&self, dev_web_url: Option<&str>) {
        if let Some(dev_web_url) = dev_web_url {
            eprintln!("Sprocket API is running at {}", self.listen_url);
            eprintln!("Open the web app (Vite dev server):");
            eprintln!("{dev_web_url}");
            eprintln!("Pair in the browser if needed:");
            eprintln!("{}", self.browser_url(dev_web_url));
            return;
        }

        eprintln!("Sprocket is running. Open in your browser:");
        eprintln!("{}", self.browser_url(&self.listen_url));
    }
}

#[derive(Clone)]
pub struct AppState {
    pub auth: Arc<auth::AuthState>,
    pub desktop_login: Arc<auth::DesktopLoginStore>,
    pub project_attachments: Arc<project_attachments::ProjectAttachmentStore>,
    pub transcript: Arc<TranscriptStore>,
    pub transcript_watchers: Arc<TranscriptWatchers>,
    pub live_completions: Arc<LiveCompletionHub>,
    pub http_base_url: String,
    pub desktop_login_callback_url: String,
    pub loopback_desktop_login_supported: bool,
    pub convex_deployment_url: String,
    pub convex_tokens: ConvexTokenProvider,
    pub session_credentials: Arc<Mutex<Option<SessionCredentialProvider>>>,
    pub web_ui_enabled: bool,
    pub desktop_bootstrap_token: Option<Arc<Mutex<Option<String>>>>,
}

pub fn build_router(state: AppState, static_dir: Option<PathBuf>) -> Router {
    let api = Router::new()
        .merge(routes::health::routes())
        .merge(routes::config::routes())
        .merge(routes::auth::routes())
        .merge(routes::workspace::routes())
        .merge(routes::agent::routes())
        .merge(routes::transcript::routes())
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
    let auth = auth::AuthState::load(&data_dir)?;
    let pairing_credential = auth.pairing_credential().to_string();
    let project_attachments = project_attachments::ProjectAttachmentStore::new(data_dir.clone());
    let transcript = TranscriptStore::new(data_dir.join("transcripts"));
    let convex_tokens = ConvexTokenProvider::new();
    let session_credentials = Arc::new(Mutex::new(None::<SessionCredentialProvider>));
    let credential_path = data_dir.join("session-credential.json");
    if let Some(snapshot) = SessionCredentialProvider::load_persist(&credential_path).await {
        match sprocket_convex::Client::new(&convex_deployment_url).await {
            Ok(client) => {
                let provider = SessionCredentialProvider::from_snapshot(
                    Arc::new(client),
                    snapshot,
                    Some(credential_path),
                );
                *session_credentials.lock().await = Some(provider.clone());
                tokio::spawn(async move {
                    let _ = provider.run_rotator().await;
                });
            }
            Err(error) => {
                tracing::warn!("failed to resume the session credential: {error:#}");
            }
        }
    }
    let transcript_watchers = TranscriptWatchers::new(
        convex_deployment_url.clone(),
        Arc::clone(&transcript),
        convex_tokens.clone(),
        session_credentials.clone(),
    );
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

    let state = AppState {
        auth,
        desktop_login: auth::DesktopLoginStore::new(),
        project_attachments,
        transcript,
        transcript_watchers,
        live_completions: Arc::new(LiveCompletionHub::new()),
        http_base_url: http_base_url.clone(),
        desktop_login_callback_url: auth::desktop_login_callback_url(config.port),
        loopback_desktop_login_supported: auth::host_supports_loopback_desktop_login(&config.host),
        convex_deployment_url,
        convex_tokens,
        session_credentials,
        web_ui_enabled,
        desktop_bootstrap_token,
    };

    let startup = StartupInfo {
        listen_url: config.listen_url(),
        pairing_credential,
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

    let router = build_router(state, static_dir);

    axum::serve(
        listener,
        router.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;
    Ok(())
}

async fn open_browser_when_ready(health_base_url: String, open_target: String) {
    let health_url = format!("{}/api/health", health_base_url.trim_end_matches('/'));
    let client = match reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_millis(250))
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
            if let Err(error) = open::that(&open_target) {
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

pub fn browser_launch_url(
    base_url: &str,
    pairing_credential: &str,
    workspace_path: Option<&str>,
) -> String {
    let mut fragment = url::form_urlencoded::Serializer::new(String::new());
    fragment.append_pair("token", pairing_credential);
    if let Some(workspace_path) = workspace_path {
        fragment.append_pair("workspace", workspace_path);
    }
    format!(
        "{}/pair#{}",
        base_url.trim_end_matches('/'),
        fragment.finish()
    )
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

pub use auth::verify_pairing_proof;
pub use repo_env::load_repo_env;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_launch_url_encodes_the_workspace() {
        assert_eq!(
            browser_launch_url("http://localhost:5173/", "secret", Some("/robot & tools")),
            "http://localhost:5173/pair#token=secret&workspace=%2Frobot+%26+tools"
        );
    }
}
