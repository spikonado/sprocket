use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, bail, ensure};
use futures::future::{BoxFuture, join_all};
use futures::{FutureExt, StreamExt};
use rmcp::model::Tool;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sprocket_agent::services::{
    Descriptions, JsonObject, SearchHit, SearchResults, ServiceHub, ServiceTool, SharedServiceHub,
    ToolDescription, ToolPolicy, Unavailable, split_tool_path,
};

use crate::Host;
use crate::mcp_client::McpClient;
use crate::mcp_store::{McpConnector, McpServer, McpTransport};
use crate::tool_install::ToolInstall;
use crate::vercel_connector::Account;

const RETRY_AFTER: Duration = Duration::from_secs(30);
const CLI_STATUS_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_SEARCH_DESCRIPTION_CHARS: usize = 300;
const REMOTE_TIMEOUT: Duration = Duration::from_secs(5);
const REMOTE_PREFIX: &str = "remote:";
const LIST_REMOTE_SERVERS: &str = "mcpServers:listMine";

fn remote_connector_id(id: &str) -> Option<&str> {
    id.strip_prefix(REMOTE_PREFIX)
}

#[derive(Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum ConnectorStatus {
    Connected,
    NeedsAuth,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteServer {
    connector_id: String,
    name: String,
    url: String,
    header_names: Vec<String>,
    status: ConnectorStatus,
    policies: Vec<RemotePolicy>,
}

#[derive(Clone, Deserialize)]
struct RemotePolicy {
    tool: String,
    policy: ToolPolicy,
}

impl RemoteServer {
    fn id(&self) -> String {
        format!("{REMOTE_PREFIX}{}", self.connector_id)
    }

    fn config(&self) -> McpServer {
        McpServer {
            connector: McpConnector {
                id: self.id(),
                name: self.name.clone(),
                transport: McpTransport::Http {
                    url: self.url.clone(),
                    headers: self.header_names.clone(),
                },
            },
            policies: self
                .policies
                .iter()
                .map(|p| (p.tool.clone(), p.policy))
                .collect(),
        }
    }
}

/// Connectors built on a CLI. MCP servers can't take their IDs.
#[derive(Clone, Copy)]
pub(crate) enum CliConnector {
    GitHub,
    Vercel,
    KiCad,
}

impl CliConnector {
    const ALL: [Self; 3] = [Self::GitHub, Self::Vercel, Self::KiCad];

    pub(crate) fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|connector| connector.id() == id)
    }

    fn id(self) -> &'static str {
        match self {
            Self::GitHub => "github",
            Self::Vercel => "vercel",
            Self::KiCad => "kicad",
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::GitHub => "GitHub",
            Self::Vercel => "Vercel",
            Self::KiCad => "KiCad",
        }
    }

    fn keywords(self) -> &'static str {
        match self {
            Self::GitHub => "repositories issues pull requests code git",
            Self::Vercel => "deploy deployments hosting projects domains",
            Self::KiCad => "pcb schematic electronics circuit board",
        }
    }

    async fn is_set_up(self, host: &Host) -> bool {
        match self {
            Self::GitHub => {
                let status = host.github.status().await;
                status.install == ToolInstall::Installed
                    && status.github.enabled
                    && status
                        .github
                        .hosts
                        .iter()
                        .any(|host| host.enabled && host.login.is_some())
            }
            Self::Vercel => {
                let status = host.vercel.status().await;
                status.install == ToolInstall::Installed
                    && matches!(status.account, Account::SignedIn { .. })
            }
            Self::KiCad => host.kicad.installed().is_some(),
        }
    }
}

enum Connection {
    Connected(Arc<McpClient>),
    Failed { error: String, at: Instant },
}

type ConnectionSlot = Arc<tokio::sync::Mutex<Option<Connection>>>;

struct RunServiceHub {
    host: Host,
    user_id: String,
    subscription: tokio::sync::Mutex<Option<sprocket_convex::Subscription>>,
    remote: Mutex<Vec<RemoteServer>>,
    connections: Mutex<HashMap<String, ConnectionSlot>>,
}

pub async fn for_run(host: &Host, user_id: &str) -> (SharedServiceHub, Vec<String>) {
    let hub = RunServiceHub::new(host, user_id);
    let mut installed = host.installed_connectors();
    match hub.remote_servers().await {
        Ok(servers) => installed.extend(
            servers
                .into_iter()
                .filter(|s| s.status == ConnectorStatus::Connected)
                .map(|s| s.config().connector.prompt_line()),
        ),
        Err(error) => tracing::warn!("couldn't list remote MCP connectors: {error:#}"),
    }
    (Arc::new(hub), installed)
}

