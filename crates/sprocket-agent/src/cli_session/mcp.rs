//! Sprocket's tools as an MCP server, which the CLI harnesses call back into.

use std::sync::Arc;

use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, Implementation,
    ListToolsResult, PaginatedRequestParams, RequestMetaObject, ServerCapabilities, ServerConfig,
    Tool,
};
use rmcp::service::RequestContext;
use rmcp::{ErrorData, RoleServer, ServerHandler};
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};

use super::MCP_SERVER;

pub(crate) struct ToolCall {
    pub(crate) name: String,
    pub(crate) arguments: Value,
    pub(crate) meta: RequestMetaObject,
    pub(crate) reply: oneshot::Sender<CallToolResult>,
}

/// Hands each tool call to the harness's process, which answers it once Sprocket ran the tool.
#[derive(Clone)]
pub(crate) struct Server {
    tools: Arc<[Tool]>,
    calls: mpsc::UnboundedSender<ToolCall>,
}

impl Server {
    pub(crate) fn new(tools: Vec<Tool>, calls: mpsc::UnboundedSender<ToolCall>) -> Self {
        Self {
            tools: tools.into(),
            calls,
        }
    }
}

impl ServerHandler for Server {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new(MCP_SERVER, env!("CARGO_PKG_VERSION")))
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        Ok(ListToolsResult::with_all_items(self.tools.to_vec()))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let (reply, answer) = oneshot::channel();
        let _ = self.calls.send(ToolCall {
            name: request.name.into_owned(),
            arguments: Value::Object(request.arguments.unwrap_or_default()),
            meta: context.meta,
            reply,
        });
        let result = answer
            .await
            .unwrap_or_else(|_| tool_error("Sprocket stopped before the tool finished."));
        Ok(result.into())
    }
}

pub(crate) fn tool_error(message: &str) -> CallToolResult {
    CallToolResult::error(vec![ContentBlock::text(message)])
}

/// Converts a Messages API `tool_result` block.
pub(crate) fn tool_result(block: &Value) -> CallToolResult {
    let content = match &block["content"] {
        Value::String(text) => vec![ContentBlock::text(text)],
        Value::Array(items) => items
            .iter()
            .map(|item| match (item["type"].as_str(), &item["source"]) {
                (Some("text"), _) => ContentBlock::text(item["text"].as_str().unwrap_or_default()),
                (Some("image"), source) if source["type"] == "base64" => ContentBlock::image(
                    source["data"].as_str().unwrap_or_default(),
                    source["media_type"].as_str().unwrap_or_default(),
                ),
                _ => ContentBlock::text(item.to_string()),
            })
            .collect(),
        _ => Vec::new(),
    };
    if block["is_error"] == true {
        CallToolResult::error(content)
    } else {
        CallToolResult::success(content)
    }
}
