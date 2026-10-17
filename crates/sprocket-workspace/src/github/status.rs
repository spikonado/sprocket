use std::collections::{BTreeSet, HashMap};
use std::time::Duration;

use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use tokio::task::JoinSet;

use super::{
    CredentialSource, GitHubApi, GitHubError, PUBLIC_HOST, gh_output, is_valid_host, read_settings,
};

/// Keeps an unreachable Enterprise host, e.g. off VPN, from stalling the page.
const HOST_CHECK_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubStatus {
    pub enabled: bool,
    /// `None` when the GitHub CLI isn't installed.
    pub cli_version: Option<String>,
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
/// saved settings, each with the account its credential belongs to.
pub async fn status() -> GitHubStatus {
    let (cli_version, cli_hosts) = tokio::join!(
        gh_output(&["--version"]),
        gh_output(&["auth", "status", "--json", "hosts"])
    );
    let (enabled, mut hosts) = {
        let settings = read_settings();
        (
            !settings.disabled,
            settings.hosts.keys().cloned().collect::<BTreeSet<_>>(),
        )
    };
    hosts.insert(PUBLIC_HOST.to_string());
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
        checks.spawn(host_status(host, enabled));
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
        hosts: statuses,
    }
}

async fn host_status(host: String, github_enabled: bool) -> HostStatus {
    let (enabled, has_saved_token) = read_settings()
        .hosts
        .get(&host)
        .map_or((true, false), |saved| {
            (!saved.disabled, saved.token.is_some())
        });
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
    if tokio::time::timeout(HOST_CHECK_TIMEOUT, check_credential(&mut status))
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

async fn check_credential(status: &mut HostStatus) {
    let api = match GitHubApi::connect(&status.host).await {
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
