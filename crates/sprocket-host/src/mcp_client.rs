use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::Context;
use process_wrap::tokio::{ChildWrapper, CommandWrap, KillOnDrop};
use rmcp::model::{
    CallToolRequestParams, ClientCapabilities, ClientConfig, ErrorCode, Implementation,
    ProtocolVersion, SubscriptionFilter, Tool,
};
use rmcp::service::{
    ClientCacheConfig, ClientLifecycleMode, ClientServiceExt, RunningService, ServiceError,
};
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::{IntoTransport, StreamableHttpClientTransport};
use rmcp::{ClientHandler, RoleClient};
use serde_json::Value;
use sprocket_agent::services::{JsonObject, loopback_http_url};

use crate::Host;
use crate::mcp_store::{McpServer, McpTransport};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

pub(crate) struct McpClient {
    service: RunningService<RoleClient, Handler>,
    _process: Option<Process>,
}

impl McpClient {
    pub(crate) async fn connect(host: &Host, server: &McpServer) -> anyhow::Result<Self> {
        tokio::time::timeout(REQUEST_TIMEOUT, async {
            let id = server.connector.id.clone();
            let secrets = host.mcp.run(move |store| store.secrets(&id)).await?;
            match &server.connector.transport {
                McpTransport::Stdio { command, args, .. } => {
                    let mut environment = host.tool_environment();
                    environment.extend(secrets.into_iter().map(|(k, v)| (k.into(), v.into())));
                    let mut command =
                        tokio::process::Command::new(resolve_command(command, &environment)?);
                    command.args(args).envs(environment);
                    let (process, transport) = spawn_process(command)?;
                    Self::serve(transport, Some(process)).await
                }
                McpTransport::Http { url, .. } => {
                    let url = loopback_http_url(url)?;
                    let headers = secrets
                        .into_iter()
                        .map(|(name, value)| {
                            Ok((
                                reqwest::header::HeaderName::from_bytes(name.as_bytes())?,
                                reqwest::header::HeaderValue::from_str(&value)?,
                            ))
                        })
                        .collect::<anyhow::Result<_>>()?;
                    let transport = StreamableHttpClientTransport::with_client(
                        http_client()?,
                        StreamableHttpClientTransportConfig::with_uri(url.as_str())
                            .custom_headers(headers),
                    );
                    Self::serve(transport, None).await
                }
            }
        })
        .await
        .with_context(|| {
            format!(
                "MCP server did not connect within {} seconds",
                REQUEST_TIMEOUT.as_secs()
            )
        })?
        .with_context(|| {
            format!(
                "Could not connect to MCP server '{}'",
                server.connector.name
            )
        })
    }

    async fn serve<T, E, A>(transport: T, process: Option<Process>) -> anyhow::Result<Self>
    where
        T: IntoTransport<RoleClient, E, A>,
        E: std::error::Error + Send + Sync + 'static,
    {
        let service = Handler
            .serve_with_lifecycle(
                transport,
                ClientLifecycleMode::Auto {
                    preferred_versions: vec![ProtocolVersion::V_2026_07_28],
                    legacy_version: Some(ProtocolVersion::V_2025_11_25),
                },
            )
            .await?;
        service
            .set_response_cache_config(
                ClientCacheConfig::default().with_default_ttl(Duration::from_secs(600)),
            )
            .await;
        if service
            .peer_info()
            .is_some_and(|info| info.protocol_version >= ProtocolVersion::V_2026_07_28)
        {
            match service
                .peer()
                .listen(SubscriptionFilter::builder().tools_list_changed().build())
                .await
            {
                Ok(mut subscription) => {
                    // rmcp invalidates the tool cache itself; draining keeps the buffer from
                    // overflowing, and the loop ends when the service closes.
                    tokio::spawn(
                        async move { while let Ok(Some(_)) = subscription.next().await {} },
                    );
                }
                Err(ServiceError::McpError(error)) if error.code == ErrorCode::METHOD_NOT_FOUND => {
                }
                Err(error) => return Err(error.into()),
            }
        }
        Ok(Self {
            service,
            _process: process,
        })
    }

    pub(crate) fn is_closed(&self) -> bool {
        self.service.is_closed() || self.service.peer().is_transport_closed()
    }

