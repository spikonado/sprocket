mod auth;
mod config;
mod routes;
mod static_dir;
mod static_files;
mod workspace_sessions;

pub use config::{DEFAULT_DEV_WEB_URL, DEFAULT_PORT, SESSION_COOKIE_NAME, ServerConfig};
pub use static_dir::{INSTALLED_WEB_DIR, is_valid_static_dir, resolve_static_dir};

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use tokio::sync::Mutex;

#[derive(Debug, Clone, Copy, Default)]
pub struct RunOptions {
    pub quiet: bool,
    pub open_browser: bool,
}

#[derive(Debug, Clone)]
pub struct StartupInfo {
    pub listen_url: String,
    pub pairing_credential: String,
    pub web_ui_enabled: bool,
}

impl StartupInfo {
    pub fn pairing_url(&self) -> String {
        format!("{}/pair#token={}", self.listen_url, self.pairing_credential)
    }

    pub fn print_startup(&self, dev_web_url: Option<&str>) {
        if let Some(dev_web_url) = dev_web_url {
            eprintln!("Sprocket API is running at {}", self.listen_url);
            eprintln!("Open the web app (Vite dev server):");
            eprintln!("{dev_web_url}");
            eprintln!("Pair in the browser if needed:");
            eprintln!("{}/pair#token={}", dev_web_url, self.pairing_credential);
            return;
        }

        eprintln!("Sprocket is running. Open in your browser:");
        eprintln!("{}", self.pairing_url());
    }
}

#[derive(Clone)]
pub struct AppState {
    pub auth: Arc<auth::AuthState>,
    pub workspace_sessions: Arc<workspace_sessions::WorkspaceSessionStore>,
    pub http_base_url: String,
    pub desktop_bootstrap_token: Option<Arc<Mutex<Option<String>>>>,
}

pub fn build_router(state: AppState, static_dir: Option<PathBuf>) -> Router {
    let api = Router::new()
        .merge(routes::health::routes())
        .merge(routes::auth::routes())
        .merge(routes::workspace::routes())
        .merge(routes::agent::routes())
        .fallback(api_not_found)
        .with_state(state);

    match static_dir {
        Some(dir) => static_files::static_router(dir, api),
        None => Router::new().nest("/api", api),
    }
}

pub async fn run(config: ServerConfig, options: RunOptions) -> anyhow::Result<()> {
    let data_dir = config.resolve_data_dir();
    let auth = auth::AuthState::load(&data_dir)?;
    let pairing_credential = auth.pairing_credential().to_string();
    let workspace_sessions = workspace_sessions::WorkspaceSessionStore::new(data_dir.clone());
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
        workspace_sessions,
        http_base_url: http_base_url.clone(),
        desktop_bootstrap_token,
    };

    let startup = StartupInfo {
        listen_url: config.listen_url(),
        pairing_credential,
        web_ui_enabled,
    };

    let dev_web_url = config.api_only.then(default_dev_web_url).flatten();

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
        let open_target = dev_web_url.as_deref().unwrap_or(&startup.listen_url);
        if dev_web_url.is_some() || web_ui_enabled {
            if let Err(error) = open::that(open_target) {
                tracing::warn!("failed to open browser: {error}");
            }
        }
    }

    let router = build_router(state, static_dir);
    let listener = tokio::net::TcpListener::bind(config.bind_address()).await?;

    axum::serve(
        listener,
        router.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;
    Ok(())
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

/// Load environment variables from local `.env` files.
///
/// # Safety
///
/// This must be called during single-threaded startup, before any async runtime
/// or other threads that may read environment variables are started.
pub unsafe fn load_env_files() {
    for candidate in [".env", "../.env", "../../.env"] {
        let path = PathBuf::from(candidate);
        if path.exists()
            && let Ok(contents) = std::fs::read_to_string(&path)
        {
            for line in contents.lines() {
                let line = line.trim();
                if line.is_empty() || line.starts_with('#') {
                    continue;
                }
                let Some((key, value)) = line.split_once('=') else {
                    continue;
                };
                if std::env::var(key).is_err() {
                    // SAFETY: the caller guarantees single-threaded startup.
                    unsafe {
                        std::env::set_var(key, value);
                    }
                }
            }
        }
    }
}
