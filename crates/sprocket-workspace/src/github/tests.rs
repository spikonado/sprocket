use std::collections::HashMap;
use std::ffi::OsStr;

use super::*;

fn token_for(host: &str, vars: &[(&str, &str)]) -> Option<String> {
    let vars: HashMap<_, _> = vars.iter().copied().collect();
    env_token(host, |name| vars.get(name).map(|value| value.to_string()))
}

fn graphql_errors(json: &str) -> Vec<GraphQlError> {
    serde_json::from_str(json).unwrap()
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
fn graphql_url_maps_hosts_and_rejects_argument_like_hosts() {
    assert_eq!(
        graphql_url("github.com").unwrap().as_str(),
        "https://api.github.com/graphql"
    );
    assert_eq!(
        graphql_url("acme.ghe.com").unwrap().as_str(),
        "https://api.acme.ghe.com/graphql"
    );
    assert_eq!(
        graphql_url("ghe.example.com").unwrap().as_str(),
        "https://ghe.example.com/api/graphql"
    );
    for host in ["", "--help", "a/b", "host:8080", ".example.com"] {
        assert!(graphql_url(host).is_err(), "{host:?} should be rejected");
    }
}

#[test]
fn rate_limits_are_read_from_status_headers_and_graphql_errors() {
    let limited = graphql_errors(r#"[{"type":"RATE_LIMITED","message":"slow down"}]"#);
    let not_found = graphql_errors(r#"[{"type":"NOT_FOUND","message":"no such PR"}]"#);
    let ok = StatusCode::OK;
    assert!(is_rate_limited(
        StatusCode::TOO_MANY_REQUESTS,
        None,
        false,
        None,
        ""
    ));
    assert!(is_rate_limited(ok, None, false, Some(&limited), ""));
    assert!(is_rate_limited(ok, Some("0"), false, Some(&not_found), ""));
    assert!(is_rate_limited(StatusCode::FORBIDDEN, None, true, None, ""));
    assert!(is_rate_limited(
        StatusCode::FORBIDDEN,
        None,
        false,
        None,
        "You have exceeded a secondary rate limit"
    ));
    assert!(!is_rate_limited(
        ok,
        Some("12"),
        false,
        Some(&not_found),
        ""
    ));
    assert!(!is_rate_limited(
        StatusCode::FORBIDDEN,
        Some("12"),
        false,
        None,
        "SSO required"
    ));
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
