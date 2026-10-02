use std::sync::Arc;

use anyhow::Context;
use bytes::Bytes;
use futures::StreamExt;
use rig::client::CompletionClient;
use rig::completion::{CompletionError, CompletionModel, CompletionRequest, CompletionResponse};
use rig::http_client::{self, HeaderValue, HttpClientExt, Request, Response};
use rig::providers::openai;
use rig::providers::openai::responses_api::SystemInstructionsPlacement;
#[cfg(test)]
use rig::providers::openai::responses_api::{
    CompletionRequest as ResponsesCompletionRequest, ResponsesRequestParams,
    ResponsesToolDefinition,
};
use rig::streaming::StreamingCompletionResponse;
use rig::wasm_compat::WasmCompatSend;

use crate::live::now_ms;
use crate::openai::replay_contents;
use crate::types::ChatGptCredentials;

const CONNECTION_CHANGED: &str =
    "ChatGPT connection changed or became unavailable. Start a new run.";
const STREAM_REQUIRED: &str =
    "ChatGPT inference requires streaming; non-streaming completion is not supported.";
const STREAM_INTERRUPTED: &str = "ChatGPT response stream ended before a terminal response event.";
const SIWC_TOOL_NAMESPACE: &str = "sprocket";
const ERROR_BODY_LIMIT: usize = 64 * 1024;
const ERROR_BODY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

const UNSUPPORTED_FIELDS: &[&str] = &[
    "background",
    "conversation",
    "max_output_tokens",
    "max_tool_calls",
    "metadata",
    "moderation",
    "multi_agent",
    "prompt",
    "prompt_cache_key",
    "prompt_cache_retention",
    "previous_response_id",
    "safety_identifier",
    "temperature",
    "top_logprobs",
    "top_p",
    "truncation",
    "user",
];

struct PinnedConnection {
    receiver: tokio::sync::watch::Receiver<Option<String>>,
    pinned: String,
    valid: bool,
}

impl PinnedConnection {
    fn pin(credentials: &dyn ChatGptCredentials) -> anyhow::Result<Self> {
        let mut receiver = credentials.connection();
        let pinned = receiver
            .borrow_and_update()
            .clone()
            .context("ChatGPT is not connected. Connect in Settings.")?;
        let mut connection = Self {
            receiver,
            pinned,
            valid: true,
        };
        connection.check()?;
        Ok(connection)
    }

    fn check(&mut self) -> anyhow::Result<()> {
        anyhow::ensure!(self.valid, "{CONNECTION_CHANGED}");
        loop {
            match self.receiver.has_changed() {
                Ok(true) => {
                    let current = self.receiver.borrow_and_update().clone();
                    if current.as_deref() == Some(self.pinned.as_str()) {
                        continue;
                    }
                    self.valid = false;
                    anyhow::bail!("{CONNECTION_CHANGED}");
                }
                Ok(false) => return Ok(()),
                Err(_) => {
                    self.valid = false;
                    anyhow::bail!("{CONNECTION_CHANGED}");
                }
            }
        }
    }
}

type SharedConnection = Arc<tokio::sync::Mutex<PinnedConnection>>;

fn stream_error(message: impl Into<String>) -> http_client::Error {
    http_client::Error::Instance(message.into().into())
}

fn check_connection(connection: &SharedConnection) -> http_client::Result<()> {
    connection
        .try_lock()
        .map_err(|_| stream_error(CONNECTION_CHANGED))?
        .check()
        .map_err(|error| stream_error(error.to_string()))
}

async fn access_token(
    credentials: &Arc<dyn ChatGptCredentials>,
    connection: &SharedConnection,
) -> anyhow::Result<String> {
    connection.lock().await.check()?;
    let access = credentials.credential().await?;
    let mut connection = connection.lock().await;
    connection.check()?;
    anyhow::ensure!(
        access.connection_id == connection.pinned,
        "{CONNECTION_CHANGED}"
    );
    anyhow::ensure!(
        access.expires_at > now_ms(),
        "ChatGPT returned an already-expired access token. Reconnect in Settings."
    );
    Ok(access.access_token)
}

#[derive(Clone)]
pub(crate) struct ChatGptClient {
    credentials: Arc<dyn ChatGptCredentials>,
    connection: SharedConnection,
    http: reqwest::Client,
}

impl ChatGptClient {
    pub(crate) fn new(credentials: Arc<dyn ChatGptCredentials>) -> anyhow::Result<Self> {
        let connection = PinnedConnection::pin(&*credentials)?;
        Ok(Self {
            credentials,
            connection: Arc::new(tokio::sync::Mutex::new(connection)),
            http: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .retry(reqwest::retry::never())
                .connect_timeout(std::time::Duration::from_secs(10))
                .read_timeout(std::time::Duration::from_secs(120))
                .build()?,
        })
    }
}

impl CompletionClient for ChatGptClient {
    type CompletionModel = ChatGptModel;

    fn completion_model(&self, model: impl Into<String>) -> Self::CompletionModel {
        ChatGptModel {
            client: self.clone(),
            model: model.into(),
        }
    }
}

pub(crate) struct ChatGptModel {
    client: ChatGptClient,
    model: String,
}

#[derive(Clone, Default)]
struct SiwcHttpClient {
    inner: reqwest::Client,
    authorization: Option<(Arc<dyn ChatGptCredentials>, SharedConnection)>,
    sent: Arc<std::sync::atomic::AtomicBool>,
}

impl std::fmt::Debug for SiwcHttpClient {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("SiwcHttpClient")
    }
}

impl HttpClientExt for SiwcHttpClient {
    fn send<T, U>(
        &self,
        _req: Request<T>,
    ) -> impl Future<Output = http_client::Result<Response<http_client::LazyBody<U>>>>
    + WasmCompatSend
    + 'static
    where
        T: Into<Bytes>,
        T: WasmCompatSend,
        U: From<Bytes>,
        U: WasmCompatSend + 'static,
    {
        std::future::ready(Err(stream_error(STREAM_REQUIRED)))
    }

