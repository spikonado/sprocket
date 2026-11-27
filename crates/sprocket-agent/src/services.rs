use std::sync::Arc;

use anyhow::{bail, ensure};
use futures::future::BoxFuture;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub type JsonObject = Map<String, Value>;
pub type SharedServiceHub = Arc<dyn ServiceHub>;

/// How to start or reach an MCP server. Secret values stay out: `env` and `headers` only name them.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum McpTransport {
    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        /// Names of the environment variables the user must fill in.
        #[serde(default)]
        env: Vec<String>,
    },
    Http {
        url: String,
        /// Names of the HTTP headers the user must fill in.
        #[serde(default)]
        headers: Vec<String>,
    },
}

impl McpTransport {
    pub fn validate(&self) -> anyhow::Result<()> {
        match self {
            Self::Stdio { command, env, .. } => {
                ensure!(
                    !command.trim().is_empty(),
                    "Enter the command that starts the server."
                );
                for name in env {
                    ensure!(
                        !name.is_empty() && !name.contains(['=', '\0']),
                        "'{name}' isn't a valid environment variable name."
                    );
                }
            }
            Self::Http { url, headers } => {
                loopback_http_url(url)?;
                for name in headers {
                    ensure!(
                        http::HeaderName::from_bytes(name.as_bytes()).is_ok(),
                        "'{name}' isn't a valid HTTP header name."
                    );
                }
            }
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolPolicy {
    Enabled,
    Ask,
    Disabled,
}

impl ToolPolicy {
    pub fn default_for(read_only: bool) -> Self {
        if read_only { Self::Enabled } else { Self::Ask }
    }
}

#[derive(Debug, Serialize)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum SearchHit {
    NotConnected {
        connector: String,
        connector_id: String,
    },
    #[serde(untagged)]
    Connected {
        path: String,
        connector: String,
        description: String,
        policy: ToolPolicy,
    },
}

#[derive(Debug, Serialize)]
pub struct Unavailable {
    pub connector: String,
    pub error: String,
}

#[derive(Debug, Default, Serialize)]
pub struct SearchResults {
    pub results: Vec<SearchHit>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub unavailable: Vec<Unavailable>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDescription {
    pub path: String,
    pub description: String,
    pub input_schema: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_schema: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub annotations: Option<Value>,
    pub policy: ToolPolicy,
}

#[derive(Debug, Default, Serialize)]
pub struct Descriptions {
    pub tools: Vec<ToolDescription>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub missing: Vec<String>,
}

/// A tool ready to call, named for the approval prompt.
#[derive(Clone, Debug)]
pub struct ServiceTool {
    pub connector: String,
    pub tool: String,
    pub policy: ToolPolicy,
}

/// The machine's connected services for one run. Dropping it disconnects them.
pub trait ServiceHub: Send + Sync {
    fn search<'a>(&'a self, query: &'a str, limit: usize) -> BoxFuture<'a, SearchResults>;

    fn describe<'a>(&'a self, paths: &'a [String]) -> BoxFuture<'a, Descriptions>;

    fn tool<'a>(&'a self, path: &'a str) -> BoxFuture<'a, anyhow::Result<ServiceTool>>;

    fn call<'a>(
        &'a self,
        path: &'a str,
        arguments: JsonObject,
    ) -> BoxFuture<'a, anyhow::Result<Value>>;

    fn save_policy<'a>(
        &'a self,
        path: &'a str,
        policy: ToolPolicy,
    ) -> BoxFuture<'a, anyhow::Result<()>>;

    /// The name of a connector `request_connector` can set up by ID.
    fn connector_name(&self, id: &str) -> Option<String>;
}

/// Splits `<connectorId>/<toolName>`. Connector IDs never contain `/`, tool names may.
pub fn split_tool_path(path: &str) -> Option<(&str, &str)> {
    let (connector, tool) = path.split_once('/')?;
    (!connector.is_empty() && !tool.is_empty()).then_some((connector, tool))
}

/// Remote servers need OAuth, which comes later, so only servers on this machine are allowed.
pub fn loopback_http_url(raw: &str) -> anyhow::Result<url::Url> {
    let url = url::Url::parse(raw.trim())?;
    ensure!(
        matches!(url.scheme(), "http" | "https"),
        "MCP server URLs must use http or https."
    );
    let loopback = match url.host() {
        Some(url::Host::Ipv4(address)) => address.is_loopback(),
        Some(url::Host::Ipv6(address)) => address.is_loopback(),
        Some(url::Host::Domain(domain)) => domain.eq_ignore_ascii_case("localhost"),
        None => false,
    };
    if !loopback {
        bail!(
            "Only MCP servers on this machine (localhost, 127.0.0.1 or ::1) can be added for now."
        );
    }
    Ok(url)
}

#[cfg(test)]
mod tests;
