//! Sprocket's tools as a streamable-HTTP MCP server on loopback, the transport Muse's session
//! MCP config takes.

use std::net::Ipv4Addr;
use std::sync::Arc;

use axum::Json;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use bytes::Bytes;
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

use crate::cli_session::{McpReply, mcp_reply};

/// A `tools/call` Muse waits on until Sprocket answers `reply`.
pub(super) struct McpCall {
    pub(super) name: String,
    pub(super) arguments: Value,
    pub(super) reply: oneshot::Sender<Value>,
}

/// Stops serving when dropped.
pub(super) struct McpEndpoint {
    pub(super) url: String,
    pub(super) token: String,
    server: JoinHandle<()>,
}

impl Drop for McpEndpoint {
    fn drop(&mut self) {
        self.server.abort();
    }
}

struct Server {
    authorization: String,
    tools: Vec<Value>,
    calls: mpsc::UnboundedSender<McpCall>,
}

pub(super) fn serve(
    tools: Vec<Value>,
    calls: mpsc::UnboundedSender<McpCall>,
) -> anyhow::Result<McpEndpoint> {
    let listener = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    listener.set_nonblocking(true)?;
    let address = listener.local_addr()?;
    let listener = tokio::net::TcpListener::from_std(listener)?;
    // Other local users can reach loopback, so only Muse holds the token.
    let token = uuid::Uuid::new_v4().simple().to_string();
    let server = Arc::new(Server {
        authorization: format!("Bearer {token}"),
        tools,
        calls,
    });
    let router = axum::Router::new()
        .route("/mcp", post(handle).delete(|| async { StatusCode::OK }))
        .with_state(server);
    let server = tokio::spawn(async move {
        if let Err(error) = axum::serve(listener, router).await {
            eprintln!("sprocket-agent: Muse's MCP server stopped ({error})");
        }
    });
    Ok(McpEndpoint {
        url: format!("http://{address}/mcp"),
        token,
        server,
    })
}

async fn handle(State(server): State<Arc<Server>>, headers: HeaderMap, body: Bytes) -> Response {
    let authorized = headers
        .get(header::AUTHORIZATION)
        .is_some_and(|value| value.as_bytes() == server.authorization.as_bytes());
    if !authorized {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Ok(message) = serde_json::from_slice::<Value>(&body) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    match mcp_reply(&message, &server.tools) {
        McpReply::Ack => StatusCode::ACCEPTED.into_response(),
        McpReply::Respond(response) => Json(response).into_response(),
        McpReply::ToolCall { rpc_id, params } => {
            let (reply, answer) = oneshot::channel();
            let _ = server.calls.send(McpCall {
                name: params["name"].as_str().unwrap_or_default().to_string(),
                arguments: params["arguments"].clone(),
                reply,
            });
            let result = answer.await.unwrap_or_else(|_| {
                json!({
                    "content": [{ "type": "text", "text": "Sprocket stopped before the tool finished." }],
                    "isError": true,
                })
            });
            Json(json!({ "jsonrpc": "2.0", "id": rpc_id, "result": result })).into_response()
        }
    }
}
