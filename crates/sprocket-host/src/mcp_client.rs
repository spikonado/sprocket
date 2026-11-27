use std::collections::{BTreeMap, HashMap};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::Context;
use futures::{StreamExt, TryStreamExt, future::BoxFuture};
use process_wrap::tokio::{ChildWrapper, CommandWrap, KillOnDrop};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use rmcp::model::{
    CallToolRequestParams, ClientCapabilities, ClientConfig, ClientJsonRpcMessage, ClientRequest,
    ErrorCode, Implementation, ProtocolVersion, SubscriptionFilter, Tool,
};
use rmcp::service::{
    ClientCacheConfig, ClientLifecycleMode, ClientServiceExt, RunningService, ServiceError,
};
use rmcp::transport::common::client_side_sse::BoxedSseResponse;
use rmcp::transport::streamable_http_client::{
    AuthRequiredError, HttpStatusError, InsufficientScopeError, StreamableHttpClient,
    StreamableHttpClientTransportConfig, StreamableHttpError, StreamableHttpPostResponse,
    StreamableHttpResponseLimits,
};
use rmcp::transport::{IntoTransport, StreamableHttpClientTransport};
use rmcp::{ClientHandler, RoleClient};
use serde_json::Value;
use sprocket_agent::services::{JsonObject, loopback_http_url, mcp_http_url};

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

    pub(crate) async fn connect_remote(
        host: &Host,
        user_id: &str,
        connector_id: &str,
        url: &str,
    ) -> anyhow::Result<Self> {
        tokio::time::timeout(REQUEST_TIMEOUT, async {
            let url = mcp_http_url(url)?;
            let client = host.convex_client_for(user_id).await?;
            let args = BTreeMap::from([
                (
                    "connectorId".into(),
                    convex::Value::from(connector_id.to_owned()),
                ),
                (
                    "machineId".into(),
                    host.machine_identity.installation_id.clone().into(),
                ),
                (
                    "processId".into(),
                    host.machine_identity.process_id.clone().into(),
                ),
            ]);
            let issue: IssueCredential = Arc::new(move |force_refresh| {
                let client = client.clone();
                let mut args = args.clone();
                args.insert("forceRefresh".into(), force_refresh.into());
                Box::pin(async move { client.act("mcpServers:issueCredential", args).await })
            });
            let client = RemoteHttpClient::new(issue).await?;
            let transport = StreamableHttpClientTransport::with_client(
                client,
                StreamableHttpClientTransportConfig::with_uri(url.as_str()),
            );
            Self::serve(transport, None).await
        })
        .await
        .with_context(|| {
            format!(
                "Remote MCP server did not connect within {} seconds",
                REQUEST_TIMEOUT.as_secs()
            )
        })?
        .context("Could not connect to remote MCP server")
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

type HttpError = StreamableHttpError<reqwest::Error>;
type IssueCredential =
    Arc<dyn Fn(bool) -> BoxFuture<'static, anyhow::Result<IssuedCredential>> + Send + Sync>;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct IssuedCredential {
    headers: HashMap<String, String>,
    expires_at: Option<f64>,
}

struct Credential {
    headers: HeaderMap,
    expires_at: Option<tokio::time::Instant>,
}

impl IssuedCredential {
    fn prepare(self) -> anyhow::Result<Credential> {
        let mut headers = HeaderMap::new();
        for (name, value) in self.headers {
            let mut value = HeaderValue::from_str(&value)?;
            value.set_sensitive(true);
            headers.insert(HeaderName::from_bytes(name.as_bytes())?, value);
        }
        let expires_at = self.expires_at.map(|expires_at| {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default();
            let remaining = Duration::try_from_secs_f64(expires_at / 1000.0 - now.as_secs_f64())
                .unwrap_or_default();
            let now = tokio::time::Instant::now();
            now.checked_add(remaining).unwrap_or(now)
        });
        Ok(Credential {
            headers,
            expires_at,
        })
    }
}

