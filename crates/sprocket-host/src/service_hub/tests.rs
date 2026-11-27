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
        catalog_id: None,
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

fn remote_server(catalog_id: Option<&str>, status: &str) -> RemoteServer {
    serde_json::from_value(serde_json::json!({
        "connectorId": "atlassian",
        "catalogId": catalog_id,
        "name": "Work tracker",
        "url": "https://work.example/mcp",
        "headerNames": [],
        "status": status,
        "policies": []
    }))
    .unwrap()
}

fn not_connected(query: &str, remote: &[RemoteServer]) -> Vec<(String, String)> {
    let keywords = query
        .split_whitespace()
        .map(str::to_lowercase)
        .collect::<Vec<_>>();
    connector_hits(&keywords, remote)
        .into_iter()
        .map(|(_, hit)| match hit {
            SearchHit::NotConnected {
                connector,
                connector_id,
            } => (connector_id, connector),
            SearchHit::Connected { .. } => panic!("expected a connector setup request"),
        })
        .collect()
}

#[test]
fn unconnected_catalog_services_match_id_name_and_description() {
    for query in ["ATLASSIAN", "Rovo", "Jira"] {
        assert_eq!(
            not_connected(query, &[]),
            [("atlassian".into(), "Atlassian Rovo".into())]
        );
    }
}

#[test]
fn catalog_search_reuses_remote_request_until_auth_completes() {
    let mut remote = remote_server(Some("atlassian"), "needs_auth");
    remote.connector_id = "work-tracker-2".into();
    for query in ["atlassian", "Rovo", "Jira", "work-tracker-2"] {
        assert_eq!(
            not_connected(query, std::slice::from_ref(&remote)),
            [("remote:work-tracker-2".into(), "Work tracker".into())]
        );
    }

    remote.status = ConnectorStatus::Connected;
    assert!(not_connected("atlassian Rovo Jira", &[remote]).is_empty());
}

#[test]
fn remote_slug_does_not_suppress_an_unrelated_catalog_service() {
    for catalog_id in [None, Some("notion")] {
        let remote = remote_server(catalog_id, "connected");
        assert_eq!(
            not_connected("atlassian", std::slice::from_ref(&remote)),
            [("atlassian".into(), "Atlassian Rovo".into())]
        );
        if catalog_id.is_some() {
            assert!(not_connected("notion", &[remote]).is_empty());
        }
    }
}

#[tokio::test]
async fn connector_requests_resolve_catalog_ids_and_remote_ids_separately() {
    let directory = tempfile::tempdir().unwrap();
    let host = Host::load(crate::HostConfig {
        data_dir: directory.path().into(),
        convex_deployment_url: "https://example.convex.cloud".into(),
        native_login_callback_url: "http://localhost/auth/callback".into(),
        browser_sessions: None,
        temporary: true,
    })
    .unwrap();
    let hub = RunServiceHub::new(&host, "user");
    hub.update_remote(vec![remote_server(Some("notion"), "needs_auth")]);

    assert_eq!(
        hub.connector_name("atlassian").as_deref(),
        Some("Atlassian Rovo")
    );
    assert_eq!(hub.connector_name("notion").as_deref(), Some("Notion"));
    assert_eq!(
        hub.connector_name("remote:atlassian").as_deref(),
        Some("Work tracker")
    );
    assert_eq!(hub.connector_name("github").as_deref(), Some("GitHub"));
    assert_eq!(hub.connector_name("remote:notion"), None);
    assert_eq!(hub.connector_name("unknown"), None);
}
