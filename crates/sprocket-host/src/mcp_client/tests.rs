use super::*;

use serde_json::json;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream};

struct Wire {
    stream: BufReader<DuplexStream>,
    subscription_id: Option<Value>,
}

impl Wire {
    async fn read(&mut self) -> Value {
        let mut line = String::new();
        tokio::time::timeout(Duration::from_secs(5), self.stream.read_line(&mut line))
            .await
            .unwrap()
            .unwrap();
        serde_json::from_str(&line).unwrap()
    }

    async fn send(&mut self, message: Value) {
        let mut bytes = serde_json::to_vec(&message).unwrap();
        bytes.push(b'\n');
        self.stream.get_mut().write_all(&bytes).await.unwrap();
    }

    async fn reply(&mut self, request: &Value, result: Value) {
        self.send(json!({ "jsonrpc": "2.0", "id": request["id"], "result": result }))
            .await;
    }

    async fn handshake(stream: DuplexStream, legacy: bool) -> Self {
        let mut wire = Self {
            stream: BufReader::new(stream),
            subscription_id: None,
        };
        let request = wire.read().await;
        assert_eq!(request["method"], "server/discover");
        if legacy {
            wire.send(json!({
                "jsonrpc": "2.0", "id": request["id"],
                "error": { "code": -32601, "message": "Method not found" }
            }))
            .await;
            let request = wire.read().await;
            assert_eq!(request["method"], "initialize");
            assert_eq!(request["params"]["protocolVersion"], "2025-11-25");
            wire.reply(&request, json!({
                "protocolVersion": "2025-11-25", "capabilities": { "tools": { "listChanged": true } },
                "serverInfo": { "name": "fixture", "version": "1" }
            })).await;
            assert_eq!(wire.read().await["method"], "notifications/initialized");
        } else {
            wire.reply(
                &request,
                json!({
                    "resultType": "complete", "supportedVersions": ["2026-07-28"],
                    "capabilities": { "tools": { "listChanged": true } }, "ttlMs": 0, "cacheScope": "private"
                }),
            )
            .await;
            let request = wire.read().await;
            assert_eq!(request["method"], "subscriptions/listen");
            assert_eq!(request["params"]["notifications"]["toolsListChanged"], true);
            wire.subscription_id = Some(request["id"].clone());
            wire.send(json!({
                "jsonrpc": "2.0", "method": "notifications/subscriptions/acknowledged",
                "params": {
                    "_meta": { "io.modelcontextprotocol/subscriptionId": request["id"] },
                    "notifications": request["params"]["notifications"]
                }
            }))
            .await;
        }
        wire
    }
}

struct TestElicitor {
    forms: Mutex<Vec<ElicitationForm>>,
    outcome: ElicitationOutcome,
}

impl TestElicitor {
    fn accepting(name: &str) -> Arc<Self> {
        Arc::new(Self {
            forms: Mutex::default(),
            outcome: ElicitationOutcome::Accept(
                json!({ "name": name }).as_object().unwrap().clone(),
            ),
        })
    }
}

impl Elicitor for TestElicitor {
    fn elicit(&self, form: ElicitationForm) -> futures::future::BoxFuture<'_, ElicitationOutcome> {
        self.forms.lock().unwrap().push(form);
        Box::pin(std::future::ready(self.outcome.clone()))
    }
}

#[derive(Default)]
struct PendingElicitor {
    started: CancellationToken,
    dropped: CancellationToken,
}

impl Elicitor for PendingElicitor {
    fn elicit(&self, _form: ElicitationForm) -> futures::future::BoxFuture<'_, ElicitationOutcome> {
        Box::pin(async move {
            let _guard = self.dropped.clone().drop_guard();
            self.started.cancel();
            std::future::pending().await
        })
    }
}

fn form_request() -> Value {
    json!({
        "mode": "form", "message": "Who are you?", "requestedSchema": {
            "type": "object", "properties": { "name": { "type": "string", "title": "Name" } },
            "required": ["name"]
        }
    })
}

#[tokio::test]
async fn tools_are_paginated_cached_and_refreshed_after_list_changed() {
    for legacy in [true, false] {
        tools_cache_case(legacy).await;
    }
}

