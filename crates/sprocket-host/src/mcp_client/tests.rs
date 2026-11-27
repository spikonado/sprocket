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
    client.call("refresh", JsonObject::new()).await.unwrap();
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
async fn call_returns_the_result_without_server_meta() {
    let (transport, stream) = tokio::io::duplex(8192);
    let server = tokio::spawn(async move {
        let mut wire = Wire::handshake(stream, false).await;
        let request = wire.read().await;
        assert_eq!(request["method"], "tools/call");
        assert_eq!(request["params"]["arguments"], json!({ "value": 42 }));
        assert_eq!(
            request["params"]["_meta"]["io.modelcontextprotocol/protocolVersion"],
            "2026-07-28"
        );
        wire.reply(
            &request,
            json!({
                "content": [{ "type": "text", "text": "Saved" }],
                "structuredContent": { "saved": true }, "isError": false,
                "_meta": { "private": "must not reach the agent" }
            }),
        )
        .await;
    });
    let client = McpClient::serve(transport, None).await.unwrap();
    let result = client
        .call("save", json!({ "value": 42 }).as_object().unwrap().clone())
        .await
        .unwrap();
    assert_eq!(
        result,
        json!({
            "content": [{ "type": "text", "text": "Saved" }],
            "structuredContent": { "saved": true }, "isError": false
        })
    );
    server.await.unwrap();
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
    let (issue, issued) = credential_issuer(vec![("token", None)]);
    let client = RemoteHttpClient::new(issue).await.unwrap();
    let response = client
        .send(client.client.get(format!("http://{address}/")))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::TEMPORARY_REDIRECT);
    assert_eq!(*issued.lock().unwrap(), [false]);
    server.abort();
}

fn credential_issuer(
    credentials: Vec<(&str, Option<f64>)>,
) -> (IssueCredential, Arc<Mutex<Vec<bool>>>) {
    let credentials: Vec<_> = credentials
        .into_iter()
        .map(|(token, expires_at)| IssuedCredential {
            headers: HashMap::from([("authorization".into(), format!("Bearer {token}"))]),
            expires_at,
        })
        .collect();
    let credentials = Arc::new(Mutex::new(std::collections::VecDeque::from(credentials)));
    let issued = Arc::new(Mutex::new(Vec::new()));
    let issue: IssueCredential = Arc::new({
        let issued = issued.clone();
        move |force_refresh| {
            issued.lock().unwrap().push(force_refresh);
            let credential = credentials
                .lock()
                .unwrap()
                .pop_front()
                .expect("unexpected credential refresh");
            Box::pin(std::future::ready(Ok(credential)))
        }
    });
    (issue, issued)
}

async fn http_fixture(app: axum::Router) -> (Arc<str>, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/", listener.local_addr().unwrap()).into();
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (url, server)
}