    pub(crate) async fn tools(&self) -> anyhow::Result<Vec<Tool>> {
        tokio::time::timeout(REQUEST_TIMEOUT, self.service.list_all_tools())
            .await
            .with_context(|| {
                format!(
                    "MCP server did not list its tools within {} seconds",
                    REQUEST_TIMEOUT.as_secs()
                )
            })?
            .map_err(Into::into)
    }

    pub(crate) async fn call(&self, name: &str, arguments: JsonObject) -> anyhow::Result<Value> {
        let mut params = CallToolRequestParams::new(name.to_owned());
        params.arguments = Some(arguments);
        let result = self.service.call_tool(params).await?;
        let mut output = JsonObject::new();
        output.insert("content".into(), serde_json::to_value(result.content)?);
        if let Some(content) = result.structured_content {
            output.insert("structuredContent".into(), content);
        }
        if let Some(is_error) = result.is_error {
            output.insert("isError".into(), is_error.into());
        }
        Ok(Value::Object(output))
    }
}

fn http_client() -> anyhow::Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .build()?)
}

struct Handler;

impl ClientHandler for Handler {
    fn get_info(&self) -> ClientConfig {
        ClientConfig::new(
            ClientCapabilities::default(),
            Implementation::new("sprocket", env!("CARGO_PKG_VERSION")),
        )
    }
}

struct Process(Box<dyn ChildWrapper>);

impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.0.start_kill();
    }
}

fn spawn_process(
    command: tokio::process::Command,
) -> anyhow::Result<(
    Process,
    (tokio::process::ChildStdout, tokio::process::ChildStdin),
)> {
    let mut command = CommandWrap::from(command);
    command.wrap(KillOnDrop);
    #[cfg(unix)]
    command.wrap(process_wrap::tokio::ProcessGroup::leader());
    #[cfg(windows)]
    {
        command.wrap(process_wrap::tokio::JobObject);
        command.wrap(process_wrap::tokio::CreationFlags(
            windows::Win32::System::Threading::CREATE_NO_WINDOW,
        ));
    }
    command
        .command_mut()
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    let mut process = Process(command.spawn()?);
    let child = process.0.inner_mut();
    let stdout = child
        .stdout()
        .take()
        .context("MCP server stdout is missing")?;
    let stdin = child
        .stdin()
        .take()
        .context("MCP server stdin is missing")?;
    Ok((process, (stdout, stdin)))
}

fn environment_value(environment: &[(OsString, OsString)], name: &str) -> Option<OsString> {
    environment
        .iter()
        .rev()
        .find(|(key, _)| {
            #[cfg(windows)]
            {
                key.to_string_lossy().eq_ignore_ascii_case(name)
            }
            #[cfg(not(windows))]
            {
                key == name
            }
        })
        .map(|(_, value)| value.clone())
        .or_else(|| std::env::var_os(name))
}

fn resolve_command(command: &str, environment: &[(OsString, OsString)]) -> anyhow::Result<PathBuf> {
    let command = Path::new(command);
    let cwd = std::env::current_dir()?;
    let directories = if command.components().count() > 1 || command.is_absolute() {
        vec![cwd.clone()]
    } else {
        environment_value(environment, "PATH")
            .map(|path| std::env::split_paths(&path).collect())
            .unwrap_or_default()
    };
    let extensions = vec![OsString::new()];
    #[cfg(windows)]
    let extensions = {
        let mut extensions = extensions;
        if command.extension().is_none() {
            extensions.extend(
                environment_value(environment, "PATHEXT")
                    .unwrap_or_else(|| ".COM;.EXE;.BAT;.CMD".into())
                    .to_string_lossy()
                    .split(';')
                    .filter(|ext| !ext.is_empty())
                    .map(OsString::from),
            );
        }
        extensions
    };
    for directory in directories {
        let base = cwd.join(directory).join(command);
        for extension in &extensions {
            let mut path = base.clone().into_os_string();
            path.push(extension);
            let path = PathBuf::from(path);
            if is_executable(&path) {
                return Ok(path);
            }
        }
    }
    anyhow::bail!(
        "MCP command '{}' was not found in the tool environment PATH",
        command.display()
    )
}

fn is_executable(path: &Path) -> bool {
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

#[cfg(test)]
mod tests;
