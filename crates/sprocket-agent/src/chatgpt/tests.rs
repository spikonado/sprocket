use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use futures::future::BoxFuture;
use rig::completion::{CompletionRequest, Message};
use rig::message::{AssistantContent, AssistantMessage, Reasoning, ToolName};
use rig::providers::openai::responses_api::ResponsesToolDefinition;
use rig::wire::{Mode, Wire};
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::*;
use crate::history::agent_history_from_parts;
use crate::reasoning::{openai_reasoning_metadata, reasoning_summary_text};
use crate::types::{ChatGptAccess, deserialize_agent_history};
use sprocket_transcript::{TranscriptPart, TranscriptStore};

fn wire_tool(definition: &rig::completion::ToolDefinition) -> serde_json::Value {
    serde_json::to_value(ResponsesToolDefinition::from(definition.clone()))
        .expect("tool definition serializes")
}

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

fn error_response(status: http::StatusCode, body: impl Into<reqwest::Body>) -> reqwest::Response {
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
                serde_json::from_slice(&rewrite_request_body(&req.into_body().into())?).unwrap();
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
            openai::OpenAIConfig::new("test-token").with_instructions("Base instructions."),
            "gpt-6.1-sol",
        )),
        http,
    )
}

async fn first_stream_error(model: Model<StatelessResponses, StubResponseClient>) -> ProviderError {
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
async fn siwc_recovers_a_truncated_turn_without_repeating_committed_tools() {
    let tool = |id: &str| {
        json!({
            "type": "function_call", "id": format!("fc_{id}"), "call_id": id,
            "name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}",
            "status": "completed",
        })
    };
    let partial = siwc_output_sse("resp-partial", vec![tool("call_partial")]);
    let partial = partial
        .lines()
        .filter(|line| !line.contains("response.completed"))
        .collect::<Vec<_>>()
        .join("\n")
        + "\n\n";
    let (endpoint, server) = spawn_siwc_sse(vec![
        siwc_output_sse("resp-tool", vec![tool("call_committed")]),
        partial,
        siwc_output_sse(
            "resp-final",
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
        StatelessResponses(openai::responses_api::wire::Responses::new(
            openai::OpenAIConfig::new("siwc-managed-by-transport")
                .with_base_url(endpoint.trim_end_matches("/responses")),
            "gpt-6.1-sol",
        )),
        SiwcHttpClient {
            inner: reqwest::Client::builder().no_proxy().build().unwrap(),
            authorization: Some((credentials, Arc::clone(&client.connection))),
            responses_url: endpoint,
        },
    );
    let calls = Arc::new(AtomicUsize::new(0));
    let tool_calls = Arc::clone(&calls);
    let agent = rig::AgentBuilder::new(model)
        .dynamic_tool(rig::tool::DynamicTool::new(
            ToolName::new("exec_command").unwrap(),
            "Read the workspace path",
            json!({"type": "object", "properties": {"cmd": {"type": "string"}}}),
            move |_| {
                let calls = Arc::clone(&tool_calls);
                Box::pin(async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(rig::tool::ToolOutput::text("/workspace"))
                })
            },
        ))
        .build();
    let mut recovery = crate::stream_recovery::StreamRecovery::default();
    let mut history = vec![];
    let mut prompt = Message::user("Where is the workspace?");
    let answer = 'attempts: loop {
        let mut stream = agent
            .prompt(prompt)
            .history(history)
            .max_turns(3)
            .add_hook(recovery.clone())
            .stream();
        while let Some(item) = stream.next().await {
            match item {
                Ok(rig::agent::MultiTurnStreamItem::FinalResponse(response)) => {
                    break 'attempts response.output().to_string();
                }
                Err(error) => {
                    let (next_history, next_prompt, _) = recovery
                        .resume(&error)
                        .unwrap_or_else(|| panic!("truncated turn is recoverable: {error:?}"));
                    drop(stream);
                    history = next_history;
                    prompt = next_prompt;
                    continue 'attempts;
                }
                _ => {}
            }
        }
        panic!("stream ended without a final response");
    };
    assert_eq!(answer, "The workspace is /workspace.");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let requests = server.await.unwrap();
    assert_eq!(requests.len(), 3);
    assert_eq!(requests[1].body["input"], requests[2].body["input"]);
    assert!(
        requests[2].body["input"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| {
                item["type"] == "function_call_output" && item["call_id"] == "call_committed"
            })
    );
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
        StatelessResponses(openai::responses_api::wire::Responses::new(
            openai::OpenAIConfig::new("siwc-managed-by-transport")
                .with_base_url(endpoint.trim_end_matches("/responses"))
                .with_instructions("Base instructions."),
            "gpt-5.3-codex",
        )),
        SiwcHttpClient {
            inner: reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .retry(reqwest::retry::never())
                .timeout(Duration::from_secs(5))
                .build()
                .unwrap(),
            authorization: Some((credentials.clone(), Arc::clone(&client.connection))),
            responses_url: endpoint,
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
    assert_eq!(first.origin.response_id.as_deref(), Some("resp-siwc-0"));
    assert_eq!(first.provider_request_id.as_deref(), Some("req-siwc-0"));
    assert_eq!(
        first.finish_reason(),
        Some(rig::completion::FinishReason::ToolCalls)
    );
    assert_eq!(first.choice.len(), 2);
    let AssistantContent::Reasoning(reasoning) = &first.choice[0] else {
        panic!("first turn must contain parsed reasoning");
    };
    let native_reasoning = reasoning.native.as_ref().unwrap();
    assert_eq!(native_reasoning.item["id"], "rs_1");
    assert_eq!(
        crate::reasoning::opaque_reasoning_blob(reasoning),
        Some(ENVELOPE)
    );
    let AssistantContent::ToolCall(call) = &first.choice[1] else {
        panic!("first turn must contain a parsed tool call");
    };
    let native_call = call.native.as_ref().unwrap();
    assert_eq!(native_call.item["id"], "fc_1");
    assert_eq!(call.id.wire(), "call_1");
    assert_eq!(call.function.name, "exec_command");
    assert_eq!(call.function.arguments_value(), json!({"cmd": "pwd"}));

    let parts: Vec<TranscriptPart> = serde_json::from_value(json!([
        {
            "number": 0, "sourceKey": "completion:siwc", "kind": "completion",
            "runId": "run", "completion": {"streamId": "stream", "items": [
                {
                    "type": "reasoning", "text": reasoning_summary_text(reasoning),
                    "providerMetadata": openai_reasoning_metadata(
                        native_reasoning.item["id"].as_str(),
                        crate::reasoning::opaque_reasoning_blob(reasoning),
                    ),
                },
                {
                    "type": "tool-call", "callId": call.id.wire(),
                    "name": call.function.name, "input": call.function.arguments,
                    "providerMetadata": {"openai": {"itemId": native_call.item["id"]}},
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
    let mut reloaded = deserialize_agent_history(reloaded).expect("reload SIWC history");
    for message in &mut reloaded {
        if let Message::Assistant(turn) = message {
            turn.origin = Some(first.origin.clone());
        }
    }
    history.extend(reloaded);
    let second = model
        .stream(request(history))
        .unwrap()
        .finish()
        .await
        .expect("replayed SIWC turn completes");
    assert_eq!(second.origin.response_id.as_deref(), Some("resp-siwc-1"));
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
        for error in [
            anyhow::Error::new(raw_error.clone()),
            anyhow::Error::new(raw_error.report()),
            anyhow::Error::new(rig::completion::PromptError::from(raw_error.clone())),
            anyhow::Error::new(rig::completion::PromptError::from(raw_error.report())),
        ] {
            let error = user_facing_error(
                error.context("Context handoff failed. Retry to continue the conversation."),
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
}

#[test]
fn other_provider_errors_keep_their_diagnostics() {
    for body in [
        json!({"error": {"code": "rate_limit_exceeded", "message": "Retry later."}}).to_string(),
        json!({"error": {"code": "invalid_api_key", "message": "subscription_sharing_usage_limit_exceeded"}}).to_string(),
        "not JSON".to_string(),
    ] {
        let provider_error = ProviderError::from_provider_body(body);
        for error in [
            anyhow::Error::new(provider_error.clone()),
            anyhow::Error::new(rig::completion::PromptError::from(provider_error)),
        ] {
            let diagnostic = format!("{error:#}");
            assert_eq!(format!("{:#}", user_facing_error(error)), diagnostic);
        }
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
        "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_truncated\",\"status\":\"in_progress\",\"output\":[]}}\n\n",
    ] {
        let error = first_stream_error(stub_model(http::StatusCode::OK, body.to_string())).await;
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
    let mut request = CompletionRequest::new("unused");
    request.chat_history = chat_history;
    request
        .tools(vec![rig::completion::ToolDefinition {
            name: ToolName::new("exec_command").unwrap(),
            description: "Run a command".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {"cmd": {"type": "string"}}
            }),
        }])
        .max_tokens(1024)
        .additional_params(additional_params)
}

fn test_request(chat_history: Vec<Message>) -> CompletionRequest {
    completion_request(chat_history, json!({})).reasoning(rig::completion::Effort::High)
}

fn wire_body(request: CompletionRequest) -> serde_json::Value {
    let wire = StatelessResponses(openai::responses_api::wire::Responses::new(
        openai::OpenAIConfig::new("test-token").with_instructions("Base instructions."),
        "gpt-5.3-codex",
    ));
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
fn siwc_body_keeps_late_application_instructions_as_developer_messages() {
    let previous = shaped_body(test_request(vec![Message::user("hi")]));
    let body = shaped_body(test_request(vec![
        Message::user("hi"),
        Message::system("Mid-run rule."),
        Message::user("again"),
    ]));

    assert_eq!(body["instructions"], json!("Base instructions."));
    let input = body["input"].as_array().unwrap();
    assert!(
        input.iter().all(|item| item["role"] != "system"),
        "system role input items are rejected by the SIWC route: {input:?}"
    );
    assert_eq!(input.len(), 3);
    assert_eq!(body["instructions"], previous["instructions"]);
    assert_eq!(input[0], previous["input"][0]);
    assert_eq!(input[1]["role"], "developer");
    assert_eq!(input[1]["content"][0]["text"], "Mid-run rule.");
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
    let mut request = test_request(vec![Message::Assistant(
        AssistantMessage::new(vec![
            AssistantContent::Reasoning(Reasoning::new("summary only")).with_native(json!({
                "type": "reasoning", "id": "rs_summary_only",
                "summary": [{"type": "summary_text", "text": "summary only"}],
            })),
            AssistantContent::text("answer"),
        ])
        .with_origin(rig::message::Origin::new(
            rig::message::Api::from_static("openai.responses"),
            "openai",
            "gpt-5.3-codex",
        )),
    )]);
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
    let model = client.completion_model("gpt-5.3-codex", "Base instructions.");
    let error = model
        .call(test_request(vec![Message::user("hello")]))
        .await
        .unwrap_err();
    assert!(error.to_string().contains("requires streaming"));
}
