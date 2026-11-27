use super::*;

fn store(directory: &Path) -> McpStore {
    McpStore::new(directory, crate::sealed_file::os_key_store())
}

#[test]
fn secret_values_stay_out_of_the_servers_file() {
    let directory = tempfile::tempdir().unwrap();
    let store = store(directory.path());
    let added = store
        .add(
            "GitHub",
            NewMcpTransport::Stdio {
                command: "github-mcp".into(),
                args: vec![],
                env: BTreeMap::from([("GITHUB_TOKEN".into(), "ghp_secret_value".into())]),
            },
        )
        .unwrap();

    assert_eq!(added.id, "github-2");
    let servers = std::fs::read_to_string(directory.path().join(SERVERS_FILE)).unwrap();
    assert!(servers.contains("GITHUB_TOKEN"));
    assert!(!servers.contains("ghp_secret_value"));
    let restarted = self::store(directory.path());
    assert_eq!(
        restarted.secrets("github-2").unwrap()["GITHUB_TOKEN"],
        "ghp_secret_value"
    );

    restarted.delete("github-2").unwrap();
    assert!(restarted.list().unwrap().is_empty());
    assert!(restarted.secrets("github-2").unwrap().is_empty());
}