fn ping_message() -> ClientJsonRpcMessage {
    serde_json::from_value(json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" })).unwrap()
}

#[tokio::test]
async fn remote_requests_force_refresh_once_on_401_and_replay_the_original_request() {
    use axum::{body::Body, http::StatusCode, response::Response, routing::any};

    for method in [
        reqwest::Method::POST,
        reqwest::Method::GET,
        reqwest::Method::DELETE,
    ] {
        for accept_refreshed in [true, false] {
            let captured = Arc::new(Mutex::new(Vec::new()));
            let app = axum::Router::new().route(
                "/",
                any({
                    let captured = captured.clone();
                    move |request: axum::extract::Request| {
                        let captured = captured.clone();
                        async move {
                            let (parts, body) = request.into_parts();
                            let body = axum::body::to_bytes(body, 4096).await.unwrap();
                            let authorized = accept_refreshed
                                && parts.headers["authorization"] == "Bearer fresh";
                            let method = parts.method.clone();
                            captured.lock().unwrap().push((parts, body));
                            if !authorized {
                                let mut response = Response::new(Body::empty());
                                *response.status_mut() = StatusCode::UNAUTHORIZED;
                                if method == reqwest::Method::GET {
                                    response.headers_mut().insert(
                                        "www-authenticate",
                                        HeaderValue::from_bytes(b"\xff").unwrap(),
                                    );
                                }
                                return response;
                            }
                            match method {
                                reqwest::Method::GET => Response::builder()
                                    .header("content-type", "text/event-stream")
                                    .body(Body::from(
                                        "data: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n\n",
                                    ))
                                    .unwrap(),
                                reqwest::Method::POST => Response::builder()
                                    .header("content-type", "application/json")
                                    .body(Body::from(
                                        "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}",
                                    ))
                                    .unwrap(),
                                _ => Response::builder()
                                    .status(StatusCode::NO_CONTENT)
                                    .body(Body::empty())
                                    .unwrap(),
                            }
                        }
                    }
                }),
            );
            let (url, server) = http_fixture(app).await;
            let (issue, issued) = credential_issuer(vec![("old", None), ("fresh", None)]);
            let client = RemoteHttpClient::new(issue).await.unwrap();
            let headers = HashMap::from([
                (
                    HeaderName::from_static("mcp-protocol-version"),
                    HeaderValue::from_static("2025-11-25"),
                ),
                (
                    HeaderName::from_static("x-api-key"),
                    HeaderValue::from_static("additional-secret"),
                ),
            ]);
            let result = match method {
                reqwest::Method::POST => client
                    .post_message(url, ping_message(), Some("session".into()), None, headers)
                    .await
                    .map(|response| {
                        assert!(matches!(response, StreamableHttpPostResponse::Json(..)));
                    }),
                reqwest::Method::GET => match client
                    .get_stream(
                        url,
                        Some("session".into()),
                        Some("resume".into()),
                        None,
                        headers,
                    )
                    .await
                {
                    Ok(mut stream) => {
                        assert!(stream.next().await.unwrap().unwrap().data.is_some());
                        Ok(())
                    }
                    Err(error) => Err(error),
                },
                _ => {
                    client
                        .delete_session(url, "session".into(), None, headers)
                        .await
                }
            };
            if accept_refreshed {
                result.unwrap();
            } else {
                assert!(matches!(result, Err(HttpError::AuthRequired(_))));
            }
            assert_eq!(*issued.lock().unwrap(), [false, true]);
            let captured = captured.lock().unwrap();
            assert_eq!(captured.len(), 2);
            assert_eq!(captured[0].1, captured[1].1);
            for (index, (parts, _)) in captured.iter().enumerate() {
                assert_eq!(parts.method, method);
                assert_eq!(
                    parts.headers["authorization"],
                    if index == 0 {
                        "Bearer old"
                    } else {
                        "Bearer fresh"
                    }
                );
                assert_eq!(parts.headers["mcp-session-id"], "session");
                assert_eq!(parts.headers["mcp-protocol-version"], "2025-11-25");
                assert_eq!(parts.headers["x-api-key"], "additional-secret");
                if method == reqwest::Method::GET {
                    assert_eq!(parts.headers["last-event-id"], "resume");
                }
            }
            server.abort();
        }
    }
}

#[tokio::test(start_paused = true)]
async fn remote_requests_renew_expired_credentials_before_sending() {
    use axum::{http::StatusCode, routing::post};

    let captured = Arc::new(Mutex::new(Vec::new()));
    let app = axum::Router::new().route(
        "/",
        post({
            let captured = captured.clone();
            move |headers: HeaderMap| {
                captured
                    .lock()
                    .unwrap()
                    .push(headers["authorization"].clone());
                async { StatusCode::ACCEPTED }
            }
        }),
    );
    let (url, server) = http_fixture(app).await;
    let expires_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs_f64()
        * 1000.0
        + 60_000.0;
    let (issue, issued) = credential_issuer(vec![("old", Some(expires_at)), ("fresh", None)]);
    let client = RemoteHttpClient::new(issue).await.unwrap();
    client
        .post_message(url.clone(), ping_message(), None, None, HashMap::new())
        .await
        .unwrap();
    tokio::time::advance(Duration::from_secs(61)).await;
    client
        .post_message(url.clone(), ping_message(), None, None, HashMap::new())
        .await
        .unwrap();
    client
        .post_message(url, ping_message(), None, None, HashMap::new())
        .await
        .unwrap();
    assert_eq!(*issued.lock().unwrap(), [false, false]);
    assert_eq!(
        *captured.lock().unwrap(),
        ["Bearer old", "Bearer fresh", "Bearer fresh"]
    );
    server.abort();
}

#[tokio::test]
async fn concurrent_401_responses_share_the_forced_refresh() {
    use axum::{http::StatusCode, routing::post};

    let barrier = Arc::new(tokio::sync::Barrier::new(2));
    let app = axum::Router::new().route(
        "/",
        post(move |headers: HeaderMap| {
            let barrier = barrier.clone();
            async move {
                if headers["authorization"] == "Bearer old" {
                    barrier.wait().await;
                    StatusCode::UNAUTHORIZED
                } else {
                    assert_eq!(headers["authorization"], "Bearer fresh");
                    StatusCode::ACCEPTED
                }
            }
        }),
    );
    let (url, server) = http_fixture(app).await;
    let (issue, issued) = credential_issuer(vec![("old", None), ("fresh", None)]);
    let client = RemoteHttpClient::new(issue).await.unwrap();
    let (first, second) = tokio::time::timeout(Duration::from_secs(5), async {
        tokio::join!(
            client.post_message(url.clone(), ping_message(), None, None, HashMap::new()),
            client.post_message(url, ping_message(), None, None, HashMap::new()),
        )
    })
    .await
    .unwrap();
    first.unwrap();
    second.unwrap();
    assert_eq!(*issued.lock().unwrap(), [false, true]);
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