#[derive(Clone)]
struct RemoteHttpClient {
    client: reqwest::Client,
    issue: IssueCredential,
    credential: Arc<tokio::sync::Mutex<Arc<Credential>>>,
}

impl RemoteHttpClient {
    async fn new(issue: IssueCredential) -> anyhow::Result<Self> {
        let credential = Arc::new(issue(false).await?.prepare()?);
        Ok(Self {
            client: http_client()?,
            issue,
            credential: Arc::new(tokio::sync::Mutex::new(credential)),
        })
    }

    async fn credential(
        &self,
        rejected: Option<&Arc<Credential>>,
    ) -> Result<Arc<Credential>, HttpError> {
        let mut current = self.credential.lock().await;
        let force_refresh = rejected.is_some_and(|rejected| Arc::ptr_eq(rejected, &current));
        if force_refresh
            || current
                .expires_at
                .is_some_and(|expiry| expiry <= tokio::time::Instant::now())
        {
            *current = Arc::new(
                (self.issue)(force_refresh)
                    .await
                    .and_then(IssuedCredential::prepare)
                    .map_err(|error| HttpError::Io(std::io::Error::other(error)))?,
            );
        }
        Ok(Arc::clone(&current))
    }

    async fn send(&self, request: reqwest::RequestBuilder) -> Result<reqwest::Response, HttpError> {
        let request = request.build()?;
        let credential = self.credential(None).await?;
        let mut first = request.try_clone().ok_or_else(|| {
            HttpError::Io(std::io::Error::other("MCP request body cannot be replayed"))
        })?;
        first.headers_mut().extend(credential.headers.clone());
        let response = self.client.execute(first).await?;
        if response.status() != reqwest::StatusCode::UNAUTHORIZED {
            return Ok(response);
        }
        drop(response);
        let credential = self.credential(Some(&credential)).await?;
        let mut retry = request;
        retry.headers_mut().extend(credential.headers.clone());
        Ok(self.client.execute(retry).await?)
    }

    fn request(
        &self,
        method: reqwest::Method,
        uri: &str,
        session_id: Option<&str>,
        custom_headers: HashMap<HeaderName, HeaderValue>,
    ) -> reqwest::RequestBuilder {
        let mut request = self
            .client
            .request(method, uri)
            .header(
                reqwest::header::ACCEPT,
                "application/json, text/event-stream",
            )
            .headers(custom_headers.into_iter().collect());
        if let Some(session_id) = session_id {
            request = request.header("mcp-session-id", session_id);
        }
        request
    }
}

fn status_error(response: &reqwest::Response) -> HttpError {
    match response.status() {
        reqwest::StatusCode::UNAUTHORIZED => {
            HttpError::AuthRequired(AuthRequiredError::new(String::new()))
        }
        reqwest::StatusCode::FORBIDDEN => {
            HttpError::InsufficientScope(InsufficientScopeError::new(String::new(), None))
        }
        status => HttpStatusError::new(
            status.as_u16(),
            response
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned),
        )
        .into(),
    }
}

fn content_type(response: &reqwest::Response) -> Option<String> {
    response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
}

fn has_media_type(content_type: Option<&str>, expected: &str) -> bool {
    content_type.is_some_and(|value| {
        value
            .split(';')
            .next()
            .unwrap_or_default()
            .trim()
            .eq_ignore_ascii_case(expected)
    })
}

