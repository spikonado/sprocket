use std::collections::HashMap;
use std::ffi::OsStr;

use super::*;

fn token_for(host: &str, vars: &[(&str, &str)]) -> Option<String> {
    let vars: HashMap<_, _> = vars.iter().copied().collect();
    env_token(host, |name| vars.get(name).map(|value| value.to_string()))
}

#[test]
fn github_dot_com_hosts_prefer_gh_token() {
    let vars = [("GH_TOKEN", "gh"), ("GITHUB_TOKEN", "github")];
    assert_eq!(token_for("github.com", &vars).as_deref(), Some("gh"));
    assert_eq!(token_for("acme.ghe.com", &vars).as_deref(), Some("gh"));
    assert_eq!(
        token_for("github.com", &[("GITHUB_TOKEN", " github \n")]).as_deref(),
        Some("github")
    );
}

#[test]
fn enterprise_token_only_reaches_the_configured_host() {
    let vars = [
        ("GH_TOKEN", "public"),
        ("GH_HOST", "ghe.example.com"),
        ("GH_ENTERPRISE_TOKEN", "enterprise"),
    ];
    assert_eq!(
        token_for("GHE.example.com", &vars).as_deref(),
        Some("enterprise")
    );
    assert_eq!(token_for("evil.example.com", &vars), None);
}

#[test]
fn gh_runs_without_prompts_or_inherited_tokens() {
    let command = gh_command(&["auth", "token", "--hostname", "ghe.example.com"]);
    let command = command.as_std();
    assert_eq!(
        command.get_args().collect::<Vec<_>>(),
        ["auth", "token", "--hostname", "ghe.example.com"]
    );
    let envs: HashMap<_, _> = command.get_envs().collect();
    assert_eq!(
        envs.get(OsStr::new("GH_PROMPT_DISABLED")),
        Some(&Some(OsStr::new("1")))
    );
    for name in TOKEN_VARIABLES.iter().chain(&["GH_DEBUG"]) {
        assert_eq!(envs.get(OsStr::new(name)), Some(&None), "{name}");
    }
}

#[tokio::test]
async fn unloaded_saved_tokens_fail_instead_of_falling_back() {
    saved_tokens::install(std::sync::Arc::new(
        |_: String| -> saved_tokens::LoadFuture {
            Box::pin(async {
                anyhow::Result::<saved_tokens::SavedTokens>::Err(anyhow::anyhow!(
                    "Convex is unreachable"
                ))
            })
        },
    ));
    assert!(matches!(
        resolve("user-unloaded", PUBLIC_HOST).await,
        Err(GitHubError::Failed(_))
    ));
}
