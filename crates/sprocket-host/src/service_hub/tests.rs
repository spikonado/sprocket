use super::*;
use crate::mcp_store::{McpConnector, McpTransport};

#[test]
fn unannotated_tools_need_approval_and_saved_policy_wins() {
    let mut server = McpServer {
        connector: McpConnector {
            id: "files".into(),
            name: "Files".into(),
            transport: McpTransport::Stdio {
                command: "files".into(),
                args: vec![],
                env: vec![],
            },
        },
        policies: Default::default(),
    };
    let mut tool = Tool::new("read", "Read files", serde_json::Map::new());
    assert_eq!(effective_policy(&server, &tool), ToolPolicy::Ask);
    tool.annotations = Some(rmcp::model::ToolAnnotations::new().read_only(true));
    assert_eq!(effective_policy(&server, &tool), ToolPolicy::Enabled);
    server.policies.insert("read".into(), ToolPolicy::Disabled);
    assert_eq!(effective_policy(&server, &tool), ToolPolicy::Disabled);

    let remote = RemoteServer {
        connector_id: server.connector.id.clone(),
        name: "Files".into(),
        url: "https://files.example/mcp".into(),
        header_names: vec![],
        status: ConnectorStatus::Connected,
        policies: vec![RemotePolicy {
            tool: "read".into(),
            policy: ToolPolicy::Ask,
        }],
    }
    .config();
    let tools = [server, remote].map(|s| {
        (
            format!("{}/dir/read", s.connector.id),
            effective_policy(&s, &tool),
        )
    });
    let paths: HashMap<_, _> = tools.into_iter().collect();
    assert_eq!(paths.len(), 2);
    assert_eq!(paths["files/dir/read"], ToolPolicy::Disabled);
    assert_eq!(paths["remote:files/dir/read"], ToolPolicy::Ask);
    assert_eq!(
        split_tool_path("remote:files/dir/read"),
        Some(("remote:files", "dir/read"))
    );
}