    fn send_multipart<U>(
        &self,
        _req: Request<rig::http_client::MultipartForm>,
    ) -> impl Future<Output = http_client::Result<Response<http_client::LazyBody<U>>>>
    + WasmCompatSend
    + 'static
    where
        U: From<Bytes>,
        U: WasmCompatSend + 'static,
    {
        std::future::ready(Err(stream_error(STREAM_REQUIRED)))
    }

    fn send_streaming<T>(
        &self,
        req: Request<T>,
    ) -> impl Future<Output = http_client::Result<http_client::StreamingResponse>> + WasmCompatSend
    where
        T: Into<Bytes> + WasmCompatSend,
    {
        let this = self.clone();
        async move {
            if this.sent.swap(true, std::sync::atomic::Ordering::AcqRel) {
                return Err(stream_error(
                    "ChatGPT inference cannot replay an interrupted request. Start a new run.",
                ));
            }
            let (credentials, connection) = this
                .authorization
                .as_ref()
                .ok_or_else(|| stream_error(CONNECTION_CHANGED))?;
            check_connection(connection)?;
            let (parts, body) = req.into_parts();
            if parts.uri.to_string() != "https://api.openai.com/v1/responses" {
                return Err(stream_error(
                    "ChatGPT inference requires the public Responses endpoint.",
                ));
            }
            let body = rewrite_request_body(&body.into())?;
            let request = this
                .inner
                .request(parts.method, parts.uri.to_string())
                .headers(parts.headers)
                .body(body)
                .build()
                .map_err(|error| stream_error(error.to_string()))?;
            let token = access_token(credentials, connection)
                .await
                .map_err(|error| stream_error(error.to_string()))?;
            let mut request = request;
            request.headers_mut().insert(
                http::header::AUTHORIZATION,
                HeaderValue::from_str(&format!("Bearer {token}"))
                    .map_err(http_client::Error::from)?,
            );
            check_connection(connection)?;
            let response = this
                .inner
                .execute(request)
                .await
                .map_err(|error| stream_error(error.to_string()))?;
            if !response.status().is_success() {
                return Err(inference_error(response, &token).await);
            }
            streaming_response(response, Arc::clone(connection))
        }
    }
}

fn streaming_response(
    response: reqwest::Response,
    connection: SharedConnection,
) -> http_client::Result<http_client::StreamingResponse> {
    let mut res = Response::builder()
        .status(response.status())
        .version(response.version());
    if let Some(headers) = res.headers_mut() {
        *headers = response.headers().clone();
        headers
            .entry(http::header::CONTENT_TYPE)
            .or_insert(HeaderValue::from_static("text/event-stream"));
    }
    let stream: rig::http_client::sse::BoxedStream =
        Box::pin(SiwcStreamGuard::new(response.bytes_stream(), connection));
    res.body(stream).map_err(http_client::Error::Protocol)
}

async fn read_error_body(
    mut response: reqwest::Response,
) -> Result<serde_json::Value, &'static str> {
    if response
        .content_length()
        .is_some_and(|length| length > ERROR_BODY_LIMIT as u64)
    {
        return Err("Provider error response was too large.");
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Could not read provider error response.")?
    {
        if bytes.len().saturating_add(chunk.len()) > ERROR_BODY_LIMIT {
            return Err("Provider error response was too large.");
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "Provider error response was not valid JSON.")
}

fn diagnostic_text(value: &str, access_token: &str) -> String {
    let redacted = if access_token.is_empty() {
        value.to_string()
    } else {
        value.replace(access_token, "[redacted]")
    };
    let mut chars = redacted.chars();
    let mut text: String = chars.by_ref().take(1024).collect();
    if chars.next().is_some() {
        text.push_str("...");
    }
    serde_json::to_string(&text).expect("diagnostic text serializes")
}

async fn inference_error(response: reqwest::Response, access_token: &str) -> http_client::Error {
    let status = response.status();
    let request_id = response
        .headers()
        .get("x-request-id")
        .and_then(|value| value.to_str().ok())
        .map(|value| diagnostic_text(value, access_token));
    let mut message = format!("ChatGPT inference returned HTTP {status}.");
    match tokio::time::timeout(ERROR_BODY_TIMEOUT, read_error_body(response)).await {
        Ok(Ok(body)) => {
            let recognized = [
                ("error.message", body["error"]["message"].as_str()),
                ("error.code", body["error"]["code"].as_str()),
                ("error.param", body["error"]["param"].as_str()),
                ("detail", body["detail"].as_str()),
            ];
            let mut found = false;
            for (name, value) in recognized {
                if let Some(value) = value {
                    message.push_str(&format!(" {name}={}", diagnostic_text(value, access_token)));
                    found = true;
                }
            }
            if !found {
                message.push_str(" Provider returned an unrecognized error response.");
            }
        }
        Ok(Err(reason)) => {
            message.push(' ');
            message.push_str(reason);
        }
        Err(_) => message.push_str(" Reading provider error response timed out."),
    }
    if let Some(request_id) = request_id {
        message.push_str(&format!(" request_id={request_id}"));
    }
    http_client::Error::InvalidStatusCodeWithMessage(status, message)
}

struct SiwcStreamGuard<S> {
    inner: S,
    connection: SharedConnection,
    buffered: Vec<u8>,
    terminal: bool,
    ended: bool,
    connection_changed: futures::future::BoxFuture<'static, ()>,
}

impl<S> SiwcStreamGuard<S> {
    fn new(inner: S, connection: SharedConnection) -> Self {
        let monitored = Arc::clone(&connection);
        let connection_changed = Box::pin(async move {
            let (mut receiver, pinned) = {
                let connection = monitored.lock().await;
                (connection.receiver.clone(), connection.pinned.clone())
            };
            loop {
                if receiver.borrow_and_update().as_deref() != Some(pinned.as_str()) {
                    return;
                }
                if receiver.changed().await.is_err() {
                    return;
                }
            }
        });
        Self {
            inner,
            connection,
            buffered: Vec::new(),
            terminal: false,
            ended: false,
            connection_changed,
        }
    }

    fn absorb(&mut self, chunk: &[u8]) -> http_client::Result<()> {
        const FRAME_LIMIT: usize = 4 * 1024 * 1024;
        if self.buffered.len().saturating_add(chunk.len()) > FRAME_LIMIT {
            return Err(stream_error("ChatGPT returned an oversized stream frame."));
        }
        self.buffered.extend_from_slice(chunk);
        while let Some(frame_end) = find_frame_end(&self.buffered) {
            let frame: Vec<u8> = self.buffered.drain(..frame_end).collect();
            if !self.terminal && frame_is_terminal(&frame) {
                self.terminal = true;
            }
        }
        Ok(())
    }
}

fn find_frame_end(buffered: &[u8]) -> Option<usize> {
    let crlf = buffered
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|position| position + 4);
    let lf = buffered
        .windows(2)
        .position(|window| window == b"\n\n")
        .map(|position| position + 2);
    match (crlf, lf) {
        (Some(crlf), Some(lf)) => Some(crlf.min(lf)),
        (crlf, lf) => crlf.or(lf),
    }
}

