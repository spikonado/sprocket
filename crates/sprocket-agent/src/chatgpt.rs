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
                let status = response.status();
                return Err(http_client::Error::InvalidStatusCodeWithMessage(
                    status,
                    format!(
                        "ChatGPT inference returned HTTP {status}. Check your account's plan access or reconnect in Settings."
                    ),
                ));
            }
            let mut res = Response::builder()
                .status(response.status())
                .version(response.version());
            if let Some(headers) = res.headers_mut() {
                *headers = response.headers().clone();
            }
            let stream: rig::http_client::sse::BoxedStream = Box::pin(SiwcStreamGuard::new(
                response.bytes_stream(),
                Arc::clone(connection),
            ));
            res.body(stream).map_err(http_client::Error::Protocol)
        }
    }
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
        shape_siwc_body(&mut body).unwrap();
        let tools = body["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["type"], json!("namespace"));
        assert_eq!(tools[0]["tools"].as_array().unwrap().len(), 1);
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