impl RunServiceHub {
    fn new(host: &Host, user_id: &str) -> Self {
        Self {
            host: host.clone(),
            user_id: user_id.to_owned(),
            subscription: tokio::sync::Mutex::new(None),
            remote: Mutex::default(),
            connections: Mutex::default(),
        }
    }

    async fn remote_servers(&self) -> anyhow::Result<Vec<RemoteServer>> {
        let mut subscription = self.subscription.lock().await;
        let subscribed = match subscription.take() {
            Some(subscribed) => subscribed,
            None => tokio::time::timeout(REMOTE_TIMEOUT, self.subscribe_remote())
                .await
                .with_context(|| {
                    format!(
                        "Remote connectors did not sync within {} seconds.",
                        REMOTE_TIMEOUT.as_secs()
                    )
                })??,
        };
        let subscribed = subscription.insert(subscribed);
        while let Some(update) = subscribed.next().now_or_never() {
            if let Err(error) = self.apply_remote(update) {
                *subscription = None;
                return Err(error);
            }
        }
        Ok(self
            .remote
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone())
    }

    async fn subscribe_remote(&self) -> anyhow::Result<sprocket_convex::Subscription> {
        let mut subscribed = self
            .host
            .convex_client_for(&self.user_id)
            .await?
            .subscribe(LIST_REMOTE_SERVERS, BTreeMap::new())
            .await?;
        self.apply_remote(subscribed.next().await)?;
        Ok(subscribed)
    }

    fn apply_remote(&self, update: Option<convex::FunctionResult>) -> anyhow::Result<()> {
        let update = update.context("Remote connector subscription closed.")?;
        self.update_remote(sprocket_convex::decode_labeled_function_result(
            update,
            LIST_REMOTE_SERVERS,
        )?);
        Ok(())
    }

    fn update_remote(&self, servers: Vec<RemoteServer>) {
        let mut remote = self.remote.lock().unwrap_or_else(|e| e.into_inner());
        let mut connections = self.connections.lock().unwrap_or_else(|e| e.into_inner());
        for previous in remote.iter() {
            if !servers.iter().any(|s| {
                s.connector_id == previous.connector_id
                    && s.url == previous.url
                    && s.status == previous.status
            }) {
                connections.remove(&previous.id());
            }
        }
        *remote = servers;
    }

    async fn connection(&self, server: &McpServer) -> anyhow::Result<Arc<McpClient>> {
        let remote = match remote_connector_id(&server.connector.id) {
            Some(id) => {
                let remote = self.remote.lock().unwrap_or_else(|e| e.into_inner());
                let remote = remote
                    .iter()
                    .find(|s| s.connector_id == id)
                    .context("Connector was removed.")?;
                ensure!(
                    remote.status == ConnectorStatus::Connected,
                    "{} needs you to connect it in Settings → Connectors.",
                    remote.name
                );
                Some((id, remote.url.clone()))
            }
            None => None,
        };
        let slot = self
            .connections
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(server.connector.id.clone())
            .or_default()
            .clone();
        let mut slot = slot.lock().await;
        match slot.as_ref() {
            Some(Connection::Connected(client)) if !client.is_closed() => return Ok(client.clone()),
            Some(Connection::Failed { error, at }) if at.elapsed() < RETRY_AFTER => {
                bail!("{error}")
            }
            _ => {}
        }
        *slot = None;
        let connected = match &remote {
            Some((id, url)) => McpClient::connect_remote(&self.host, &self.user_id, id, url).await,
            None => McpClient::connect(&self.host, server).await,
        };
        match connected {
            Ok(client) => {
                let client = Arc::new(client);
                *slot = Some(Connection::Connected(client.clone()));
                Ok(client)
            }
            Err(error) => {
                *slot = Some(Connection::Failed {
                    error: format!("{error:#}"),
                    at: Instant::now(),
                });
                Err(error)
            }
        }
    }

    async fn server(&self, id: &str) -> anyhow::Result<McpServer> {
        if let Some(remote_id) = remote_connector_id(id) {
            return self
                .remote_servers()
                .await?
                .into_iter()
                .find(|s| s.connector_id == remote_id)
                .map(|s| s.config())
                .with_context(|| format!("No MCP server has the ID '{id}'."));
        }
        let id = id.to_string();
        self.host.mcp.run(move |store| store.get(&id)).await
    }

    async fn resolve(&self, path: &str) -> anyhow::Result<(McpServer, Arc<McpClient>, Tool)> {
        let (id, name) = split_tool_path(path).context("Use a tool path from service_search.")?;
        let server = self.server(id).await?;
        let client = self.connection(&server).await?;
        let tool = client
            .tools()
            .await?
            .into_iter()
            .find(|tool| tool.name == name)
            .with_context(|| format!("No service tool has the path '{path}'."))?;
        Ok((server, client, tool))
    }