const TERMINAL_EVENTS: [&str; 3] = [
    "response.completed",
    "response.failed",
    "response.incomplete",
];

fn frame_is_terminal(frame: &[u8]) -> bool {
    let Ok(frame) = std::str::from_utf8(frame) else {
        return false;
    };
    let mut event = None;
    let mut data = String::new();
    for line in frame.lines() {
        if let Some(value) = line.strip_prefix("event:") {
            event = Some(value.trim().to_string());
        } else if let Some(value) = line.strip_prefix("data:") {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(value.strip_prefix(' ').unwrap_or(value));
        }
    }
    let Ok(payload) = serde_json::from_str::<serde_json::Value>(&data) else {
        return false;
    };
    let Some(kind) = payload.get("type").and_then(serde_json::Value::as_str) else {
        return false;
    };
    if !TERMINAL_EVENTS.contains(&kind) {
        return false;
    }
    // A named event frame counts only when its payload agrees; a data-only
    // frame stands on its payload alone.
    event.is_none_or(|event| event == kind)
}

impl<S, E> futures::Stream for SiwcStreamGuard<S>
where
    S: futures::Stream<Item = Result<Bytes, E>> + Unpin,
    E: std::error::Error + Send + Sync + 'static,
{
    type Item = Result<Bytes, http_client::Error>;

    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        if self.ended {
            return std::task::Poll::Ready(None);
        }
        if self.connection_changed.as_mut().poll(cx).is_ready() {
            self.ended = true;
            return std::task::Poll::Ready(Some(Err(stream_error(CONNECTION_CHANGED))));
        }
        if let Err(error) = check_connection(&self.connection) {
            self.ended = true;
            return std::task::Poll::Ready(Some(Err(error)));
        }
        match self.inner.poll_next_unpin(cx) {
            std::task::Poll::Ready(Some(Ok(chunk))) => {
                if let Err(error) = self.absorb(&chunk) {
                    self.ended = true;
                    return std::task::Poll::Ready(Some(Err(error)));
                }
                std::task::Poll::Ready(Some(Ok(chunk)))
            }
            std::task::Poll::Ready(Some(Err(error))) => {
                self.ended = true;
                std::task::Poll::Ready(Some(Err(stream_error(error.to_string()))))
            }
            std::task::Poll::Ready(None) => {
                self.ended = true;
                if self.terminal {
                    std::task::Poll::Ready(None)
                } else {
                    std::task::Poll::Ready(Some(Err(stream_error(STREAM_INTERRUPTED))))
                }
            }
            std::task::Poll::Pending => std::task::Poll::Pending,
        }
    }
}

fn rewrite_request_body(body: &Bytes) -> http_client::Result<Bytes> {
    let mut body: serde_json::Value = serde_json::from_slice(body)
        .map_err(|error| stream_error(format!("invalid Responses request body: {error}")))?;
    shape_siwc_body(&mut body)?;
    serde_json::to_vec(&body)
        .map(Bytes::from)
        .map_err(|error| stream_error(error.to_string()))
}

fn shape_siwc_body(body: &mut serde_json::Value) -> http_client::Result<()> {
    let object = body
        .as_object_mut()
        .ok_or_else(|| stream_error("Responses request body is not a JSON object"))?;
    for field in UNSUPPORTED_FIELDS {
        object.remove(*field);
    }
    object.insert("store".to_string(), serde_json::json!(false));
    object.insert("stream".to_string(), serde_json::json!(true));
    let include = object
        .entry("include")
        .or_insert_with(|| serde_json::json!([]));
    let include = include
        .as_array_mut()
        .ok_or_else(|| stream_error("ChatGPT response include fields must be an array."))?;
    if !include
        .iter()
        .any(|item| item == "reasoning.encrypted_content")
    {
        include.push(serde_json::json!("reasoning.encrypted_content"));
    }
    namespace_function_tools(object)
}

