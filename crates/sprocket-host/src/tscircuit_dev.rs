use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, bail};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sprocket_workspace::WorkspaceCancellation;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tokio::time::Instant;

use crate::bun_install::BunInstaller;

const LOCALHOST_ONLY: &str = include_str!("tscircuit_dev/localhost-only.mjs");
const READY_TIMEOUT: Duration = Duration::from_secs(60);
const LOG_TAIL_BYTES: usize = 4096;

pub struct DevSession {
    pub id: String,
    /// The circuit file, relative to the project and `/`-separated.
    pub file: String,
}

struct DevServer {
    port: u16,
    child: Child,
}

/// One `tsci dev` server per tscircuit project, reachable only through Sprocket's proxy.
pub struct TscircuitDevServers {
    dir: PathBuf,
    bun: Arc<BunInstaller>,
    servers: Mutex<HashMap<String, DevServer>>,
    starting: Mutex<()>,
    client: reqwest::Client,
    shutdown: WorkspaceCancellation,
}

impl TscircuitDevServers {
    pub fn new(data_dir: &Path, bun: Arc<BunInstaller>) -> anyhow::Result<Arc<Self>> {
        Ok(Arc::new(Self {
            dir: data_dir.join("tscircuit-dev"),
            bun,
            servers: Mutex::default(),
            starting: Mutex::default(),
            client: reqwest::Client::builder()
                .no_proxy()
                .retry(reqwest::retry::never())
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(5))
                .read_timeout(Duration::from_secs(30))
                .build()?,
            shutdown: WorkspaceCancellation::new(),
        }))
    }

    pub fn client(&self) -> &reqwest::Client {
        &self.client
    }

    /// Starts the dev server for the project holding `path` in `root`, unless it's running.
    pub async fn start(&self, root: &Path, path: &str) -> anyhow::Result<DevSession> {
        let (project, file) = find_project(root, path)?;
        let id = project_id(&project);
        let _starting = self.starting.lock().await;
        if self.port(&id).await.is_ok() {
            return Ok(DevSession { id, file });
        }
        let server = tokio::select! {
            server = self.launch(&project, &id) => server?,
            _ = self.shutdown.cancelled() => bail!("Sprocket is shutting down"),
        };
        let mut servers = self.servers.lock().await;
        if self.shutdown.is_cancelled() {
            bail!("Sprocket is shutting down");
        }
        servers.insert(id.clone(), server);
        Ok(DevSession { id, file })
    }

    pub async fn port(&self, id: &str) -> anyhow::Result<u16> {
        let mut servers = self.servers.lock().await;
        let server = servers
            .get_mut(id)
            .context("The tscircuit editor isn't running. Reopen it.")?;
        if !matches!(server.child.try_wait(), Ok(None)) {
            servers.remove(id);
            bail!("The tscircuit editor stopped. Reopen it to restart it.");
        }
        Ok(server.port)
    }

    pub async fn shutdown(&self) {
        self.shutdown.cancel();
        let servers = std::mem::take(&mut *self.servers.lock().await);
        for (_, mut server) in servers {
            let _ = server.child.kill().await;
        }
    }

    #[cfg(all(any(test, feature = "test-support"), unix))]
    pub async fn use_test_server(&self, id: &str, port: u16) {
        let child = Command::new("sh")
            .args(["-c", "sleep 60"])
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        self.servers
            .lock()
            .await
            .insert(id.to_owned(), DevServer { port, child });
    }

    async fn launch(&self, project: &Path, id: &str) -> anyhow::Result<DevServer> {
        let cli = tscircuit_cli(project)?;
        let bun = self.bun.bun().await?;
        tokio::fs::create_dir_all(&self.dir).await?;
        let preload = self.dir.join("localhost-only.mjs");
        tokio::fs::write(&preload, LOCALHOST_ONLY).await?;
        let log_path = self.dir.join(format!("{id}.log"));
        let log = std::fs::File::create(&log_path)?;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let port = listener.local_addr()?.port();
        drop(listener);
        let mut child = Command::new(bun)
            .arg("run")
            .arg("--preload")
            .arg(&preload)
            .arg("--no-orphans")
            .arg(&cli)
            .args(["dev", "--port", &port.to_string()])
            .current_dir(project)
            .envs(self.bun.environment(Vec::new()))
            .env("TSCI_SKIP_CLI_UPDATE", "true")
            .stdin(Stdio::null())
            .stdout(log.try_clone()?)
            .stderr(log)
            .kill_on_drop(true)
            .spawn()
            .context("start tscircuit dev server")?;
        let deadline = Instant::now() + READY_TIMEOUT;
        while Instant::now() < deadline {
            if let Some(status) = child.try_wait()? {
                bail!(
                    "tscircuit dev server exited ({status}): {}",
                    log_tail(&log_path).await
                );
            }
            if self
                .client
                .get(format!("http://127.0.0.1:{port}/"))
                .timeout(Duration::from_secs(1))
                .send()
                .await
                .is_ok_and(|response| response.status().is_success())
            {
                return Ok(DevServer { port, child });
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        bail!(
            "tscircuit dev server didn't become ready: {}",
            log_tail(&log_path).await
        )
    }
}

/// Returns the nearest folder with a `package.json` that holds `path`, and `path` relative to it.
fn find_project(root: &Path, path: &str) -> anyhow::Result<(PathBuf, String)> {
    let root = root.canonicalize()?;
    let file = root
        .join(path)
        .canonicalize()
        .with_context(|| format!("{path} doesn't exist"))?;
    if !file.starts_with(&root) {
        bail!("{path} is outside the workspace");
    }
    let project = file
        .ancestors()
        .skip(1)
        .take_while(|directory| directory.starts_with(&root))
        .find(|directory| directory.join("package.json").is_file())
        .with_context(|| format!("{path} isn't in a tscircuit project"))?;
    let relative = file
        .strip_prefix(project)?
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/");
    Ok((project.to_path_buf(), relative))
}

fn tscircuit_cli(project: &Path) -> anyhow::Result<PathBuf> {
    let package = project.join("node_modules/tscircuit");
    let manifest = std::fs::read_to_string(package.join("package.json")).with_context(|| {
        format!(
            "tscircuit isn't installed in {}. Run `bun install` there.",
            project.display()
        )
    })?;
    let manifest: Value = serde_json::from_str(&manifest)?;
    let bin = manifest["bin"]
        .as_str()
        .or_else(|| manifest["bin"]["tsci"].as_str())
        .context("The tscircuit package has no tsci command")?;
    Ok(package.join(bin))
}

fn project_id(project: &Path) -> String {
    let digest = Sha256::digest(project.as_os_str().as_encoded_bytes());
    hex::encode(&digest[..8])
}

async fn log_tail(path: &Path) -> String {
    let log = tokio::fs::read(path).await.unwrap_or_default();
    let start = log.len().saturating_sub(LOG_TAIL_BYTES);
    String::from_utf8_lossy(&log[start..]).trim().to_owned()
}

#[cfg(test)]
mod tests;
