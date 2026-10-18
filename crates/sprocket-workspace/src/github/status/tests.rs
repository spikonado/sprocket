use super::*;

#[test]
fn reads_the_cli_version_from_its_first_line() {
    assert_eq!(
        parse_cli_version(
            "gh version 2.46.0 (2025-12-13 Ubuntu 2.46.0-4)\nhttps://github.com/cli/cli/releases/tag/v2.46.0\n"
        )
        .as_deref(),
        Some("2.46.0")
    );
}

#[test]
fn lists_hosts_gh_is_signed_in_to() {
    let output = r#"{"hosts":{"github.com":[{"state":"success","active":true,"host":"github.com","login":"octocat"}],"GHE.Example.com":[]}}"#;
    let mut hosts = parse_cli_hosts(output);
    hosts.sort();
    assert_eq!(hosts, ["ghe.example.com", "github.com"]);
    assert!(parse_cli_hosts("unknown flag: --json").is_empty());
}
