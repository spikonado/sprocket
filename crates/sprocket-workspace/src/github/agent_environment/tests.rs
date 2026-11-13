use std::collections::HashMap;
use std::io::Write;
use std::process::{Command, Stdio};

use super::*;
use crate::github::CredentialSource;

fn credential(host: &str, token: &str, source: CredentialSource) -> (String, ResolvedCredential) {
    (
        host.to_string(),
        ResolvedCredential {
            token: token.to_string(),
            source,
        },
    )
}

fn git_password(environment: &HashMap<String, String>, host: &str) -> String {
    let mut git = Command::new("git")
        .args(["credential", "fill"])
        .envs(environment)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("git runs");
    write!(git.stdin.take().unwrap(), "protocol=https\nhost={host}\n\n").unwrap();
    let output = git.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "git credential fill failed for {host}"
    );
    String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .find_map(|line| line.strip_prefix("password="))
        .unwrap()
        .to_string()
}

#[test]
fn git_gets_each_hosts_token_after_inherited_config() {
    let credentials = [
        credential("github.com", "public-token", CredentialSource::GitHubCli),
        credential(
            "ghe.example.com",
            "enterprise-token",
            CredentialSource::GitHubCli,
        ),
    ];
    let mut environment: HashMap<_, _> = environment(&credentials, |name| {
        (name == "GIT_CONFIG_COUNT").then(|| "1".to_string())
    })
    .into_iter()
    .collect();
    assert!(!environment.contains_key("GH_TOKEN"));

    environment.insert("GIT_CONFIG_KEY_0".into(), "credential.helper".into());
    environment.insert("GIT_CONFIG_VALUE_0".into(), "!echo password=wrong".into());
    assert_eq!(git_password(&environment, "github.com"), "public-token");
    assert_eq!(
        git_password(&environment, "ghe.example.com"),
        "enterprise-token"
    );
}