fn namespace_function_tools(
    object: &mut serde_json::Map<String, serde_json::Value>,
) -> http_client::Result<()> {
    if !object.contains_key("tools") {
        return Ok(());
    }
    if !object["tools"].is_array() {
        return Err(stream_error("ChatGPT tool definitions must be an array."));
    }
    let tools = object
        .remove("tools")
        .and_then(|tools| tools.as_array().cloned())
        .unwrap_or_default();
    let mut functions = Vec::new();
    for tool in tools {
        if tool["type"] == "function" {
            functions.push(tool);
        } else if tool["type"] == "namespace" && tool["name"] == SIWC_TOOL_NAMESPACE {
            let nested = tool["tools"]
                .as_array()
                .ok_or_else(|| stream_error("Invalid ChatGPT tool namespace."))?;
            if nested.iter().any(|tool| tool["type"] != "function") {
                return Err(stream_error(
                    "ChatGPT namespaces only support function tools.",
                ));
            }
            functions.extend(nested.iter().cloned());
        } else {
            return Err(stream_error(format!(
                "ChatGPT inference does not support the hosted {:?} tool.",
                tool["type"].as_str().unwrap_or("unknown")
            )));
        }
    }
    if functions.is_empty() {
        return Ok(());
    }
    object.insert(
        "tools".to_string(),
        serde_json::json!([{
            "type": "namespace",
            "name": SIWC_TOOL_NAMESPACE,
            "description": "Tools for working on the user's project in Sprocket.",
            "tools": functions,
        }]),
    );
    Ok(())
}

impl ChatGptModel {
    fn responses_model(&self) -> openai::responses_api::ResponsesCompletionModel<SiwcHttpClient> {
        let client = openai::Client::builder()
            .api_key("siwc-managed-by-transport")
            .base_url("https://api.openai.com/v1")
            .http_client(SiwcHttpClient {
                inner: self.client.http.clone(),
                authorization: Some((
                    Arc::clone(&self.client.credentials),
                    Arc::clone(&self.client.connection),
                )),
                sent: Arc::default(),
            })
            .build()
            .expect("SIWC client construction cannot fail");
        client
            .completion_model(&self.model)
            .with_system_instructions_placement(SystemInstructionsPlacement::AllInstructions)
    }
}

impl CompletionModel for ChatGptModel {
    async fn completion(
        &self,
        _request: CompletionRequest,
    ) -> Result<CompletionResponse, CompletionError> {
        Err(CompletionError::RequestError(STREAM_REQUIRED.into()))
    }

    async fn stream(
        &self,
        request: CompletionRequest,
    ) -> Result<StreamingCompletionResponse, CompletionError> {
        CompletionModel::stream(&self.responses_model(), replay_contents(request)).await
    }
}

