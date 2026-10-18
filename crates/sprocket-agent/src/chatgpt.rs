use std::sync::Arc;

use anyhow::Context;
use bytes::Bytes;
use futures::StreamExt;
use rig::ProviderError;
use rig::http_client::{self, HeaderValue, HttpClientExt, Request, Response};
use rig::operation::Completion;
use rig::providers::openai;
use rig::wasm_compat::WasmCompatSend;
use rig::{DynModel, Model};

use crate::now_ms;
use crate::openai::StatelessResponses;
use crate::types::ChatGptCredentials;

const CONNECTION_CHANGED: &str =
    "ChatGPT connection changed or became unavailable. Start a new run.";
const STREAM_REQUIRED: &str =
    "ChatGPT inference requires streaming; non-streaming completion is not supported.";
const SIWC_TOOL_NAMESPACE: &str = "sprocket";
const OPENAI_RESPONSES_URL: &str = "https://api.openai.com/v1/responses";
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
            .downcast_ref::<rig::completion::PromptError>()
            .and_then(|error| error.provider_response_json().ok().flatten())
            .or_else(|| {
                cause
                    .downcast_ref::<ProviderError>()
                    .and_then(|error| error.provider_response_json().ok().flatten())
            })
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
    responses_url: String,
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
            let endpoint = parts.uri.to_string();
            if endpoint != this.responses_url {
                return Err(stream_error(
                    "ChatGPT inference requires the public Responses endpoint.",
                ));
            }
            let body = rewrite_request_body(&body.into())?;
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
        // The SIWC route can omit the SSE content type that Rig requires.
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
    pub(crate) fn completion_model(
        &self,
        model: impl Into<String>,
        instructions: &str,
    ) -> DynModel<Completion> {
        let wire = openai::responses_api::wire::Responses::new(
            openai::OpenAIConfig::new("siwc-managed-by-transport").with_instructions(instructions),
            model,
        );
        Model::new(
            StatelessResponses(wire),
            SiwcHttpClient {
                inner: self.http.clone(),
                authorization: Some((Arc::clone(&self.credentials), Arc::clone(&self.connection))),
                responses_url: OPENAI_RESPONSES_URL.to_string(),
            },
        )
        .erase()
    }
}

#[cfg(test)]
mod tests;
