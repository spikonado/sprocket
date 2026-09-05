mod auth;
mod config;
mod machine_identity;
mod machines;
mod native_auth;
mod project_attachments;
pub mod repo_env;
mod routes;
mod static_dir;
mod static_files;
mod thread_cache;
mod thread_sync;
mod transcript_client;
mod transcript_watch;

pub use config::{DEFAULT_DEV_WEB_URL, DEFAULT_PORT, SESSION_COOKIE_NAME, ServerConfig};
use static_dir::is_valid_static_dir;
pub use static_dir::{INSTALLED_WEB_DIR, resolve_static_dir};

use std::io::ErrorKind;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::Context as _;
use axum::Json;
use axum::Router;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use sprocket_agent::{LiveCompletionHub, TranscriptStore};
use tokio::sync::Mutex;
use tokio::time::{Duration, sleep};

use crate::transcript_watch::TranscriptWatchers;

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn reject_path_traversal(path: &Path) -> anyhow::Result<PathBuf> {
    if path
        .components()
        .any(|component| component == std::path::Component::ParentDir)
    {
        anyhow::bail!("path must not contain '..'");
    }
    Ok(path.to_path_buf())
}

fn unique_json_sibling(path: &Path, kind: &str) -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    path.with_extension(format!("json.{kind}.{}.{seq}.{nanos}", std::process::id()))
}

fn parse_json_sibling(name: &str, file_name: &str, kind: &str) -> Option<(u128, u64, u32)> {
    let prefix = format!("{file_name}.{kind}.");
    let rest = name.strip_prefix(&prefix)?;
    let mut parts = rest.split('.');
    let pid: u32 = parts.next()?.parse().ok()?;
    let seq: u64 = parts.next()?.parse().ok()?;
    let nanos: u128 = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((nanos, seq, pid))
}

/// Restore `{name}.bak.{pid}.{seq}.{nanos}` when `path` is missing after an interrupted replace.
async fn recover_stranded_json_bak(path: &Path) -> anyhow::Result<()> {
    if tokio::fs::try_exists(path).await.unwrap_or(false) {
        return Ok(());
    }
    let Some(parent) = path.parent() else {
        return Ok(());
    };
    let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
        return Ok(());
    };
    let mut entries = match tokio::fs::read_dir(parent).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };

    let mut newest: Option<((u128, u64, u32), PathBuf)> = None;
    while let Some(entry) = entries.next_entry().await? {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let Some(key) = parse_json_sibling(name, file_name, "bak") else {
            continue;
        };
        if !entry.file_type().await?.is_file() {
            continue;
        }
        if newest.as_ref().is_none_or(|(best, _)| key > *best) {
            newest = Some((key, entry.path()));
        }
    }

    if let Some((_, bak)) = newest {
        tokio::fs::rename(&bak, path).await?;
    }
    Ok(())
}

async fn resolve_atomic_write_path(path: &Path) -> anyhow::Result<PathBuf> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .with_context(|| format!("failed to create parent directory {}", parent.display()))?;
        if let Ok(canonical_parent) = parent.canonicalize() {
            let file_name = path.file_name().ok_or_else(|| {
                anyhow::anyhow!(
                    "atomic write path {} is missing a file name",
                    path.display()
                )
            })?;
            return reject_path_traversal(&canonical_parent.join(file_name));
        }
    }
    reject_path_traversal(path)
}

/// Write `payload` to `path` via a unique sibling temp file then rename.
pub(crate) async fn write_atomic(path: &Path, payload: &[u8]) -> anyhow::Result<()> {
    let path = resolve_atomic_write_path(path).await?;
    recover_stranded_json_bak(&path).await?;

    let mut last_error = None;
    let mut tmp = None;
    for _ in 0..16 {
        let candidate = reject_path_traversal(&unique_json_sibling(&path, "tmp"))?;
        match tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
            .await
        {
            Ok(mut file) => {
                use tokio::io::AsyncWriteExt;
                if let Err(error) = async {
                    file.write_all(payload).await?;
                    file.flush().await?;
                    anyhow::Ok(())
                }
                .await
                {
                    let _ = tokio::fs::remove_file(&candidate).await;
                    return Err(error);
                }
                tmp = Some(candidate);
                break;
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                last_error = Some(error);
                continue;
            }
            Err(error) => return Err(error.into()),
        }
    }
    let tmp = tmp.ok_or_else(|| {
        last_error
            .map(anyhow::Error::from)
            .unwrap_or_else(|| anyhow::anyhow!("failed to allocate staging path"))
    })?;

    match tokio::fs::rename(&tmp, &path).await {
        Ok(()) => Ok(()),
        Err(error) => {
            #[cfg(windows)]
            {
                if error.kind() == ErrorKind::AlreadyExists {
                    return replace_existing_windows(&path, &tmp).await;
                }
            }
            let _ = tokio::fs::remove_file(&tmp).await;
            Err(error.into())
        }
    }
}