    async fn cli_hits(&self, keywords: &[String]) -> Vec<(usize, SearchHit)> {
        join_all(CliConnector::ALL.into_iter().filter_map(|connector| {
            let score = keyword_score(
                keywords,
                &[connector.id(), connector.name(), connector.keywords()],
            );
            (score > 0).then_some(async move {
                let set_up =
                    tokio::time::timeout(CLI_STATUS_TIMEOUT, connector.is_set_up(&self.host))
                        .await
                        .unwrap_or(true);
                (!set_up).then(|| {
                    (
                        score,
                        SearchHit::NotConnected {
                            connector: connector.name().into(),
                            connector_id: connector.id().into(),
                        },
                    )
                })
            })
        }))
        .await
        .into_iter()
        .flatten()
        .collect()
    }
}

impl ServiceHub for RunServiceHub {
    fn search<'a>(&'a self, query: &'a str, limit: usize) -> BoxFuture<'a, SearchResults> {
        Box::pin(async move {
            let mut result = SearchResults::default();
            let keywords: Vec<_> = query.split_whitespace().map(str::to_lowercase).collect();
            let (local, remote) = tokio::join!(
                self.host.mcp.run(|store| store.list()),
                self.remote_servers()
            );
            let mut servers = Vec::new();
            let mut not_connected = Vec::new();
            match local {
                Ok(local) => servers.extend(local),
                Err(error) => result.unavailable.push(Unavailable {
                    connector: "Local MCP connectors".into(),
                    error: format!("{error:#}"),
                }),
            }
            match remote {
                Ok(remote) => {
                    for server in remote {
                        if server.status == ConnectorStatus::Connected {
                            servers.push(server.config());
                            continue;
                        }
                        let id = server.id();
                        let score = keyword_score(&keywords, &[&id, &server.name]);
                        if score > 0 {
                            not_connected.push((
                                score,
                                SearchHit::NotConnected {
                                    connector: server.name,
                                    connector_id: id,
                                },
                            ));
                        }
                    }
                }
                Err(error) => result.unavailable.push(Unavailable {
                    connector: "Remote MCP connectors".into(),
                    error: format!("{error:#}"),
                }),
            }
            let (servers, mut hits) = tokio::join!(
                join_all(servers.into_iter().map(|server| async move {
                    let tools = async { self.connection(&server).await?.tools().await }.await;
                    (server, tools)
                })),
                self.cli_hits(&keywords)
            );
            hits.extend(not_connected);
            for (server, tools) in servers {
                match tools {
                    Ok(tools) => hits.extend(tools.into_iter().filter_map(|tool| {
                        let policy = effective_policy(&server, &tool);
                        if policy == ToolPolicy::Disabled {
                            return None;
                        }
                        let description = tool.description.as_deref().unwrap_or_default();
                        let score = keyword_score(
                            &keywords,
                            &[
                                &server.connector.id,
                                &server.connector.name,
                                &tool.name,
                                tool.title.as_deref().unwrap_or_default(),
                                description,
                            ],
                        );
                        (score > 0).then(|| {
                            (
                                score,
                                SearchHit::Connected {
                                    path: format!("{}/{}", server.connector.id, tool.name),
                                    connector: server.connector.name.clone(),
                                    description: description
                                        .chars()
                                        .take(MAX_SEARCH_DESCRIPTION_CHARS)
                                        .collect(),
                                    policy,
                                },
                            )
                        })
                    })),
                    Err(error) => result.unavailable.push(Unavailable {
                        connector: server.connector.name,
                        error: format!("{error:#}"),
                    }),
                }
            }
            hits.sort_by_key(|hit| std::cmp::Reverse(hit.0));
            result.results = hits.into_iter().take(limit).map(|(_, hit)| hit).collect();
            result
        })
    }

    fn describe<'a>(&'a self, paths: &'a [String]) -> BoxFuture<'a, Descriptions> {
        Box::pin(async move {
            let mut result = Descriptions::default();
            for (path, resolved) in join_all(
                paths
                    .iter()
                    .map(|path| async move { (path, self.resolve(path).await) }),
            )
            .await
            {
                let described = resolved.ok().and_then(|(server, _, tool)| {
                    let policy = effective_policy(&server, &tool);
                    (policy != ToolPolicy::Disabled).then(|| ToolDescription {
                        path: path.clone(),
                        policy,
                        description: tool
                            .description
                            .map(|value| value.into_owned())
                            .unwrap_or_default(),
                        input_schema: Value::Object((*tool.input_schema).clone()),
                        output_schema: tool
                            .output_schema
                            .map(|value| Value::Object((*value).clone())),
                        annotations: tool.annotations.map(|value| {
                            serde_json::to_value(value).expect("serializable annotations")
                        }),
                    })
                });
                match described {
                    Some(tool) => result.tools.push(tool),
                    None => result.missing.push(path.clone()),
                }
            }
            result
        })
    }