async fn tools_cache_case(legacy: bool) {
    let (transport, stream) = tokio::io::duplex(8192);
    let server = tokio::spawn(async move {
        let mut wire = Wire::handshake(stream, legacy).await;
        for (name, cursor) in [("first", Some("page2")), ("second", None)] {
            let request = wire.read().await;
            assert_eq!(request["method"], "tools/list");
            if name == "second" {
                assert_eq!(request["params"]["cursor"], "page2");
            }
            wire.reply(
                &request,
                json!({
                    "tools": [{ "name": name, "inputSchema": { "type": "object" } }],
                    "nextCursor": cursor
                }),
            )
            .await;
        }
        let request = wire.read().await;
        assert_eq!(request["method"], "tools/call");
        let mut notification =
            json!({ "jsonrpc": "2.0", "method": "notifications/tools/list_changed" });
        if let Some(id) = &wire.subscription_id {
            notification["params"] =
                json!({ "_meta": { "io.modelcontextprotocol/subscriptionId": id } });
        }
        wire.send(notification).await;
        wire.send(json!({ "jsonrpc": "2.0", "id": "barrier", "method": "ping" }))
            .await;
        assert_eq!(wire.read().await["id"], "barrier");
        wire.reply(&request, json!({ "content": [] })).await;
        let request = wire.read().await;
        assert_eq!(request["method"], "tools/list");
        wire.reply(
            &request,
            json!({
                "tools": [{ "name": "updated", "inputSchema": { "type": "object" } }]
            }),
        )
        .await;
    });
    let client = McpClient::serve(transport, None).await.unwrap();
    assert!(!client.is_closed());
    assert_eq!(client.tools().await.unwrap().len(), 2);
    assert_eq!(client.tools().await.unwrap().len(), 2);
    client
        .call(
            "refresh",
            JsonObject::new(),
            TestElicitor::accepting("unused"),
        )
        .await
        .unwrap();
    assert_eq!(client.tools().await.unwrap()[0].name, "updated");
    server.await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while !client.is_closed() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn call_fulfils_mrtr_elicitation_and_preserves_the_result() {
    let (transport, stream) = tokio::io::duplex(8192);
    let server = tokio::spawn(async move {
        let mut wire = Wire::handshake(stream, false).await;
        let request = wire.read().await;
        assert_eq!(request["method"], "tools/call");
        assert_eq!(
            request["params"]["_meta"]["io.modelcontextprotocol/protocolVersion"],
            "2026-07-28"
        );
        wire.reply(&request, json!({
            "resultType": "input_required", "requestState": "opaque +/== state\n",
            "inputRequests": { "identity": { "method": "elicitation/create", "params": form_request() } }
        })).await;
        let retry = wire.read().await;
        assert_eq!(retry["method"], "tools/call");
        assert_eq!(retry["params"]["arguments"], json!({ "value": 42 }));
        assert_eq!(retry["params"]["requestState"], "opaque +/== state\n");
        assert_eq!(
            retry["params"]["inputResponses"]["identity"],
            json!({
                "action": "accept", "content": { "name": "Ada" }
            })
        );
        wire.reply(
            &retry,
            json!({
                "content": [{ "type": "text", "text": "Saved" }],
                "structuredContent": { "saved": true }, "isError": false,
                "_meta": { "private": "must not reach the agent" }
            }),
        )
        .await;
    });
    let client = McpClient::serve(transport, None).await.unwrap();
    let elicitor = TestElicitor::accepting("Ada");
    let result = client
        .call(
            "save",
            json!({ "value": 42 }).as_object().unwrap().clone(),
            elicitor.clone(),
        )
        .await
        .unwrap();
    assert_eq!(
        result,
        json!({
            "content": [{ "type": "text", "text": "Saved" }],
            "structuredContent": { "saved": true }, "isError": false
        })
    );
    let forms = elicitor.forms.lock().unwrap();
    assert_eq!(forms[0].message, "Who are you?");
    assert_eq!(forms[0].fields[0].title.as_deref(), Some("Name"));
    assert!(forms[0].fields[0].required);
    server.await.unwrap();
}

#[tokio::test]
async fn cancelling_the_oldest_call_routes_elicitation_to_the_next_call() {
    let (transport, stream) = tokio::io::duplex(8192);
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel();
    let (continue_tx, continue_rx) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let mut wire = Wire::handshake(stream, true).await;
        let first = wire.read().await;
        assert_eq!(first["params"]["name"], "first");
        started_tx.send(()).unwrap();
        let second = wire.read().await;
        assert_eq!(second["params"]["name"], "second");
        wire.send(json!({ "jsonrpc": "2.0", "id": "elicit1", "method": "elicitation/create", "params": form_request() })).await;
        assert_eq!(wire.read().await["result"]["content"]["name"], "first");
        cancel_tx.send(()).unwrap();
        continue_rx.await.unwrap();
        wire.send(json!({ "jsonrpc": "2.0", "id": "elicit2", "method": "elicitation/create", "params": form_request() })).await;
        loop {
            let response = wire.read().await;
            if response["id"] == "elicit2" {
                assert_eq!(response["result"]["content"]["name"], "second");
                break;
            }
        }
        wire.reply(&second, json!({ "content": [] })).await;
    });
    let client = Arc::new(McpClient::serve(transport, None).await.unwrap());
    let first = tokio::spawn({
        let client = client.clone();
        async move {
            client
                .call("first", JsonObject::new(), TestElicitor::accepting("first"))
                .await
        }
    });
    started_rx.await.unwrap();
    let second = tokio::spawn({
        let client = client.clone();
        async move {
            client
                .call(
                    "second",
                    JsonObject::new(),
                    TestElicitor::accepting("second"),
                )
                .await
        }
    });
    cancel_rx.await.unwrap();
    first.abort();
    assert!(first.await.unwrap_err().is_cancelled());
    continue_tx.send(()).unwrap();
    second.await.unwrap().unwrap();
    server.await.unwrap();
}