#[cfg(windows)]
async fn replace_existing_windows(path: &Path, tmp: &Path) -> anyhow::Result<()> {
    let bak = reject_path_traversal(&unique_json_sibling(path, "bak"))?;

    match tokio::fs::rename(path, &bak).await {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => {
            let _ = tokio::fs::remove_file(tmp).await;
            return Err(error.into());
        }
    }

    match tokio::fs::rename(tmp, path).await {
        Ok(()) => {
            let _ = tokio::fs::remove_file(&bak).await;
            Ok(())
        }
        Err(error) => {
            match tokio::fs::rename(&bak, path).await {
                Ok(()) => {
                    let _ = tokio::fs::remove_file(tmp).await;
                }
                Err(_) => {}
            }
            Err(error.into())
        }
    }
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
    pub(crate) native_auth: Arc<native_auth::NativeAuthManager>,
    pub project_attachments: Arc<project_attachments::ProjectAttachmentStore>,
    pub transcript: Arc<TranscriptStore>,
    pub transcript_watchers: Arc<TranscriptWatchers>,
    pub thread_cache: Arc<thread_sync::ThreadCacheSync>,
    pub machines: Arc<machines::MachineManager>,
    pub live_completions: Arc<LiveCompletionHub>,
    pub http_base_url: String,
    pub desktop_login_callback_url: String,
    pub loopback_desktop_login_supported: bool,
    pub convex_deployment_url: String,
    pub web_ui_enabled: bool,
    pub desktop_bootstrap_token: Option<Arc<Mutex<Option<String>>>>,
    pub(crate) machine_identity: Arc<machine_identity::MachineIdentity>,
}

pub fn build_router(state: AppState, static_dir: Option<PathBuf>) -> Router {
    let api = Router::new()
        .merge(routes::health::routes())
        .merge(routes::config::routes())
        .merge(routes::auth::routes())
        .merge(routes::workspace::routes())
        .merge(routes::agent::routes())
        .merge(routes::transcript::routes())
        .merge(routes::threads::routes())
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
    let native_auth = native_auth::NativeAuthManager::new(
        convex_deployment_url.clone(),
        auth::desktop_login_callback_url(config.port),
        &data_dir,
    );
    let auth = auth::AuthState::load(&data_dir)?;
    let machine_identity = Arc::new(machine_identity::MachineIdentity::load(&data_dir)?);
    let machines = machines::MachineManager::new(
        convex_deployment_url.clone(),
        Arc::clone(&native_auth),
        Arc::clone(&machine_identity),
    );
    let pairing_credential = auth.pairing_credential().to_string();
    let project_attachments = project_attachments::ProjectAttachmentStore::new(data_dir.clone());
    let transcript = TranscriptStore::new(data_dir.join("transcripts"));
    let transcript_watchers = TranscriptWatchers::new(
        convex_deployment_url.clone(),
        Arc::clone(&transcript),
        Arc::clone(&native_auth),
    );
    let thread_cache = thread_sync::ThreadCacheSync::new(
        convex_deployment_url.clone(),
        thread_cache::ThreadCacheStore::new(data_dir.clone()),
        Arc::clone(&native_auth),
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
        native_auth,
        project_attachments,
        transcript,
        transcript_watchers,
        thread_cache,
        machines: Arc::clone(&machines),
        live_completions: Arc::new(LiveCompletionHub::new()),
        http_base_url: http_base_url.clone(),
        desktop_login_callback_url: auth::desktop_login_callback_url(config.port),
        loopback_desktop_login_supported: auth::host_supports_loopback_desktop_login(&config.host),
        convex_deployment_url,
        web_ui_enabled,
        desktop_bootstrap_token,
        machine_identity,
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

    let result = axum::serve(
        listener,
        router.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await;
    machines.shutdown().await;
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

    #[tokio::test]
    async fn write_atomic_creates_missing_parent_with_parent_dir_components() {
        let root = std::env::temp_dir().join(format!("sprocket-atomic-{}", now_ms()));
        let existing = root.join("existing");
        std::fs::create_dir_all(&existing).expect("create existing");
        let path = existing
            .join("..")
            .join("missing-data")
            .join("sessions.json");
        write_atomic(&path, b"[]").await.expect("write");
        let written = std::fs::read(root.join("missing-data").join("sessions.json")).expect("read");
        assert_eq!(written, b"[]");
        let _ = std::fs::remove_dir_all(root);
    }
}