    fn tool<'a>(&'a self, path: &'a str) -> BoxFuture<'a, anyhow::Result<ServiceTool>> {
        Box::pin(async move {
            let (server, _, tool) = self.resolve(path).await?;
            Ok(ServiceTool {
                policy: effective_policy(&server, &tool),
                connector: server.connector.name,
                tool: tool.name.into_owned(),
            })
        })
    }

    fn call<'a>(
        &'a self,
        path: &'a str,
        arguments: JsonObject,
    ) -> BoxFuture<'a, anyhow::Result<Value>> {
        Box::pin(async move {
            let (server, client, tool) = self.resolve(path).await?;
            ensure!(
                effective_policy(&server, &tool) != ToolPolicy::Disabled,
                "This service tool is disabled in Settings."
            );
            client.call(&tool.name, arguments).await
        })
    }

    fn save_policy<'a>(
        &'a self,
        path: &'a str,
        policy: ToolPolicy,
    ) -> BoxFuture<'a, anyhow::Result<()>> {
        Box::pin(async move {
            let (id, tool) = split_tool_path(path).context("Invalid service tool path.")?;
            set_tool_policy(&self.host, &self.user_id, id, tool, policy).await
        })
    }

    fn connector_name(&self, id: &str) -> Option<String> {
        if let Some(connector) = CliConnector::from_id(id) {
            return Some(connector.name().to_string());
        }
        let remote_id = remote_connector_id(id)?;
        self.remote
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .find(|s| s.connector_id == remote_id)
            .map(|s| s.name.clone())
    }
}

fn read_only(tool: &Tool) -> bool {
    tool.annotations
        .as_ref()
        .and_then(|hints| hints.read_only_hint)
        == Some(true)
}

fn effective_policy(server: &McpServer, tool: &Tool) -> ToolPolicy {
    server
        .policies
        .get(tool.name.as_ref())
        .copied()
        .unwrap_or_else(|| ToolPolicy::default_for(read_only(tool)))
}

fn keyword_score(keywords: &[String], fields: &[&str]) -> usize {
    let text = fields.join(" ").to_lowercase();
    keywords
        .iter()
        .filter(|keyword| text.contains(keyword.as_str()))
        .count()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerTool {
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    read_only: bool,
    destructive: bool,
    policy: ToolPolicy,
}

pub async fn set_tool_policy(
    host: &Host,
    user_id: &str,
    id: &str,
    tool: &str,
    policy: ToolPolicy,
) -> anyhow::Result<()> {
    if let Some(id) = remote_connector_id(id) {
        let _: Value = host
            .convex_client_for(user_id)
            .await?
            .mutate(
                "mcpServers:setPolicy",
                BTreeMap::from([
                    ("connectorId".into(), id.to_owned().into()),
                    ("tool".into(), tool.to_owned().into()),
                    (
                        "policy".into(),
                        convex::Value::try_from(serde_json::to_value(policy)?)?,
                    ),
                ]),
            )
            .await?;
        return Ok(());
    }
    let (id, tool) = (id.to_owned(), tool.to_owned());
    host.mcp
        .run(move |store| store.set_policy(&id, &tool, policy))
        .await
}

pub async fn list_server_tools(
    host: &Host,
    user_id: &str,
    id: &str,
) -> anyhow::Result<Vec<ServerTool>> {
    if remote_connector_id(id).is_some() {
        host.machines.register(user_id).await?;
    }
    let hub = RunServiceHub::new(host, user_id);
    let server = hub.server(id).await?;
    let client = hub.connection(&server).await?;
    Ok(client
        .tools()
        .await?
        .into_iter()
        .map(|tool| {
            let read_only = read_only(&tool);
            ServerTool {
                read_only,
                destructive: !read_only
                    && tool
                        .annotations
                        .as_ref()
                        .and_then(|hints| hints.destructive_hint)
                        .unwrap_or(true),
                policy: effective_policy(&server, &tool),
                name: tool.name.into_owned(),
                title: tool.title,
                description: tool.description.map(|value| value.into_owned()),
            }
        })
        .collect())
}

#[cfg(test)]
mod tests;