async fn json_body(response: reqwest::Response, max_size: usize) -> Result<Vec<u8>, HttpError> {
    if response
        .content_length()
        .is_some_and(|length| length > max_size as u64)
    {
        return Err(HttpError::ResponseBodyTooLarge { max_size });
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.try_next().await? {
        if chunk.len() > max_size - body.len() {
            return Err(HttpError::ResponseBodyTooLarge { max_size });
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn sse_body(response: reqwest::Response, max_size: usize) -> BoxedSseResponse {
    let mut size = 0;
    let mut empty_line = true;
    let mut previous_cr = false;
    let stream = response.bytes_stream().map(move |chunk| {
        let chunk = chunk.map_err(std::io::Error::other)?;
        for &byte in &chunk {
            if previous_cr && byte == b'\n' {
                previous_cr = false;
                continue;
            }
            previous_cr = byte == b'\r';
            if matches!(byte, b'\r' | b'\n') {
                if empty_line {
                    size = 0;
                }
                empty_line = true;
            } else {
                empty_line = false;
            }
            size += 1;
            if size > max_size {
                return Err(std::io::Error::other(
                    "MCP SSE event exceeded its size limit",
                ));
            }
        }
        Ok(chunk)
    });
    sse_stream::SseStream::from_bytes_stream(stream).boxed()
}

impl StreamableHttpClient for RemoteHttpClient {
    type Error = reqwest::Error;

    async fn post_message(
        &self,
        uri: Arc<str>,
        message: ClientJsonRpcMessage,
        session_id: Option<Arc<str>>,
        auth_header: Option<String>,
        custom_headers: HashMap<HeaderName, HeaderValue>,
    ) -> Result<StreamableHttpPostResponse, HttpError> {
        self.post_message_with_response_limits(
            uri,
            message,
            session_id,
            auth_header,
            custom_headers,
            StreamableHttpResponseLimits::default(),
        )
        .await
    }

    async fn post_message_with_max_sse_event_size(
        &self,
        uri: Arc<str>,
        message: ClientJsonRpcMessage,
        session_id: Option<Arc<str>>,
        auth_header: Option<String>,
        custom_headers: HashMap<HeaderName, HeaderValue>,
        max_sse_event_size: usize,
    ) -> Result<StreamableHttpPostResponse, HttpError> {
        let mut limits = StreamableHttpResponseLimits::default();
        limits.max_sse_event_size = max_sse_event_size;
        self.post_message_with_response_limits(
            uri,
            message,
            session_id,
            auth_header,
            custom_headers,
            limits,
        )
        .await
    }

    async fn post_message_with_response_limits(
        &self,
        uri: Arc<str>,
        message: ClientJsonRpcMessage,
        session_id: Option<Arc<str>>,
        _auth_header: Option<String>,
        custom_headers: HashMap<HeaderName, HeaderValue>,
        limits: StreamableHttpResponseLimits,
    ) -> Result<StreamableHttpPostResponse, HttpError> {
        let response = self
            .send(
                self.request(
                    reqwest::Method::POST,
                    &uri,
                    session_id.as_deref(),
                    custom_headers,
                )
                .json(&message),
            )
            .await?;
        let status = response.status();
        if status == reqwest::StatusCode::NOT_FOUND && session_id.is_some() {
            return Err(HttpError::SessionExpired);
        }
        let content_type = content_type(&response);
        let is_json = has_media_type(content_type.as_deref(), "application/json");
        let response_session = response
            .headers()
            .get("mcp-session-id")
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        if !status.is_success() {
            let error = status_error(&response);
            if matches!(
                status,
                reqwest::StatusCode::UNAUTHORIZED
                    | reqwest::StatusCode::FORBIDDEN
                    | reqwest::StatusCode::TOO_MANY_REQUESTS
            ) {
                return Err(error);
            }
            let discovery = match &message {
                ClientJsonRpcMessage::Request(request)
                    if session_id.is_none()
                        && status.is_client_error()
                        && matches!(request.request, ClientRequest::DiscoverRequest(_)) =>
                {
                    Some(request.id.clone())
                }
                _ => None,
            };
            let parsed = if is_json {
                json_body(response, limits.max_json_response_size)
                    .await
                    .ok()
                    .and_then(|body| {
                        serde_json::from_slice::<rmcp::model::ServerJsonRpcMessage>(&body).ok()
                    })
            } else {
                None
            };
            if let Some(id) = discovery {
                let error = match parsed {
                    Some(rmcp::model::ServerJsonRpcMessage::Error(error)) => error.error,
                    _ => {
                        rmcp::ErrorData::invalid_request("Server does not support discovery", None)
                    }
                };
                return Ok(StreamableHttpPostResponse::Json(
                    rmcp::model::ServerJsonRpcMessage::error(error, Some(id)),
                    response_session,
                ));
            }
            if let Some(message @ rmcp::model::ServerJsonRpcMessage::Error(_)) = parsed {
                return Ok(StreamableHttpPostResponse::Json(message, response_session));
            }
            return Err(error);
        }
        let awaits_no_response = !matches!(message, ClientJsonRpcMessage::Request(_));
        if matches!(
            status,
            reqwest::StatusCode::ACCEPTED | reqwest::StatusCode::NO_CONTENT
        ) || (awaits_no_response && response.content_length() == Some(0))
        {
            return Ok(StreamableHttpPostResponse::Accepted);
        }
        if has_media_type(content_type.as_deref(), "text/event-stream") {
            return Ok(StreamableHttpPostResponse::Sse(
                sse_body(response, limits.max_sse_event_size),
                response_session,
            ));
        }
        if is_json {
            let body = json_body(response, limits.max_json_response_size).await?;
            return match serde_json::from_slice(&body) {
                Ok(message) => Ok(StreamableHttpPostResponse::Json(message, response_session)),
                Err(_) if awaits_no_response => Ok(StreamableHttpPostResponse::Accepted),
                Err(error) => Err(HttpError::Deserialize(error)),
            };
        }
        if awaits_no_response {
            return Ok(StreamableHttpPostResponse::Accepted);
        }
        Err(HttpError::UnexpectedContentType(content_type))
    }

    async fn delete_session(
        &self,
        uri: Arc<str>,
        session_id: Arc<str>,
        _auth_header: Option<String>,
        custom_headers: HashMap<HeaderName, HeaderValue>,
    ) -> Result<(), HttpError> {
        let response = self
            .send(self.request(
                reqwest::Method::DELETE,
                &uri,
                Some(&session_id),
                custom_headers,
            ))
            .await?;
        if response.status().is_success()
            || response.status() == reqwest::StatusCode::METHOD_NOT_ALLOWED
        {
            Ok(())
        } else {
            Err(status_error(&response))
        }
    }

    async fn get_stream(
        &self,
        uri: Arc<str>,
        session_id: Option<Arc<str>>,
        last_event_id: Option<String>,
        auth_header: Option<String>,
        custom_headers: HashMap<HeaderName, HeaderValue>,
    ) -> Result<BoxedSseResponse, HttpError> {
        self.get_stream_with_max_sse_event_size(
            uri,
            session_id,
            last_event_id,
            auth_header,
            custom_headers,
            StreamableHttpResponseLimits::default().max_sse_event_size,
        )
        .await
    }

    async fn get_stream_with_max_sse_event_size(
        &self,
        uri: Arc<str>,
        session_id: Option<Arc<str>>,
        last_event_id: Option<String>,
        _auth_header: Option<String>,
        custom_headers: HashMap<HeaderName, HeaderValue>,
        max_sse_event_size: usize,
    ) -> Result<BoxedSseResponse, HttpError> {
        let mut request = self.request(
            reqwest::Method::GET,
            &uri,
            session_id.as_deref(),
            custom_headers,
        );
        if let Some(last_event_id) = last_event_id {
            request = request.header("last-event-id", last_event_id);
        }
        let response = self.send(request).await?;
        match response.status() {
            reqwest::StatusCode::METHOD_NOT_ALLOWED => {
                return Err(HttpError::ServerDoesNotSupportSse);
            }
            reqwest::StatusCode::NOT_FOUND if session_id.is_some() => {
                return Err(HttpError::SessionExpired);
            }
            status if !status.is_success() => return Err(status_error(&response)),
            _ => (),
        }
        let content_type = content_type(&response);
        if !has_media_type(content_type.as_deref(), "text/event-stream") {
            return Err(HttpError::UnexpectedContentType(content_type));
        }
        Ok(sse_body(response, max_sse_event_size))
    }
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
