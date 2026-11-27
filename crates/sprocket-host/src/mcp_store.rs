use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use anyhow::{Context, ensure};
use serde::{Deserialize, Serialize};
pub use sprocket_agent::services::McpTransport;
use sprocket_agent::services::{ToolPolicy, loopback_http_url};

use crate::profile::write_private_file;
use crate::sealed_file::{KeyStore, SealedFile};
use crate::service_hub::CliConnector;

const SERVERS_FILE: &str = "mcp-servers.json";
const SECRETS_FILE: &str = "mcp-secrets";
const MAX_NAME_CHARS: usize = 100;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct McpConnector {
    pub id: String,
    pub name: String,
    pub transport: McpTransport,
}

impl McpConnector {
    pub(crate) fn prompt_line(&self) -> String {
        format!(
            "{} connector (MCP server; find its tools with service_search)",
            self.name
        )
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct McpServer {
    #[serde(flatten)]
    pub connector: McpConnector,
    #[serde(default)]
    pub policies: BTreeMap<String, ToolPolicy>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
pub enum NewMcpTransport {
    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env: BTreeMap<String, String>,
    },
    Http {
        url: String,
        #[serde(default)]
        headers: BTreeMap<String, String>,
    },
}

#[derive(Default, Deserialize, Serialize)]
struct ServersFile {
    servers: Vec<McpServer>,
}

type Secrets = BTreeMap<String, BTreeMap<String, String>>;

/// The machine's MCP servers in `mcp-servers.json`, with their secret values in a sealed file.
pub struct McpStore {
    servers_path: PathBuf,
    secrets: SealedFile,
    writes: Mutex<()>,
}

impl McpStore {
    pub(crate) fn new(data_dir: &Path, keys: Arc<dyn KeyStore>) -> Self {
        Self {
            servers_path: data_dir.join(SERVERS_FILE),
            secrets: SealedFile::new(data_dir.join(SECRETS_FILE), keys),
            writes: Mutex::new(()),
        }
    }

    /// Runs blocking file and keyring access off the async runtime.
    pub async fn run<T: Send + 'static>(
        self: &Arc<Self>,
        operation: impl FnOnce(&Self) -> anyhow::Result<T> + Send + 'static,
    ) -> anyhow::Result<T> {
        let store = Arc::clone(self);
        tokio::task::spawn_blocking(move || operation(&store)).await?
    }

    pub fn list(&self) -> anyhow::Result<Vec<McpServer>> {
        Ok(self.read_servers()?.servers)
    }

    pub fn get(&self, id: &str) -> anyhow::Result<McpServer> {
        self.list()?
            .into_iter()
            .find(|server| server.connector.id == id)
            .with_context(|| format!("No MCP server has the ID '{id}'."))
    }

    pub fn secrets(&self, id: &str) -> anyhow::Result<BTreeMap<String, String>> {
        Ok(self.read_secrets()?.remove(id).unwrap_or_default())
    }

    pub fn add(&self, name: &str, transport: NewMcpTransport) -> anyhow::Result<McpConnector> {
        let name = name.trim();
        ensure!(!name.is_empty(), "Name the MCP server.");
        ensure!(
            name.chars().count() <= MAX_NAME_CHARS,
            "MCP server names can't exceed {MAX_NAME_CHARS} characters."
        );
        let (transport, secrets) = split_secrets(transport)?;
        let _guard = self.writes.lock().unwrap_or_else(|e| e.into_inner());
        let mut file = self.read_servers()?;
        let id = unique_id(name, |id| {
            CliConnector::from_id(id).is_some()
                || file.servers.iter().any(|server| server.connector.id == id)
        });
        let connector = McpConnector {
            id,
            name: name.to_string(),
            transport,
        };
        if !secrets.is_empty() {
            let mut all = self.read_secrets()?;
            all.insert(connector.id.clone(), secrets);
            self.write_secrets(&all)?;
        }
        file.servers.push(McpServer {
            connector: connector.clone(),
            policies: BTreeMap::new(),
        });
        self.write_servers(&file)?;
        Ok(connector)
    }

    pub fn delete(&self, id: &str) -> anyhow::Result<()> {
        let _guard = self.writes.lock().unwrap_or_else(|e| e.into_inner());
        let mut file = self.read_servers()?;
        let count = file.servers.len();
        file.servers.retain(|server| server.connector.id != id);
        ensure!(
            file.servers.len() < count,
            "No MCP server has the ID '{id}'."
        );
        self.write_servers(&file)?;
        let mut secrets = self.read_secrets()?;
        if secrets.remove(id).is_some() {
            self.write_secrets(&secrets)?;
        }
        Ok(())
    }

    pub fn set_policy(&self, id: &str, tool: &str, policy: ToolPolicy) -> anyhow::Result<()> {
        let _guard = self.writes.lock().unwrap_or_else(|e| e.into_inner());
        let mut file = self.read_servers()?;
        let server = file
            .servers
            .iter_mut()
            .find(|server| server.connector.id == id)
            .with_context(|| format!("No MCP server has the ID '{id}'."))?;
        server.policies.insert(tool.to_string(), policy);
        self.write_servers(&file)
    }

    fn read_servers(&self) -> anyhow::Result<ServersFile> {
        match std::fs::read(&self.servers_path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .with_context(|| format!("{} is not valid", self.servers_path.display())),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Ok(ServersFile::default())
            }
            Err(error) => Err(error.into()),
        }
    }

    fn write_servers(&self, file: &ServersFile) -> anyhow::Result<()> {
        write_private_file(&self.servers_path, &serde_json::to_vec_pretty(file)?)
    }

    fn read_secrets(&self) -> anyhow::Result<Secrets> {
        match self.secrets.read()? {
            Some(bytes) => Ok(serde_json::from_slice(&bytes)?),
            None => Ok(Secrets::new()),
        }
    }

    fn write_secrets(&self, secrets: &Secrets) -> anyhow::Result<()> {
        self.secrets.write(&serde_json::to_vec(secrets)?)
    }
}

fn split_secrets(
    transport: NewMcpTransport,
) -> anyhow::Result<(McpTransport, BTreeMap<String, String>)> {
    let (transport, secrets) = match transport {
        NewMcpTransport::Stdio { command, args, env } => (
            McpTransport::Stdio {
                command: command.trim().to_string(),
                args,
                env: env.keys().cloned().collect(),
            },
            env,
        ),
        NewMcpTransport::Http { url, headers } => {
            for (name, value) in &headers {
                ensure!(
                    reqwest::header::HeaderValue::from_str(value).is_ok(),
                    "The value of the '{name}' header isn't valid."
                );
            }
            (
                McpTransport::Http {
                    url: loopback_http_url(&url)?.to_string(),
                    headers: headers.keys().cloned().collect(),
                },
                headers,
            )
        }
    };
    transport.validate()?;
    Ok((transport, secrets))
}

fn unique_id(name: &str, taken: impl Fn(&str) -> bool) -> String {
    let mut slug = String::new();
    for character in name.chars().flat_map(char::to_lowercase) {
        if character.is_ascii_alphanumeric() {
            slug.push(character);
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug = match slug.trim_end_matches('-') {
        "" => "mcp",
        slug => slug,
    };
    std::iter::once(slug.to_string())
        .chain((2..).map(|suffix| format!("{slug}-{suffix}")))
        .find(|id| !taken(id))
        .expect("an unused suffix exists")
}

#[cfg(test)]
mod tests;
