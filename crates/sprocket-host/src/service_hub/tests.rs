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
}
