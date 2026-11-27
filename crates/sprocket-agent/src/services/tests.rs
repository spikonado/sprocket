use super::*;

#[test]
fn tool_paths_split_at_the_connector_slug() {
    assert_eq!(
        split_tool_path("linear/create_issue"),
        Some(("linear", "create_issue"))
    );
    assert_eq!(
        split_tool_path("fs/dir/read_file"),
        Some(("fs", "dir/read_file"))
    );
    for invalid in ["linear", "/create_issue", "linear/", ""] {
        assert_eq!(split_tool_path(invalid), None, "{invalid}");
    }
}

#[test]
fn only_loopback_http_servers_are_accepted() {
    for allowed in [
        "http://localhost:3000/mcp",
        "http://127.0.0.1:8080/mcp",
        "https://[::1]/mcp",
    ] {
        assert!(loopback_http_url(allowed).is_ok(), "{allowed}");
    }
    for rejected in [
        "https://mcp.linear.app/mcp",
        "http://192.168.1.2/mcp",
        "file:///tmp/mcp",
        "localhost:3000",
    ] {
        assert!(loopback_http_url(rejected).is_err(), "{rejected}");
    }
}
