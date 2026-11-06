use super::*;

fn tools() -> Vec<Value> {
    vec![json!({ "name": "exec_cmd", "description": "Run", "inputSchema": { "type": "object" } })]
}

#[test]
fn mcp_lists_sprocket_tools() {
    let reply = mcp_reply(
        &json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }),
        &tools(),
    );

    assert_eq!(
        reply,
        McpReply::Respond(json!({ "jsonrpc": "2.0", "id": 1, "result": { "tools": tools() } }))
    );
}

#[test]
fn mcp_tool_calls_wait_for_sprocket() {
    let call = json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/call",
        "params": { "name": "exec_cmd", "arguments": {}, "_meta": { "claudecode/toolUseId": "toolu_A" } },
    });

    assert_eq!(
        mcp_reply(&call, &tools()),
        McpReply::ToolCall {
            rpc_id: json!(2),
            tool_use_id: "toolu_A".to_string(),
        }
    );
}

#[test]
fn mcp_notifications_get_an_ack() {
    let reply = mcp_reply(
        &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
        &tools(),
    );

    assert_eq!(
        reply,
        McpReply::Respond(json!({ "jsonrpc": "2.0", "result": {} }))
    );
}

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
