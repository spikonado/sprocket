use super::*;
use rmcp::model::ContentBlock;
use tokio::io::{AsyncWriteExt, DuplexStream};

#[test]
fn the_users_claude_settings_stay_out() {
    for key in [
        "ANTHROPIC_BASE_URL",
        "CLAUDE_CODE_USE_BEDROCK",
        "claude_config_dir",
        "MCP_TOOL_TIMEOUT",
    ] {
        assert!(is_inherited_claude_setting(OsStr::new(key)), "{key}");
    }
    assert!(!is_inherited_claude_setting(OsStr::new("PATH")));
}

async fn relay(stdout: &mut DuplexStream, request_id: &str, message: Value) {
    let request = json!({
        "type": "control_request",
        "request_id": request_id,
        "request": { "subtype": "mcp_message", "server_name": MCP_SERVER, "message": message },
    });
    let line = format!("{request}\n");
    stdout.write_all(line.as_bytes()).await.unwrap();
}

async fn response(written: &mut mpsc::UnboundedReceiver<String>) -> Value {
    let line = written.recv().await.expect("a control response");
    let message: Value = serde_json::from_str(&line).unwrap();
    message["response"].clone()
}

#[tokio::test]
async fn sprocket_tools_answer_over_the_control_protocol() {
    let (input, mut written) = mpsc::unbounded_channel();
    let (events, _events) = mpsc::unbounded_channel();
    let calls = Arc::<Mutex<ToolCalls>>::default();
    let tool = Tool::new("exec_cmd", "Run a command", serde_json::Map::new());
    let (output, from_server) =
        Output::new(input.downgrade(), events, Arc::clone(&calls), vec![tool]);
    let (mut stdout, claude_stdout) = tokio::io::duplex(64 * 1024);
    tokio::spawn(output.run(claude_stdout, from_server));

    let initialize = json!({
        "jsonrpc": "2.0",
        "id": 0,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": { "name": "claude-code", "version": "2.1.0" },
        },
    });
    relay(&mut stdout, "init", initialize).await;
    let reply = response(&mut written).await;
    assert_eq!(reply["request_id"], "init");
    assert_eq!(
        reply["response"]["mcp_response"]["result"]["protocolVersion"],
        "2025-06-18"
    );

    let initialized = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
    relay(&mut stdout, "initialized", initialized).await;
    assert_eq!(response(&mut written).await["request_id"], "initialized");

    let call = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": "exec_cmd",
            "arguments": { "cmd": "ls" },
            "_meta": { TOOL_USE_ID: "toolu_1" },
        },
    });
    relay(&mut stdout, "call", call).await;
    calls.lock().unwrap().answer(
        "toolu_1",
        CallToolResult::success(vec![ContentBlock::text("Cargo.toml")]),
    );
    let reply = response(&mut written).await;
    assert_eq!(reply["request_id"], "call");
    let result = &reply["response"]["mcp_response"];
    assert_eq!(result["id"], 1);
    assert_eq!(result["result"]["content"][0]["text"], "Cargo.toml");
}
