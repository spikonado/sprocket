//! Sprocket's tools as a streamable-HTTP MCP server on loopback, the transport Muse's session
//! MCP config takes.

use std::net::Ipv4Addr;
use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::{StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use rmcp::transport::streamable_http_server::session::never::NeverSessionManager;
use rmcp::transport::{StreamableHttpServerConfig, StreamableHttpService};
use tokio::task::JoinHandle;

use crate::cli_session::mcp::Server;

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

pub(super) fn serve(server: Server) -> anyhow::Result<McpEndpoint> {
    let listener = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    listener.set_nonblocking(true)?;
    let address = listener.local_addr()?;
    let listener = tokio::net::TcpListener::from_std(listener)?;
    // Other local users can reach loopback, so only Muse holds the token.
    let token = uuid::Uuid::new_v4().simple().to_string();
    let service = StreamableHttpService::new(
        move || Ok(server.clone()),
        Arc::new(NeverSessionManager::default()),
        StreamableHttpServerConfig::default()
            .with_legacy_session_mode(false)
            .with_json_response(true),
    );
    let authorization: Arc<str> = format!("Bearer {token}").into();
    let router = axum::Router::new()
        .route_service("/mcp", service)
        .layer(middleware::from_fn_with_state(authorization, authorize));
    let server = tokio::spawn(async move {
        if let Err(error) = axum::serve(listener, router).await {
            tracing::warn!("Muse's MCP server stopped ({error})");
        }
    });
    Ok(McpEndpoint {
        url: format!("http://{address}/mcp"),
        token,
        server,
    })
}

async fn authorize(
    State(authorization): State<Arc<str>>,
    request: Request,
    next: Next,
) -> Response {
    let authorized = request
        .headers()
        .get(header::AUTHORIZATION)
        .is_some_and(|value| value.as_bytes() == authorization.as_bytes());
    if !authorized {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    next.run(request).await
}