#[cfg(test)]
fn wire_tool(definition: &rig::completion::ToolDefinition) -> serde_json::Value {
    serde_json::to_value(ResponsesToolDefinition::from(definition.clone()))
        .expect("tool definition serializes")
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use futures::future::BoxFuture;
    use rig::completion::Message;
    use rig::message::{
        AssistantContent, ProviderCallId, Reasoning, ReasoningContent, ToolCall, ToolFunction,
        ToolResult, ToolResultContent, UserContent,
    };
    use serde_json::json;

    use super::*;
    use crate::types::ChatGptAccess;

    struct StubCredentials {
        connection: tokio::sync::watch::Sender<Option<String>>,
        calls: AtomicUsize,
        issued_connection: Mutex<String>,
    }

    impl StubCredentials {
        fn connected(connection: &str) -> Arc<Self> {
            let (sender, _) = tokio::sync::watch::channel(Some(connection.to_string()));
            Arc::new(Self {
                connection: sender,
                calls: AtomicUsize::new(0),
                issued_connection: Mutex::new(connection.to_string()),
            })
        }
    }

    impl ChatGptCredentials for StubCredentials {
        fn connection(&self) -> tokio::sync::watch::Receiver<Option<String>> {
            self.connection.subscribe()
        }

        fn credential(&self) -> BoxFuture<'_, anyhow::Result<ChatGptAccess>> {
            Box::pin(async move {
                let call = self.calls.fetch_add(1, Ordering::SeqCst);
                Ok(ChatGptAccess {
                    connection_id: self.issued_connection.lock().unwrap().clone(),
                    access_token: format!("token-{call}"),
                    expires_at: now_ms() + 60_000,
                })
            })
        }
    }

    fn stub_client(connection: &str) -> (Arc<StubCredentials>, ChatGptClient) {
        let credentials = StubCredentials::connected(connection);
        let client = ChatGptClient::new(credentials.clone()).unwrap();
        (credentials, client)
    }

    fn error_response(
        status: http::StatusCode,
        body: impl Into<reqwest::Body>,
    ) -> reqwest::Response {
        http::Response::builder()
            .status(status)
            .header("x-request-id", "req-test")
            .body(body.into())
            .unwrap()
            .into()
    }

    #[derive(Clone, Debug, Default)]
    struct HeaderlessStreamClient(SiwcHttpClient);

    impl HttpClientExt for HeaderlessStreamClient {
        fn send<T, U>(
            &self,
            req: Request<T>,
        ) -> impl Future<Output = http_client::Result<Response<http_client::LazyBody<U>>>>
        + WasmCompatSend
        + 'static
        where
            T: Into<Bytes> + WasmCompatSend,
            U: From<Bytes> + WasmCompatSend + 'static,
        {
            self.0.send(req)
        }

        fn send_multipart<U>(
            &self,
            req: Request<rig::http_client::MultipartForm>,
        ) -> impl Future<Output = http_client::Result<Response<http_client::LazyBody<U>>>>
        + WasmCompatSend
        + 'static
        where
            U: From<Bytes> + WasmCompatSend + 'static,
        {
            self.0.send_multipart(req)
        }

        fn send_streaming<T>(
            &self,
            req: Request<T>,
        ) -> impl Future<Output = http_client::Result<http_client::StreamingResponse>> + WasmCompatSend
        where
            T: Into<Bytes> + WasmCompatSend,
        {
            let (_, connection) = self.0.authorization.as_ref().unwrap();
            let connection = Arc::clone(connection);
            async move {
                assert_eq!(req.uri(), "https://api.openai.com/v1/responses");
                let body: serde_json::Value =
                    serde_json::from_slice(&rewrite_request_body(&req.into_body().into())?)
                        .unwrap();
                assert_eq!(body["tools"][0]["type"], "namespace");
                let event = json!({
                    "type": "response.completed",
                    "sequence_number": 0,
                    "response": {
                        "id": "resp-test",
                        "object": "response",
                        "created_at": 0,
                        "status": "completed",
                        "model": "gpt-6.1-sol",
                        "output": [],
                        "tools": [],
                        "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}
                    }
                });
                let response = http::Response::builder()
                    .header("x-request-id", "req-stream")
                    .body(format!("data: {event}\n\n"))
                    .unwrap()
                    .into();
                streaming_response(response, connection)
            }
        }
    }

    #[tokio::test]
    async fn responses_client_completes_a_headerless_siwc_stream() {
        let (credentials, client) = stub_client("connection-1");
        let http = HeaderlessStreamClient(SiwcHttpClient {
            authorization: Some((credentials, Arc::clone(&client.connection))),
            ..Default::default()
        });
        let model = openai::Client::builder()
            .api_key("test-token")
            .http_client(http)
            .build()
            .unwrap()
            .completion_model("gpt-6.1-sol");
        let mut stream = model
            .stream(test_request(vec![Message::user("hello")]))
            .await
            .unwrap();
        while let Some(item) = stream.next().await {
            item.expect("Rig must accept the headerless SIWC handshake and parse its events");
        }
        let response = stream.response.expect("parsed terminal response");
        assert_eq!(response.usage.total_tokens, 2);
        assert_eq!(response.response_id.as_deref(), Some("resp-test"));
        assert_eq!(response.provider_request_id.as_deref(), Some("req-stream"));
    }

    #[tokio::test]
    async fn streaming_response_supplies_missing_sse_content_type_and_preserves_events() {
        let (_, client) = stub_client("connection-1");
        let frame = Bytes::from_static(
            b"event: response.completed\ndata: {\"type\":\"response.completed\"}\n\n",
        );
        let response = http::Response::builder()
            .status(http::StatusCode::OK)
            .version(http::Version::HTTP_2)
            .header("x-request-id", "req-stream")
            .body(frame.clone())
            .unwrap()
            .into();
        let response = streaming_response(response, Arc::clone(&client.connection)).unwrap();
        assert_eq!(response.status(), http::StatusCode::OK);
        assert_eq!(response.version(), http::Version::HTTP_2);
        assert_eq!(
            response.headers()[http::header::CONTENT_TYPE],
            "text/event-stream"
        );
        assert_eq!(response.headers()["x-request-id"], "req-stream");
        let mut stream = response.into_body();
        assert_eq!(stream.next().await.unwrap().unwrap(), frame);
        assert!(stream.next().await.is_none());
    }

    #[test]
    fn streaming_response_preserves_explicit_content_types() {
        let (_, client) = stub_client("connection-1");
        for content_type in ["text/event-stream; charset=utf-8", "application/json", ""] {
            let response = http::Response::builder()
                .header(http::header::CONTENT_TYPE, content_type)
                .body("")
                .unwrap()
                .into();
            let response = streaming_response(response, Arc::clone(&client.connection)).unwrap();
            assert_eq!(response.headers()[http::header::CONTENT_TYPE], content_type);
        }
    }

    #[tokio::test]
    async fn streaming_response_requires_terminal_events_even_without_content_type() {
        let (_, client) = stub_client("connection-1");
        for body in [
            "",
            r#"{"detail":"not an SSE response"}"#,
            "data: {not json}\n\n",
        ] {
            let response = http::Response::builder().body(body).unwrap().into();
            let mut stream = streaming_response(response, Arc::clone(&client.connection))
                .unwrap()
                .into_body();
            let error = stream
                .by_ref()
                .filter_map(|item| async move { item.err() })
                .next()
                .await
                .expect("stream must report an error");
            let http_client::Error::Instance(error) = error else {
                panic!("expected terminal-event validation error");
            };
            assert_eq!(error.to_string(), STREAM_INTERRUPTED);
            assert!(stream.next().await.is_none());
        }
    }

    #[tokio::test]
    async fn inference_errors_preserve_structured_diagnostics() {
        let response = error_response(
            http::StatusCode::BAD_REQUEST,
            json!({"error": {
                "message": "Missing required parameter: 'tools[0].description'.",
                "code": "missing_required_parameter",
                "param": "tools[0].description"
            }})
            .to_string(),
        );
        let http_client::Error::InvalidStatusCodeWithMessage(status, message) =
            inference_error(response, "test-token").await
        else {
            panic!("expected HTTP status and diagnostics");
        };
        assert_eq!(status, http::StatusCode::BAD_REQUEST);
        assert_eq!(
            message,
            "ChatGPT inference returned HTTP 400 Bad Request. error.message=\"Missing required parameter: 'tools[0].description'.\" error.code=\"missing_required_parameter\" error.param=\"tools[0].description\" request_id=\"req-test\""
        );
    }

    #[tokio::test]
    async fn inference_errors_preserve_direct_admission_details() {
        let response = error_response(
            http::StatusCode::SERVICE_UNAVAILABLE,
            json!({"detail": "Direct routing is unavailable."}).to_string(),
        );
        let http_client::Error::InvalidStatusCodeWithMessage(status, message) =
            inference_error(response, "test-token").await
        else {
            panic!("expected HTTP status and diagnostics");
        };
        assert_eq!(status, http::StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            message,
            "ChatGPT inference returned HTTP 503 Service Unavailable. detail=\"Direct routing is unavailable.\" request_id=\"req-test\""
        );
    }

    #[tokio::test]
    async fn inference_errors_bound_and_redact_diagnostic_text() {
        let response = http::Response::builder()
            .status(http::StatusCode::UNAUTHORIZED)
            .header("x-request-id", "test-token")
            .body(json!({"detail": format!("Bearer test-token\n{}", "é".repeat(2048))}).to_string())
            .unwrap()
            .into();
        let http_client::Error::InvalidStatusCodeWithMessage(_, message) =
            inference_error(response, "test-token").await
        else {
            panic!("expected HTTP status and diagnostics");
        };
        assert!(message.contains("Bearer [redacted]\\n"));
        assert!(message.ends_with("...\" request_id=\"[redacted]\""));
        assert!(message.len() < 2300);
    }

    #[tokio::test]
    async fn inference_errors_keep_status_and_request_id_for_unusable_bodies() {
        let unreadable = reqwest::Body::wrap_stream(futures::stream::iter([Err::<Bytes, _>(
            std::io::Error::other("read failed"),
        )]));
        for (body, reason) in [
            (
                reqwest::Body::from("{not json"),
                "Provider error response was not valid JSON.",
            ),
            (
                reqwest::Body::from(r#"{"unexpected":"private data"}"#),
                "Provider returned an unrecognized error response.",
            ),
            (
                reqwest::Body::from(vec![b' '; ERROR_BODY_LIMIT + 1]),
                "Provider error response was too large.",
            ),
            (unreadable, "Could not read provider error response."),
        ] {
            let response = error_response(http::StatusCode::BAD_GATEWAY, body);
            let http_client::Error::InvalidStatusCodeWithMessage(status, message) =
                inference_error(response, "test-token").await
            else {
                panic!("expected HTTP status and diagnostics");
            };
            assert_eq!(status, http::StatusCode::BAD_GATEWAY);
            assert_eq!(
                message,
                format!(
                    "ChatGPT inference returned HTTP 502 Bad Gateway. {reason} request_id=\"req-test\""
                )
            );
        }
    }

    #[tokio::test(start_paused = true)]
    async fn inference_errors_keep_diagnostics_when_the_body_stalls() {
        let body =
            reqwest::Body::wrap_stream(futures::stream::pending::<Result<Bytes, std::io::Error>>());
        let response = error_response(http::StatusCode::BAD_GATEWAY, body);
        let http_client::Error::InvalidStatusCodeWithMessage(status, message) =
            inference_error(response, "test-token").await
        else {
            panic!("expected HTTP status and diagnostics");
        };
        assert_eq!(status, http::StatusCode::BAD_GATEWAY);
        assert_eq!(
            message,
            "ChatGPT inference returned HTTP 502 Bad Gateway. Reading provider error response timed out. request_id=\"req-test\""
        );
    }

    #[tokio::test]
    async fn rejects_requests_after_the_connection_changes_or_clears() {
        for replacement in [None, Some("connection-2".to_string())] {
            let (credentials, client) = stub_client("connection-1");
            assert_eq!(
                access_token(&client.credentials, &client.connection)
                    .await
                    .unwrap(),
                "token-0"
            );
            credentials.connection.send(replacement).unwrap();
            assert!(
                access_token(&client.credentials, &client.connection)
                    .await
                    .is_err()
            );
            // The run stays rejected even if the original connection comes back.
            credentials
                .connection
                .send(Some("connection-1".to_string()))
                .unwrap();
            assert!(
                access_token(&client.credentials, &client.connection)
                    .await
                    .is_err()
            );
            assert_eq!(credentials.calls.load(Ordering::SeqCst), 1);
        }
    }

    #[test]
    fn fails_closed_when_the_connection_watch_closes() {
        let credentials = StubCredentials::connected("connection-1");
        let mut connection = PinnedConnection::pin(&*credentials).unwrap();
        drop(credentials);
        assert!(connection.check().is_err());
    }

    #[tokio::test]
    async fn rejects_issuance_from_a_different_connection() {
        let credentials = StubCredentials::connected("connection-1");
        *credentials.issued_connection.lock().unwrap() = "connection-2".to_string();
        let client = ChatGptClient::new(credentials).unwrap();
        assert!(
            access_token(&client.credentials, &client.connection)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn requires_a_selected_connection_at_run_start() {
        let (sender, _) = tokio::sync::watch::channel::<Option<String>>(None);
        struct Unconnected(tokio::sync::watch::Sender<Option<String>>);
        impl ChatGptCredentials for Unconnected {
            fn connection(&self) -> tokio::sync::watch::Receiver<Option<String>> {
                self.0.subscribe()
            }
            fn credential(&self) -> BoxFuture<'_, anyhow::Result<ChatGptAccess>> {
                Box::pin(async { anyhow::bail!("unreachable") })
            }
        }
        assert!(ChatGptClient::new(Arc::new(Unconnected(sender))).is_err());
    }

    #[tokio::test]
    async fn rejects_an_expired_token() {
        struct Expiring(Arc<StubCredentials>);
        impl ChatGptCredentials for Expiring {
            fn connection(&self) -> tokio::sync::watch::Receiver<Option<String>> {
                self.0.connection()
            }
            fn credential(&self) -> BoxFuture<'_, anyhow::Result<ChatGptAccess>> {
                Box::pin(async {
                    Ok(ChatGptAccess {
                        connection_id: "connection-1".to_string(),
                        access_token: "stale".to_string(),
                        expires_at: now_ms(),
                    })
                })
            }
        }
        let client = ChatGptClient::new(Arc::new(Expiring(StubCredentials::connected(
            "connection-1",
        ))))
        .unwrap();
        assert!(
            access_token(&client.credentials, &client.connection)
                .await
                .is_err()
        );
    }

    fn assistant_turn() -> Message {
        Message::Assistant {
            id: None,
            content: vec![
                AssistantContent::Reasoning(Reasoning {
                    id: Some("rs_1".to_string()),
                    content: vec![
                        ReasoningContent::Summary("plan".to_string()),
                        ReasoningContent::Encrypted("envelope".to_string()),
                    ],
                }),
                AssistantContent::Text(rig::message::Text::new("working on it".to_string())),
                AssistantContent::ToolCall(ToolCall {
                    id: rig::message::ToolCallId::new_or_mint("call-1".to_string()),
                    provider: ProviderCallId::new("call_1".to_string())
                        .map(|id| id.with_item_id("fc_1".to_string())),
                    function: ToolFunction {
                        name: "exec_command".to_string(),
                        arguments: json!({"cmd": "pwd"}),
                    },
                    signature: None,
                    additional_params: None,
                }),
            ],
        }
    }

    fn tool_result_turn() -> Message {
        Message::User {
            content: vec![UserContent::ToolResult(ToolResult {
                call: rig::message::ToolCallId::new_or_mint("call-1".to_string()),
                provider: ProviderCallId::new("call_1".to_string()),
                name: "exec_command".to_string(),
                content: vec![ToolResultContent::text("done")]
                    .try_into()
                    .expect("non-empty tool result"),
            })],
        }
    }

    fn completion_request(
        chat_history: Vec<Message>,
        additional_params: serde_json::Value,
    ) -> CompletionRequest {
        CompletionRequest {
            model: None,
            preamble: Some("Base instructions.".to_string()),
            chat_history,
            documents: Vec::new(),
            tools: vec![rig::completion::ToolDefinition {
                name: "exec_command".to_string(),
                description: "Run a command".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {"cmd": {"type": "string"}}
                }),
            }],
            temperature: Some(0.7),
            max_tokens: Some(1024),
            tool_choice: None,
            additional_params: Some(additional_params),
            output_schema: None,
            record_telemetry_content: false,
        }
    }

    fn test_request(chat_history: Vec<Message>) -> CompletionRequest {
        completion_request(chat_history, json!({"reasoning": {"effort": "high"}}))
    }

    fn wire_body(request: CompletionRequest) -> serde_json::Value {
        let request = ResponsesCompletionRequest::try_from(ResponsesRequestParams {
            model: "gpt-5.3-codex".to_string(),
            request: replay_contents(request),
            system_instructions_placement: SystemInstructionsPlacement::AllInstructions,
        })
        .expect("request converts");
        serde_json::to_value(request).expect("request serializes")
    }

    fn shaped_body(request: CompletionRequest) -> serde_json::Value {
        let mut body = wire_body(request);
        shape_siwc_body(&mut body).unwrap();
        body
    }

    #[test]
    fn siwc_body_sets_store_and_stream_and_drops_unsupported_fields() {
        let body = shaped_body(completion_request(
            vec![Message::user("hello")],
            json!({
                "reasoning": {"effort": "high"},
                "metadata": {"trace": "abc"},
                "user": "user-1"
            }),
        ));

        assert_eq!(body["store"], json!(false));
        assert_eq!(body["stream"], json!(true));
        assert_eq!(body["model"], json!("gpt-5.3-codex"));
        assert_eq!(body["instructions"], json!("Base instructions."));
        assert_eq!(body["include"], json!(["reasoning.encrypted_content"]));
        for field in UNSUPPORTED_FIELDS {
            assert!(body.get(*field).is_none(), "{field} must be omitted");
        }
        assert_eq!(body["reasoning"]["effort"], json!("high"));
    }

    #[test]
    fn siwc_body_lifts_mid_conversation_system_items_into_instructions() {
        let body = shaped_body(test_request(vec![
            Message::user("hi"),
            Message::System {
                content: "Mid-run rule.".to_string(),
            },
            Message::user("again"),
        ]));

        assert_eq!(
            body["instructions"],
            json!("Base instructions.\n\nMid-run rule.")
        );
        let input = body["input"].as_array().unwrap();
        assert!(
            input.iter().all(|item| item["role"] != "system"),
            "system role input items are rejected by the SIWC route: {input:?}"
        );
        assert_eq!(input.len(), 2);
    }

    #[test]
    fn siwc_body_replays_reasoning_and_tool_turns_as_self_contained_items() {
        let body = shaped_body(test_request(vec![
            Message::user("start"),
            assistant_turn(),
            tool_result_turn(),
            Message::user("continue"),
        ]));

        let input = body["input"].as_array().unwrap();
        let reasoning = input
            .iter()
            .find(|item| item["type"] == "reasoning")
            .expect("reasoning replay item");
        assert_eq!(reasoning["encrypted_content"], json!("envelope"));
        let call = input
            .iter()
            .find(|item| item["type"] == "function_call")
            .expect("function call replay item");
        assert_eq!(call["call_id"], json!("call_1"));
        assert_eq!(call["name"], json!("exec_command"));
        assert_eq!(call["arguments"], json!(r#"{"cmd":"pwd"}"#));
        let output = input
            .iter()
            .find(|item| item["type"] == "function_call_output")
            .expect("function call output replay item");
        assert_eq!(output["call_id"], json!("call_1"));
        assert!(
            body.get("previous_response_id").is_none(),
            "conversation state is replayed, never referenced"
        );
    }

    #[test]
    fn siwc_body_groups_function_tools_under_a_namespace() {
        let request = test_request(vec![Message::user("hello")]);
        let expected_tool = wire_tool(&request.tools[0]);
        let body = shaped_body(request);
        let tools = body["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["type"], json!("namespace"));
        assert_eq!(tools[0]["name"], json!(SIWC_TOOL_NAMESPACE));
        assert!(
            tools[0]["description"]
                .as_str()
                .is_some_and(|description| !description.is_empty())
        );
        let functions = tools[0]["tools"].as_array().unwrap();
        assert_eq!(functions.len(), 1);
        assert_eq!(functions[0]["type"], json!("function"));
        assert_eq!(functions[0], expected_tool);
    }

    #[test]
    fn siwc_body_rejects_hosted_tools() {
        let mut body = wire_body(test_request(vec![Message::user("hello")]));
        body["tools"]
            .as_array_mut()
            .unwrap()
            .push(json!({"type": "web_search"}));
        let error = shape_siwc_body(&mut body).unwrap_err();
        assert!(error.to_string().contains("web_search"));
    }

    #[test]
    fn siwc_body_shaping_is_idempotent() {
        let mut body = shaped_body(test_request(vec![Message::user("hello")]));
        let original = body.clone();
        shape_siwc_body(&mut body).unwrap();
        assert_eq!(body, original);
    }

    #[test]
    fn siwc_body_drops_reasoning_items_without_encrypted_state() {
        let mut request = test_request(vec![Message::Assistant {
            id: None,
            content: vec![
                AssistantContent::Reasoning(Reasoning {
                    id: None,
                    content: vec![ReasoningContent::Summary("summary only".to_string())],
                }),
                AssistantContent::Text(rig::message::Text::new("answer".to_string())),
            ],
        }]);
        request.chat_history.push(Message::user("next"));
        let body = shaped_body(request);
        let input = body["input"].as_array().unwrap();
        assert!(
            input.iter().all(|item| item["type"] != "reasoning"),
            "reasoning without encrypted content cannot be replayed: {input:?}"
        );
    }

    #[tokio::test]
    async fn stream_guard_fails_a_stream_without_a_terminal_event() {
        let (_, client) = stub_client("connection-1");
        let chunks: Vec<Result<Bytes, std::io::Error>> = vec![
            Ok(Bytes::from_static(
                b"event: response.output_text.delta\ndata: {\"type\": \"response.output_text.delta\"}\n\n",
            )),
            Ok(Bytes::from_static(b"data: [DONE]\n\n")),
        ];
        let mut stream = SiwcStreamGuard::new(
            futures::stream::iter(chunks),
            Arc::clone(&client.connection),
        );
        assert!(stream.next().await.unwrap().is_ok());
        assert!(stream.next().await.unwrap().is_ok());
        let error = stream.next().await.unwrap().unwrap_err();
        assert!(error.to_string().contains("terminal response event"));

        let chunks: Vec<Result<Bytes, std::io::Error>> = vec![
            Ok(Bytes::from_static(
                b"event: response.output_text.delta\ndata: {\"type\": \"response.output_text.delta\"}\n\n",
            )),
            Ok(Bytes::from_static(
                b"event: response.completed\ndata: {\"type\": \"response.completed\"}\n\ndata: [DONE]\n\n",
            )),
        ];
        let mut stream = SiwcStreamGuard::new(
            futures::stream::iter(chunks),
            Arc::clone(&client.connection),
        );
        assert!(stream.next().await.unwrap().is_ok());
        assert!(stream.next().await.unwrap().is_ok());
        assert!(stream.next().await.is_none());
    }

    #[test]
    fn terminal_frames_require_a_parsed_payload_matching_the_event() {
        assert!(frame_is_terminal(
            b"event: response.completed\ndata: {\"type\": \"response.completed\", \"response\": {}}\n\n"
        ));
        // An event line without its data payload does not count.
        assert!(!frame_is_terminal(b"event: response.completed\n\n"));
        assert!(!frame_is_terminal(
            b"event: response.completed\ndata: {\"type\": \"response.\n\n"
        ));
        assert!(frame_is_terminal(
            b"data: {\"type\": \"response.failed\", \"response\": {}}\n\n"
        ));
        assert!(!frame_is_terminal(
            b"data: {\"type\": \"response.output_text.delta\"}\n\n"
        ));
    }

    #[tokio::test]
    async fn stream_guard_accepts_a_terminal_frame_split_across_chunks() {
        let (_, client) = stub_client("connection-1");
        let frame = "event: response.completed\ndata: {\"type\": \"response.completed\"}\n\n";
        let split = frame.len() / 2;
        let chunks: Vec<Result<Bytes, std::io::Error>> = vec![
            Ok(Bytes::from(frame.as_bytes()[..split].to_vec())),
            Ok(Bytes::from(frame.as_bytes()[split..].to_vec())),
        ];
        let mut stream = SiwcStreamGuard::new(
            futures::stream::iter(chunks),
            Arc::clone(&client.connection),
        );
        assert!(stream.next().await.unwrap().is_ok());
        assert!(stream.next().await.unwrap().is_ok());
        assert!(stream.next().await.is_none());
    }

    #[tokio::test]
    async fn stream_guard_fails_when_the_connection_changes_mid_stream() {
        let (credentials, client) = stub_client("connection-1");
        let (sender, chunks) = futures::channel::mpsc::unbounded::<Result<Bytes, std::io::Error>>();
        sender
            .unbounded_send(Ok(Bytes::from_static(
                b"event: response.output_text.delta\n\ndata: {}\n\n",
            )))
            .unwrap();
        let mut stream = SiwcStreamGuard::new(chunks, Arc::clone(&client.connection));
        assert!(stream.next().await.unwrap().is_ok());
        credentials
            .connection
            .send(Some("connection-2".to_string()))
            .unwrap();
        let error = stream.next().await.unwrap().unwrap_err();
        assert!(error.to_string().contains("connection changed"));
    }

    #[tokio::test]
    async fn stream_guard_wakes_an_idle_stream_when_the_connection_changes() {
        let (credentials, client) = stub_client("connection-1");
        let (sender, chunks) = futures::channel::mpsc::unbounded::<Result<Bytes, std::io::Error>>();
        let mut stream = SiwcStreamGuard::new(chunks, Arc::clone(&client.connection));
        let mut next = std::pin::pin!(stream.next());
        assert!(futures::poll!(&mut next).is_pending());
        credentials
            .connection
            .send(Some("connection-2".to_string()))
            .unwrap();
        let error = tokio::time::timeout(std::time::Duration::from_secs(5), next)
            .await
            .expect("idle stream should wake on connection change")
            .unwrap()
            .unwrap_err();
        assert!(error.to_string().contains("connection changed"));
        drop(sender);
        assert!(stream.next().await.is_none());
    }

    #[tokio::test]
    async fn nonstreaming_completion_is_rejected() {
        let (_, client) = stub_client("connection-1");
        let model = client.completion_model("gpt-5.3-codex");
        let error = model
            .completion(test_request(vec![Message::user("hello")]))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("requires streaming"));
    }
}