#[tokio::test]
async fn reverse_elicitation_is_dropped_when_either_request_is_cancelled() {
    for reverse_cancel in [false, true] {
        let (transport, stream) = tokio::io::duplex(8192);
        let (trigger_tx, trigger_rx) = tokio::sync::oneshot::channel();
        let (finish_tx, finish_rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let mut wire = Wire::handshake(stream, true).await;
            let request = wire.read().await;
            wire.send(json!({
                "jsonrpc": "2.0", "id": "form", "method": "elicitation/create",
                "params": form_request()
            }))
            .await;
            trigger_rx.await.unwrap();
            if reverse_cancel {
                wire.send(json!({
                    "jsonrpc": "2.0", "method": "notifications/cancelled",
                    "params": { "requestId": "form" }
                }))
                .await;
            }
            finish_rx.await.unwrap();
            if reverse_cancel {
                wire.reply(&request, json!({ "content": [] })).await;
            }
        });
        let client = Arc::new(McpClient::serve(transport, None).await.unwrap());
        let elicitor = Arc::new(PendingElicitor::default());
        let call = tokio::spawn({
            let client = client.clone();
            let elicitor = elicitor.clone();
            async move { client.call("pending", JsonObject::new(), elicitor).await }
        });
        tokio::time::timeout(Duration::from_secs(5), elicitor.started.cancelled())
            .await
            .unwrap();
        if !reverse_cancel {
            call.abort();
        }
        trigger_tx.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(5), elicitor.dropped.cancelled())
            .await
            .unwrap();
        finish_tx.send(()).unwrap();
        if reverse_cancel {
            call.await.unwrap().unwrap();
        } else {
            assert!(call.await.unwrap_err().is_cancelled());
        }
        server.await.unwrap();
    }
}

#[tokio::test(start_paused = true)]
async fn tools_returns_an_error_when_the_connected_server_stops_responding() {
    let (transport, stream) = tokio::io::duplex(8192);
    let (requested_tx, requested_rx) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let mut wire = Wire::handshake(stream, true).await;
        assert_eq!(wire.read().await["method"], "tools/list");
        requested_tx.send(()).unwrap();
        std::future::pending::<()>().await;
        drop(wire);
    });
    let client = McpClient::serve(transport, None).await.unwrap();
    let tools = tokio::spawn(async move { client.tools().await });
    requested_rx.await.unwrap();
    tokio::time::advance(REQUEST_TIMEOUT).await;
    let error = tools.await.unwrap().unwrap_err();
    assert!(error.to_string().contains("did not list its tools"));
    server.abort();
}

