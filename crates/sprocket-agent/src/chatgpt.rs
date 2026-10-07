use std::sync::Arc;

use anyhow::Context;
use bytes::Bytes;
use futures::StreamExt;
use rig::ProviderError;
#[cfg(test)]
use rig::completion::CompletionRequest;
use rig::http_client::{self, HeaderValue, HttpClientExt, Request, Response};
use rig::operation::Completion;
use rig::providers::openai;
#[cfg(test)]
use rig::providers::openai::responses_api::ResponsesToolDefinition;
use rig::providers::openai::responses_api::SystemInstructionsPlacement;
use rig::wasm_compat::WasmCompatSend;
#[cfg(test)]
use rig::wire::{Mode, Wire};
use rig::{DynModel, Model};

use crate::live::now_ms;
use crate::openai::StatelessResponses;
use crate::types::ChatGptCredentials;

const CONNECTION_CHANGED: &str =
    "ChatGPT connection changed or became unavailable. Start a new run.";
const STREAM_REQUIRED: &str =
    "ChatGPT inference requires streaming; non-streaming completion is not supported.";
const SIWC_TOOL_NAMESPACE: &str = "sprocket";
const ERROR_BODY_LIMIT: usize = 64 * 1024;
const ERROR_BODY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

#[derive(Debug, thiserror::Error)]
#[error(
    "Your ChatGPT subscription's usage limit for connected apps has been reached. Try again after the limit resets, or switch to another provider."
)]
struct SubscriptionUsageLimit {
    #[source]
    source: anyhow::Error,
}

fn is_subscription_usage_limit(body: &serde_json::Value) -> bool {
    let error = body
        .get("error")
        .or_else(|| body.get("response")?.get("error"));
    error
        .and_then(|error| error.get("code"))
        .and_then(serde_json::Value::as_str)
        == Some("subscription_sharing_usage_limit_exceeded")
}

pub(crate) fn user_facing_error(error: anyhow::Error) -> anyhow::Error {
    let usage_limit = error.chain().any(|cause| {
        cause
            .downcast_ref::<ProviderError>()
            .and_then(|error| error.provider_response_json().ok().flatten())
            .or_else(|| {
                cause
                    .downcast_ref::<rig::ErrorReport>()
                    .and_then(|report| report.provider_response_json().ok().flatten())
            })
            .is_some_and(|body| is_subscription_usage_limit(&body))
    });
    if usage_limit {
        SubscriptionUsageLimit { source: error }.into()
    } else {
        error
    }
}

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

