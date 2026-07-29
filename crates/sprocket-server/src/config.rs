use std::path::PathBuf;

use clap::Parser;

use crate::repo_env::compile_time_env_var;
use crate::static_dir::resolve_static_dir;

pub const DEFAULT_PORT: u16 = 17731;
pub const DEFAULT_DEV_WEB_URL: &str = "http://localhost:5173";
pub const SESSION_COOKIE_NAME: &str = "sprocket_session";

#[derive(Debug, Clone, Parser)]
#[command(about = "Local Sprocket server options")]
pub struct ServerConfig {
    #[arg(long, env = "SPROCKET_HOST", default_value = "127.0.0.1")]
    pub host: String,

    #[arg(long, env = "SPROCKET_PORT", default_value_t = DEFAULT_PORT)]
    pub port: u16,

    #[arg(long, env = "SPROCKET_DATA_DIR")]
    pub data_dir: Option<PathBuf>,

    #[arg(long, env = "SPROCKET_STATIC_DIR")]
    pub static_dir: Option<PathBuf>,

    /// Serve only the local API (no bundled web app). Use with `bun run dev`.
    #[arg(long, env = "SPROCKET_API_ONLY")]
    pub api_only: bool,

    /// Convex deployment URL for the local agent runtime.
    #[arg(long, env = "PUBLIC_CONVEX_URL")]
    pub convex_deployment_url: Option<String>,
}

impl ServerConfig {
    pub fn resolve_convex_deployment_url(&self) -> anyhow::Result<String> {
        if let Some(url) = self
            .convex_deployment_url
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return Ok(url.to_string());
        }

        if let Ok(url) = std::env::var("PUBLIC_CONVEX_URL") {
            let url = url.trim();
            if !url.is_empty() {
                return Ok(url.to_string());
            }
        }

        if let Some(url) = compile_time_env_var("PUBLIC_CONVEX_URL")
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return Ok(url.to_string());
        }

        anyhow::bail!("PUBLIC_CONVEX_URL must be set for the local agent runtime")
    }

    pub fn bind_address(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }

    pub fn listen_url(&self) -> String {
        format!("http://{}:{}", self.host, self.port)
    }

    pub fn resolve_data_dir(&self) -> PathBuf {
        let path = self.data_dir.clone().unwrap_or_else(default_data_dir);

        canonicalize_data_dir(path)
    }

    pub fn resolve_static_dir(&self) -> Option<PathBuf> {
        if self.api_only {
            return None;
        }

        resolve_static_dir(self.static_dir.clone())
    }
}

fn default_data_dir() -> PathBuf {
    sprocket_workspace::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".sprocket")
}

fn canonicalize_data_dir(path: PathBuf) -> PathBuf {
    let resolved = if path.is_absolute() {
        path
    } else if let Ok(cwd) = std::env::current_dir() {
        cwd.join(path)
    } else {
        path
    };

    resolved.canonicalize().unwrap_or(resolved)
}