#[tokio::test]
async fn forms_map_scalar_fields_and_decline_unrepresentable_requests() {
    let schema: ElicitationSchema = serde_json::from_value(json!({
        "type": "object", "required": ["name", "choice"], "properties": {
            "name": { "type": "string", "description": "Your name", "default": "Ada" },
            "number": { "type": "number", "default": 1.5 },
            "integer": { "type": "integer", "default": 2 },
            "boolean": { "type": "boolean", "default": true },
            "choice": { "type": "string", "oneOf": [{ "const": "a", "title": "Alpha" }, { "const": "b", "title": "Beta" }], "default": "a" },
            "legacy": { "type": "string", "enum": ["a", "b"], "enumNames": ["Alpha", "Beta"] },
            "enum": { "type": "string", "enum": ["a", "b"] }
        }
    })).unwrap();
    let fields = form_fields(&schema).unwrap();
    let field = |name| fields.iter().find(|field| field.name == name).unwrap();
    assert_eq!(field("name").description.as_deref(), Some("Your name"));
    assert_eq!(field("name").default, Some(json!("Ada")));
    assert_eq!(field("number").kind, FieldKind::Number);
    assert_eq!(field("integer").kind, FieldKind::Integer);
    assert_eq!(field("boolean").kind, FieldKind::Boolean);
    assert!(!field("boolean").required);
    assert_eq!(field("choice").enum_values.as_ref().unwrap(), &["a", "b"]);
    assert_eq!(
        field("choice").enum_labels.as_ref().unwrap(),
        &["Alpha", "Beta"]
    );
    assert_eq!(field("legacy").enum_labels, field("choice").enum_labels);
    assert_eq!(field("enum").kind, FieldKind::Enum);

    let handler = Handler::default();
    let elicitor = TestElicitor::accepting("unused");
    let _guard = handler.register(elicitor.clone());
    for property in [
        json!({ "type": "array", "items": { "type": "string", "enum": ["a"] } }),
        json!({ "type": "string", "format": "email" }),
        json!({ "type": "number", "minimum": 1 }),
    ] {
        let mut request = form_request();
        request["requestedSchema"]["properties"]["name"] = property;
        let result = handler
            .elicit(serde_json::from_value(request).unwrap())
            .await;
        assert_eq!(result.action, ElicitationAction::Decline);
    }
    let result = handler
        .elicit(
            serde_json::from_value(json!({
                "mode": "url", "message": "Sign in", "url": "https://example.com"
            }))
            .unwrap(),
        )
        .await;
    assert_eq!(result.action, ElicitationAction::Decline);
    assert!(elicitor.forms.lock().unwrap().is_empty());
}

#[tokio::test]
async fn http_client_returns_redirects_instead_of_forwarding_secret_headers() {
    use axum::http::StatusCode;
    use axum::response::Redirect;
    use axum::routing::get;

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            axum::Router::new().route(
                "/",
                get(|| async { Redirect::temporary("https://example.com/mcp") }),
            ),
        )
        .await
        .unwrap();
    });
    let response = http_client()
        .unwrap()
        .get(format!("http://{address}/"))
        .header("x-secret", "token")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::TEMPORARY_REDIRECT);
    server.abort();
}

#[cfg(unix)]
#[tokio::test]
async fn dropping_a_stdio_process_kills_descendants_that_hold_stdout_open() {
    let mut command = tokio::process::Command::new(resolve_command("sh", &[]).unwrap());
    command.args(["-c", "sleep 60 & echo ready; wait"]);
    let (process, (stdout, _stdin)) = spawn_process(command).unwrap();
    let mut stdout = BufReader::new(stdout);
    let mut line = String::new();
    stdout.read_line(&mut line).await.unwrap();
    assert_eq!(line.trim(), "ready");
    drop(process);
    line.clear();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), stdout.read_line(&mut line))
            .await
            .unwrap()
            .unwrap(),
        0
    );
}

#[test]
fn command_resolution_uses_the_tool_environment_path() {
    let directory = tempfile::tempdir().unwrap();
    #[cfg(unix)]
    let command = "sh";
    #[cfg(windows)]
    let command = "cmd.exe";
    let original = resolve_command(command, &[]).unwrap();
    let path = directory.path().join(command);
    std::fs::copy(original, &path).unwrap();
    let environment = vec![("PATH".into(), directory.path().into())];
    assert_eq!(resolve_command(command, &environment).unwrap(), path);
    #[cfg(windows)]
    {
        let environment = vec![
            ("Path".into(), directory.path().into()),
            ("PATHEXT".into(), ".EXE".into()),
        ];
        assert_eq!(
            resolve_command("cmd", &environment).unwrap(),
            path.with_extension("EXE")
        );
    }
}