#[derive(Clone, Default)]
struct SiwcHttpClient {
    inner: reqwest::Client,
    authorization: Option<(Arc<dyn ChatGptCredentials>, SharedConnection)>,
    #[cfg(test)]
    test_endpoint: Option<String>,
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
            let endpoint = parts.uri.to_string();
            #[cfg(test)]
            let endpoint = this.test_endpoint.as_deref().unwrap_or(&endpoint);
            let request = this
                .inner
                .request(parts.method, endpoint)
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
    let stream: rig::http_client::BoxedStream =
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
    let mut headers = response.headers().clone();
    if !access_token.is_empty() {
        for value in headers.values_mut() {
            if let Ok(text) = value.to_str()
                && text.contains(access_token)
            {
                *value = HeaderValue::from_str(&text.replace(access_token, "[redacted]"))
                    .expect("redacting a valid header leaves it valid");
            }
        }
    }
    let request_id = response
        .headers()
        .get("x-request-id")
        .and_then(|value| value.to_str().ok())
        .map(|value| diagnostic_text(value, access_token));
    let mut message = format!("ChatGPT inference returned HTTP {status}.");
    let mut usage_limit = false;
    match tokio::time::timeout(ERROR_BODY_TIMEOUT, read_error_body(response)).await {
        Ok(Ok(body)) => {
            usage_limit = is_subscription_usage_limit(&body);
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
    if usage_limit {
        // Rig must retain a structured code when it wraps this HTTP failure.
        message = serde_json::json!({
            "error": {
                "code": "subscription_sharing_usage_limit_exceeded",
                "message": message,
            }
        })
        .to_string();
    }
    http_client::Error::non_success_with_details(status, headers, message)
}

struct SiwcStreamGuard<S> {
    inner: S,
    connection: SharedConnection,
    framing: rig::http_client::framing::SseFramer,
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
            framing: rig::http_client::framing::SseFramer::new(),
            ended: false,
            connection_changed,
        }
    }
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
                const FRAME_LIMIT: usize = 4 * 1024 * 1024;
                if self.framing.pending().saturating_add(chunk.len()) > FRAME_LIMIT {
                    self.ended = true;
                    return std::task::Poll::Ready(Some(Err(stream_error(
                        "ChatGPT returned an oversized stream frame.",
                    ))));
                }
                self.framing.push(&chunk).for_each(drop);
                std::task::Poll::Ready(Some(Ok(chunk)))
            }
            std::task::Poll::Ready(Some(Err(error))) => {
                self.ended = true;
                std::task::Poll::Ready(Some(Err(stream_error(error.to_string()))))
            }
            std::task::Poll::Ready(None) => {
                self.ended = true;
                std::task::Poll::Ready(None)
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

impl ChatGptClient {
    pub(crate) fn completion_model(&self, model: impl Into<String>) -> DynModel<Completion> {
        let wire = openai::responses_api::wire::Responses::new(
            openai::OpenAIConfig::new("siwc-managed-by-transport"),
            model,
        )
        .with_system_instructions_placement(SystemInstructionsPlacement::AllInstructions);
        Model::new(
            StatelessResponses(wire),
            SiwcHttpClient {
                inner: self.http.clone(),
                authorization: Some((Arc::clone(&self.credentials), Arc::clone(&self.connection))),
                #[cfg(test)]
                test_endpoint: None,
            },
        )
        .erase()
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
    use std::time::Duration;

    use futures::future::BoxFuture;
    use rig::completion::Message;
    use rig::message::{AssistantContent, Reasoning, ReasoningContent};
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    use super::*;
    use crate::reasoning::{openai_reasoning_metadata, reasoning_summary_text};
    use crate::transcript::{TranscriptPart, TranscriptStore, agent_history_from_parts};
    use crate::types::{ChatGptAccess, deserialize_agent_history};

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
    struct StubResponseClient {
        http: SiwcHttpClient,
        body: String,
        status: http::StatusCode,
    }

    impl HttpClientExt for StubResponseClient {
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
            self.http.send(req)
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
            self.http.send_multipart(req)
        }

        fn send_streaming<T>(
            &self,
            req: Request<T>,
        ) -> impl Future<Output = http_client::Result<http_client::StreamingResponse>> + WasmCompatSend
        where
            T: Into<Bytes> + WasmCompatSend,
        {
            let connection = self.http.authorization.as_ref().unwrap().1.clone();
            let response_body = self.body.clone();
            let status = self.status;
            async move {
                assert_eq!(req.uri(), "https://api.openai.com/v1/responses");
                let body: serde_json::Value =
                    serde_json::from_slice(&rewrite_request_body(&req.into_body().into())?)
                        .unwrap();
                assert_eq!(body["tools"][0]["type"], "namespace");
                let response = http::Response::builder()
                    .status(status)
                    .header("x-request-id", "req-stream")
                    .body(response_body)
                    .unwrap()
                    .into();
                if status.is_success() {
                    streaming_response(response, connection)
                } else {
                    Err(inference_error(response, "test-token").await)
                }
            }
        }
    }

    fn stub_model(
        status: http::StatusCode,
        body: String,
    ) -> Model<StatelessResponses, StubResponseClient> {
        let (credentials, client) = stub_client("connection-1");
        let http = StubResponseClient {
            http: SiwcHttpClient {
                authorization: Some((credentials, Arc::clone(&client.connection))),
                ..Default::default()
            },
            status,
            body,
        };
        Model::new(
            StatelessResponses(openai::responses_api::wire::Responses::new(
                openai::OpenAIConfig::new("test-token"),
                "gpt-6.1-sol",
            )),
            http,
        )
    }

    async fn first_stream_error(
        model: Model<StatelessResponses, StubResponseClient>,
    ) -> ProviderError {
        model
            .stream(test_request(vec![Message::user("hello")]))
            .unwrap()
            .finish()
            .await
            .expect_err("provider error must fail the stream")
    }

    struct CapturedSiwcRequest {
        headers: String,
        body: serde_json::Value,
    }

    async fn spawn_siwc_sse(
        bodies: Vec<String>,
    ) -> (String, tokio::task::JoinHandle<Vec<CapturedSiwcRequest>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/v1/responses", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            tokio::time::timeout(Duration::from_secs(10), async move {
                let mut captured = Vec::new();
                for (turn, body) in bodies.into_iter().enumerate() {
                    let (mut stream, _) = listener.accept().await.unwrap();
                    let mut request = Vec::new();
                    let mut chunk = [0u8; 2048];
                    let header_end = loop {
                        let read = stream.read(&mut chunk).await.unwrap();
                        assert!(read > 0, "request ended before its headers");
                        request.extend_from_slice(&chunk[..read]);
                        if let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                            break end;
                        }
                        assert!(request.len() < 64 * 1024, "oversized request headers");
                    };
                    let headers = String::from_utf8(request[..header_end].to_vec()).unwrap();
                    let length: usize = headers
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse().expect("request content length"))
                        })
                        .expect("request must have a content length");
                    assert!(length < 1024 * 1024, "oversized request body");
                    let body_start = header_end + 4;
                    while request.len() < body_start + length {
                        let read = stream.read(&mut chunk).await.unwrap();
                        assert!(read > 0, "request ended before its body");
                        request.extend_from_slice(&chunk[..read]);
                    }
                    captured.push(CapturedSiwcRequest {
                        headers,
                        body: serde_json::from_slice(&request[body_start..body_start + length])
                            .unwrap(),
                    });
                    // SIWC can omit Content-Type; exercise the real transport's fallback.
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: {}\r\nx-request-id: req-siwc-{turn}\r\n\r\n{body}",
                        body.len()
                    );
                    stream.write_all(response.as_bytes()).await.unwrap();
                }
                captured
            })
            .await
            .expect("SIWC test server timed out")
        });
        (endpoint, server)
    }

    fn siwc_output_sse(response_id: &str, output: Vec<serde_json::Value>) -> String {
        let response = |status, output| {
            json!({
                "id": response_id, "object": "response", "created_at": 0,
                "status": status, "model": "gpt-5.3-codex", "output": output,
                "tools": [],
                "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2},
            })
        };
        let mut events = vec![json!({
            "type": "response.created", "response": response("in_progress", vec![]),
        })];
        for (index, item) in output.iter().enumerate() {
            events.push(json!({
                "type": "response.output_item.added", "output_index": index, "item": item,
            }));
            if item["type"] == "message" {
                events.push(json!({
                    "type": "response.output_text.delta", "output_index": index,
                    "item_id": item["id"], "content_index": 0,
                    "delta": item["content"][0]["text"],
                }));
            }
            events.push(json!({
                "type": "response.output_item.done", "output_index": index, "item": item,
            }));
        }
        events.push(json!({
            "type": "response.completed", "response": response("completed", output),
        }));
        events
            .into_iter()
            .enumerate()
            .map(|(sequence, mut event)| {
                event["sequence_number"] = json!(sequence);
                format!("data: {event}\n\n")
            })
            .collect()
    }

    #[tokio::test]
    async fn siwc_http_replays_reloaded_reasoning_and_tool_result_on_the_second_turn() {
        const ENVELOPE: &str = "  encrypted+state/=\n  ";
        let (endpoint, server) = spawn_siwc_sse(vec![
            siwc_output_sse(
                "resp-siwc-0",
                vec![
                    json!({
                        "type": "reasoning", "id": "rs_1", "status": "completed",
                        "summary": [{"type": "summary_text", "text": "Read the workspace."}],
                        "encrypted_content": ENVELOPE,
                    }),
                    json!({
                        "type": "function_call", "id": "fc_1", "call_id": "call_1",
                        "name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}",
                        "status": "completed",
                    }),
                ],
            ),
            siwc_output_sse(
                "resp-siwc-1",
                vec![json!({
                    "type": "message", "id": "msg_final", "role": "assistant",
                    "status": "completed",
                    "content": [{"type": "output_text", "text": "The workspace is /workspace."}],
                })],
            ),
        ])
        .await;
        let (credentials, client) = stub_client("connection-1");
        let model = Model::new(
            StatelessResponses(
                openai::responses_api::wire::Responses::new(
                    openai::OpenAIConfig::new("siwc-managed-by-transport"),
                    "gpt-5.3-codex",
                )
                .with_system_instructions_placement(SystemInstructionsPlacement::AllInstructions),
            ),
            SiwcHttpClient {
                inner: reqwest::Client::builder()
                    .no_proxy()
                    .redirect(reqwest::redirect::Policy::none())
                    .retry(reqwest::retry::never())
                    .timeout(Duration::from_secs(5))
                    .build()
                    .unwrap(),
                authorization: Some((credentials.clone(), Arc::clone(&client.connection))),
                test_endpoint: Some(endpoint),
            },
        );
        let request = |history| {
            completion_request(
                history,
                json!({
                    "store": true, "previous_response_id": "resp-old",
                    "reasoning": {"effort": "high"},
                    "metadata": {"trace": "abc"}, "user": "user-1",
                }),
            )
        };
        let first = model
            .stream(request(vec![Message::user("Where is the workspace?")]))
            .unwrap()
            .finish()
            .await
            .expect("headerless SIWC tool turn completes");
        assert_eq!(first.response_id.as_deref(), Some("resp-siwc-0"));
        assert_eq!(first.provider_request_id.as_deref(), Some("req-siwc-0"));
        assert_eq!(
            first.finish_reason(),
            Some(rig::completion::FinishReason::ToolCalls)
        );
        assert_eq!(first.choice.len(), 2);
        let AssistantContent::Reasoning(reasoning) = &first.choice[0] else {
            panic!("first turn must contain parsed reasoning");
        };
        let opened_reasoning = reasoning.open(reasoning.issuer()).unwrap();
        assert_eq!(opened_reasoning.id.as_deref(), Some("rs_1"));
        assert_eq!(opened_reasoning.encrypted_content(), Some(ENVELOPE));
        let AssistantContent::ToolCall(call) = &first.choice[1] else {
            panic!("first turn must contain a parsed tool call");
        };
        let provider_id = call.id.provider().unwrap();
        assert_eq!(provider_id.item_id.as_deref(), Some("fc_1"));
        assert_eq!(call.id.wire(), "call_1");
        assert_eq!(call.function.name, "exec_command");
        assert_eq!(call.function.arguments, json!({"cmd": "pwd"}));

        let parts: Vec<TranscriptPart> = serde_json::from_value(json!([
            {
                "number": 0, "sourceKey": "completion:siwc", "kind": "completion",
                "runId": "run", "completion": {"streamId": "stream", "items": [
                    {
                        "type": "reasoning", "text": reasoning_summary_text(reasoning),
                        "providerMetadata": openai_reasoning_metadata(
                            opened_reasoning.id.as_deref(), opened_reasoning.encrypted_content(),
                        ),
                    },
                    {
                        "type": "tool-call", "callId": call.id.wire(),
                        "name": call.function.name, "input": call.function.arguments,
                        "providerMetadata": {"openai": {"itemId": provider_id.item_id}},
                    },
                ]},
            },
            {
                "number": 1, "sourceKey": "tool:siwc", "kind": "tool", "runId": "run",
                "tool": {
                    "callId": call.id.wire(), "name": call.function.name,
                    "output": "/workspace", "status": "completed",
                },
            },
        ]))
        .expect("parsed SIWC turn as durable transcript");
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::new(dir.path().to_path_buf());
        store.append_parts("user", "thread", &parts).await.unwrap();
        let reloaded_store = TranscriptStore::new(dir.path().to_path_buf());
        let parts = reloaded_store
            .read_parts("user", "thread", &[0, 1])
            .await
            .unwrap();
        let state = reloaded_store.load_state("user", "thread").await.unwrap();
        let reloaded = agent_history_from_parts(&state, &parts, None);
        let mut history = vec![Message::user("Where is the workspace?")];
        history.extend(deserialize_agent_history(reloaded).expect("reload SIWC history"));
        let second = model
            .stream(request(history))
            .unwrap()
            .finish()
            .await
            .expect("replayed SIWC turn completes");
        assert_eq!(second.response_id.as_deref(), Some("resp-siwc-1"));
        assert_eq!(second.provider_request_id.as_deref(), Some("req-siwc-1"));
        assert_eq!(
            second.finish_reason(),
            Some(rig::completion::FinishReason::Stop)
        );
        assert_eq!(second.usage.total_tokens, Some(2));
        assert!(matches!(
            second.choice.as_slice(),
            [AssistantContent::Text(text)] if text.text == "The workspace is /workspace."
        ));

        let requests = server.await.expect("SIWC test server");
        assert_eq!(requests.len(), 2);
        assert_eq!(credentials.calls.load(Ordering::SeqCst), 2);
        let expected_tool = wire_tool(&test_request(vec![Message::user("hello")]).tools[0]);
        for (turn, request) in requests.iter().enumerate() {
            assert_eq!(
                request.headers.lines().next(),
                Some("POST /v1/responses HTTP/1.1")
            );
            let header = |name: &str| {
                request.headers.lines().find_map(|line| {
                    let (key, value) = line.split_once(':')?;
                    key.eq_ignore_ascii_case(name).then(|| value.trim())
                })
            };
            assert_eq!(
                header("authorization"),
                Some(format!("Bearer token-{turn}").as_str())
            );
            assert_eq!(header("content-type"), Some("application/json"));
            let body = &request.body;
            assert_eq!(body["model"], "gpt-5.3-codex");
            assert_eq!(body["instructions"], "Base instructions.");
            assert_eq!(body["stream"], true);
            assert_eq!(body["store"], false);
            assert_eq!(body["include"], json!(["reasoning.encrypted_content"]));
            assert_eq!(body["reasoning"]["effort"], "high");
            for field in UNSUPPORTED_FIELDS {
                assert!(body.get(*field).is_none(), "{field} must be omitted");
            }
            assert_eq!(body["tools"].as_array().unwrap().len(), 1);
            assert_eq!(body["tools"][0]["type"], "namespace");
            assert_eq!(body["tools"][0]["name"], SIWC_TOOL_NAMESPACE);
            assert!(
                body["tools"][0]["description"]
                    .as_str()
                    .is_some_and(|value| !value.is_empty())
            );
            assert_eq!(body["tools"][0]["tools"], json!([expected_tool]));
        }
        let initial = requests[0].body["input"].as_array().unwrap();
        assert_eq!(initial.len(), 1);
        assert_eq!(initial[0]["role"], "user");
        assert_eq!(initial[0]["content"][0]["text"], "Where is the workspace?");
        let replay = requests[1].body["input"].as_array().unwrap();
        assert_eq!(replay.len(), 4);
        assert_eq!(replay[0], initial[0]);
        assert_eq!(replay[1]["type"], "reasoning");
        assert_eq!(replay[1]["id"], "rs_1");
        assert_eq!(replay[1]["encrypted_content"], ENVELOPE);
        assert_eq!(
            replay[1]["summary"],
            json!([{"type": "summary_text", "text": "Read the workspace."}])
        );
        assert_eq!(replay[2]["type"], "function_call");
        assert_eq!(replay[2]["id"], "fc_1");
        assert_eq!(replay[2]["call_id"], "call_1");
        assert_eq!(replay[2]["name"], "exec_command");
        assert_eq!(replay[2]["arguments"], "{\"cmd\":\"pwd\"}");
        assert_eq!(replay[3]["type"], "function_call_output");
        assert_eq!(replay[3]["call_id"], replay[2]["call_id"]);
        assert_eq!(replay[3]["output"], json!("/workspace").to_string());
    }

    #[tokio::test]
    async fn subscription_usage_limit_has_actionable_message_and_preserves_diagnostics() {
        let error = json!({
            "type": "invalid_request_error",
            "code": "subscription_sharing_usage_limit_exceeded",
            "message": "The ChatGPT user has reached their Subscription Sharing usage limit. Ask the user to try again after their usage limit resets or use an API key instead.",
            "param": null,
        });
        for (status, body) in [
            (
                http::StatusCode::BAD_REQUEST,
                json!({"error": error}).to_string(),
            ),
            (
                http::StatusCode::TOO_MANY_REQUESTS,
                json!({"error": error}).to_string(),
            ),
            (
                http::StatusCode::OK,
                format!(
                    "data: {}\n\n",
                    json!({"type": "error", "error": error, "sequence_number": 2})
                ),
            ),
            (
                http::StatusCode::OK,
                format!(
                    "event: response.failed\ndata: {}\n\n",
                    json!({
                        "type": "response.failed",
                        "response": {
                            "id": "resp-test",
                            "object": "response",
                            "created_at": 0,
                            "status": "failed",
                            "model": "gpt-6.1-sol",
                            "error": error,
                            "output": [],
                            "tools": [],
                        },
                        "sequence_number": 2,
                    })
                ),
            ),
        ] {
            let raw_error = first_stream_error(stub_model(status, body)).await;
            let raw_diagnostic = raw_error.to_string();
            let report_error = user_facing_error(anyhow::Error::new(raw_error.report()));
            assert!(
                report_error
                    .downcast_ref::<SubscriptionUsageLimit>()
                    .is_some()
            );
            let error = user_facing_error(
                anyhow::Error::new(raw_error)
                    .context("Context handoff failed. Retry to continue the conversation."),
            );
            assert_eq!(
                error.to_string(),
                "Your ChatGPT subscription's usage limit for connected apps has been reached. Try again after the limit resets, or switch to another provider."
            );
            assert!(
                error
                    .chain()
                    .any(|cause| cause.to_string() == raw_diagnostic)
            );
        }
    }

    #[test]
    fn other_provider_errors_keep_their_diagnostics() {
        for body in [
            json!({"error": {"code": "rate_limit_exceeded", "message": "Retry later."}}).to_string(),
            json!({"error": {"code": "invalid_api_key", "message": "subscription_sharing_usage_limit_exceeded"}}).to_string(),
            "not JSON".to_string(),
        ] {
            let error = anyhow::Error::new(ProviderError::from_provider_body(body));
            let diagnostic = format!("{error:#}");
            assert_eq!(format!("{:#}", user_facing_error(error)), diagnostic);
        }
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
    async fn responses_model_rejects_premature_eof_and_unparseable_streams() {
        for body in [
            "",
            r#"{"detail":"not an SSE response"}"#,
            "data: [DONE]\n\n",
            "data: {not json}\n\n",
            "event: response.completed\n\n",
            "event: response.completed\ndata: {\"type\":\"response.completed\"}\n\n",
        ] {
            let error =
                first_stream_error(stub_model(http::StatusCode::OK, body.to_string())).await;
            assert!(
                matches!(error, ProviderError::Truncated | ProviderError::Json(_)),
                "unexpected error: {error}"
            );
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
        let http_client::Error::InvalidStatusCodeWithDetails {
            status,
            body: message,
            ..
        } = inference_error(response, "test-token").await
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
        let http_client::Error::InvalidStatusCodeWithDetails {
            status,
            body: message,
            ..
        } = inference_error(response, "test-token").await
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
        let http_client::Error::InvalidStatusCodeWithDetails {
            body: message,
            headers,
            ..
        } = inference_error(response, "test-token").await
        else {
            panic!("expected HTTP status and diagnostics");
        };
        assert_eq!(headers["x-request-id"], "[redacted]");
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
            let http_client::Error::InvalidStatusCodeWithDetails {
                status,
                body: message,
                ..
            } = inference_error(response, "test-token").await
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
        let http_client::Error::InvalidStatusCodeWithDetails {
            status,
            body: message,
            ..
        } = inference_error(response, "test-token").await
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

    fn completion_request(
        chat_history: Vec<Message>,
        additional_params: serde_json::Value,
    ) -> CompletionRequest {
        let mut chat_history = chat_history;
        chat_history.insert(0, Message::system("Base instructions."));
        CompletionRequest {
            model: None,
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
        let wire = StatelessResponses(
            openai::responses_api::wire::Responses::new(
                openai::OpenAIConfig::new("test-token"),
                "gpt-5.3-codex",
            )
            .with_system_instructions_placement(SystemInstructionsPlacement::AllInstructions),
        );
        let encoded = wire
            .encode(request, Mode::Streaming)
            .expect("request converts");
        let rig::wire::Body::Bytes(bytes) = encoded.request.into_body() else {
            panic!("Responses uses a JSON body");
        };
        serde_json::from_slice(&bytes).expect("request serializes")
    }

    fn shaped_body(request: CompletionRequest) -> serde_json::Value {
        let mut body = wire_body(request);
        shape_siwc_body(&mut body).unwrap();
        body
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
                AssistantContent::Reasoning(
                    Reasoning {
                        id: Some("rs_summary_only".to_string()),
                        content: vec![ReasoningContent::Summary("summary only".to_string())],
                    }
                    .sealed("openai"),
                ),
                AssistantContent::text("answer"),
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
    async fn stream_guard_bounds_unterminated_sse_frames() {
        let (_, client) = stub_client("connection-1");
        let chunks = futures::stream::iter([
            Ok::<_, std::io::Error>(Bytes::from(vec![b'x'; 4 * 1024 * 1024])),
            Ok(Bytes::from_static(b"x")),
        ]);
        let mut stream = SiwcStreamGuard::new(chunks, Arc::clone(&client.connection));
        assert!(stream.next().await.unwrap().is_ok());
        let error = stream.next().await.unwrap().unwrap_err();
        assert!(error.to_string().contains("oversized stream frame"));
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
            .call(test_request(vec![Message::user("hello")]))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("requires streaming"));
    }
}
