use std::collections::{BTreeSet, HashMap};
use std::time::Duration;

use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use tokio::task::JoinSet;

use super::{
    CredentialSource, GitHubApi, GitHubError, PUBLIC_HOST, gh_output, is_valid_host, read_settings,
    saved_tokens,
};

/// Keeps an unreachable Enterprise host, e.g. off VPN, from stalling the page.
const HOST_CHECK_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubStatus {
    pub enabled: bool,
    /// `None` when the GitHub CLI isn't installed.
    pub cli_version: Option<String>,
    /// Why the user's saved tokens couldn't be loaded, if they couldn't.
    pub saved_tokens_problem: Option<String>,
    pub hosts: Vec<HostStatus>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStatus {
    pub host: String,
    pub enabled: bool,
    pub has_saved_token: bool,
    pub source: Option<CredentialSource>,
    pub login: Option<String>,
    pub problem: Option<String>,
}

/// Lists github.com, `GH_HOST`, hosts `gh` is signed in to, and hosts with
/// saved tokens or settings, each with the account its credential belongs to.
pub async fn status(user_id: &str) -> GitHubStatus {
    let (cli_version, cli_hosts, saved) = tokio::join!(
        gh_output(&["--version"]),
        gh_output(&["auth", "status", "--json", "hosts"]),
        saved_tokens::load(user_id, true)
    );
    let (enabled, mut hosts) = {
        let settings = read_settings();
        (
            !settings.disabled,
            settings.hosts.keys().cloned().collect::<BTreeSet<_>>(),
        )
    };
    hosts.insert(PUBLIC_HOST.to_string());
    hosts.extend(saved.tokens.keys().cloned());
    hosts.extend(
        cli_hosts
            .as_deref()
            .map(parse_cli_hosts)
            .unwrap_or_default(),
    );
    if let Ok(configured) = std::env::var("GH_HOST") {
        hosts.insert(configured.trim().to_ascii_lowercase());
    }
    hosts.retain(|host| is_valid_host(host));

    let mut checks = JoinSet::new();
    for host in hosts {
        let has_saved_token = saved.tokens.contains_key(&host);
        checks.spawn(host_status(
            user_id.to_string(),
            host,
            has_saved_token,
            enabled,
        ));
    }
    let mut statuses = Vec::with_capacity(checks.len());
    while let Some(checked) = checks.join_next().await {
        statuses.extend(checked.ok());
    }
    statuses
        .sort_by(|a, b| (a.host != PUBLIC_HOST, &a.host).cmp(&(b.host != PUBLIC_HOST, &b.host)));
    GitHubStatus {
        enabled,
        cli_version: cli_version.as_deref().and_then(parse_cli_version),
        saved_tokens_problem: saved.error,
        hosts: statuses,
    }
}

async fn host_status(
    user_id: String,
    host: String,
    has_saved_token: bool,
    github_enabled: bool,
) -> HostStatus {
    let enabled = read_settings()
        .hosts
        .get(&host)
        .is_none_or(|saved| !saved.disabled);
    let mut status = HostStatus {
        host,
        enabled,
        has_saved_token,
        source: None,
        login: None,
        problem: None,
    };
    if !github_enabled || !enabled {
        return status;
    }
    if tokio::time::timeout(HOST_CHECK_TIMEOUT, check_credential(&user_id, &mut status))
        .await
        .is_err()
    {
        status.problem = Some(format!(
            "{} didn't answer within {} seconds.",
            status.host,
            HOST_CHECK_TIMEOUT.as_secs()
        ));
    }
    status
}

async fn check_credential(user_id: &str, status: &mut HostStatus) {
    let api = match GitHubApi::connect(user_id, &status.host).await {
        Ok(api) => api,
        Err(GitHubError::NoCredential(_)) => return,
        Err(error) => {
            status.problem = Some(error.to_string());
            return;
        }
    };
    status.source = Some(api.source());
    match viewer_login(&api).await {
        Ok(login) => status.login = Some(login),
        Err(GitHubError::Status(code)) if code == StatusCode::UNAUTHORIZED => {
            status.problem = Some("GitHub refused this credential.".to_string());
        }
        Err(error) => status.problem = Some(error.to_string()),
    }
}

async fn viewer_login(api: &GitHubApi) -> Result<String, GitHubError> {
    #[derive(Deserialize)]
    struct Data {
        viewer: Viewer,
    }

    #[derive(Deserialize)]
    struct Viewer {
        login: String,
    }

    let response = api
        .graphql::<Data>("query { viewer { login } }", serde_json::json!({}))
        .await?;
    response
        .data
        .map(|data| data.viewer.login)
        .ok_or_else(|| anyhow::anyhow!("GitHub didn't say who this credential belongs to").into())
}

/// `gh version 2.46.0 (2025-12-13)` → `2.46.0`.
fn parse_cli_version(output: &str) -> Option<String> {
    output
        .lines()
        .next()?
        .strip_prefix("gh version ")?
        .split_whitespace()
        .next()
        .map(str::to_string)
}

/// Hosts from `gh auth status --json hosts`, which gh has had since 2.81.
/// Older versions reject the flag, so they only show the hosts known otherwise.
fn parse_cli_hosts(output: &str) -> Vec<String> {
    #[derive(Deserialize)]
    struct AuthStatus {
        hosts: HashMap<String, serde_json::Value>,
    }

    serde_json::from_str::<AuthStatus>(output).map_or_else(
        |_| Vec::new(),
        |status| {
            status
                .hosts
                .into_keys()
                .map(|host| host.trim().to_ascii_lowercase())
                .collect()
        },
    )
}

#[cfg(test)]
mod tests;
