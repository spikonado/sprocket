use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use reqwest::{StatusCode, Url};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use tokio::process::Command;

const PUBLIC_HOST: &str = "github.com";
const GH_AUTH_TIMEOUT: Duration = Duration::from_secs(10);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const TOKEN_TTL: Duration = Duration::from_secs(5 * 60);
const MISSING_TOKEN_TTL: Duration = Duration::from_secs(10);
const TOKEN_VARIABLES: [&str; 4] = [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
];

static TOKENS: LazyLock<Mutex<HashMap<String, (Option<String>, Instant)>>> =
    LazyLock::new(Default::default);

#[derive(Debug, thiserror::Error)]
pub enum GitHubError {
    #[error(
        "No GitHub credential for {0}: set GH_TOKEN, or install the GitHub CLI and run `gh auth login`."
    )]
    NoCredential(String),
    #[error("GitHub rate limit reached")]
    RateLimited,
    #[error("GitHub returned {0}")]
    Status(StatusCode),
    #[error(transparent)]
    Failed(#[from] anyhow::Error),
}

#[derive(Debug, Deserialize)]
pub struct GraphQlError {
    #[serde(rename = "type")]
    pub kind: Option<String>,
    #[serde(default)]
    pub message: String,
    /// The response path the error belongs to; its first entry is the top-level alias.
    #[serde(default)]
    pub path: Vec<serde_json::Value>,
}

/// A GraphQL answer that may be partial: aliased lookups fail one by one in `errors`.
#[derive(Debug, Deserialize)]
pub struct GraphQlResponse<T> {
    pub data: Option<T>,
    #[serde(default)]
    pub errors: Vec<GraphQlError>,
}

/// GraphQL access to one GitHub host with the local user's own credentials, so
/// private repositories work without Sprocket holding a shared token.
pub struct GitHubApi {
    http: reqwest::Client,
    host: String,
    graphql_url: Url,
    token: String,
}

impl GitHubApi {
    pub async fn connect(host: &str) -> Result<Self, GitHubError> {
        let host = host.trim().to_ascii_lowercase();
        let graphql_url = graphql_url(&host)?;
        let token = cached_token(&host)
            .await
            .ok_or_else(|| GitHubError::NoCredential(host.clone()))?;
        let http = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .user_agent("Sprocket")
            .build()
            .map_err(anyhow::Error::from)?;
        Ok(Self {
            http,
            host,
            graphql_url,
            token,
        })
    }

    pub async fn graphql<T: DeserializeOwned>(
        &self,
        query: &str,
        variables: serde_json::Value,
    ) -> Result<GraphQlResponse<T>, GitHubError> {
        let body =
            serde_json::to_vec(&serde_json::json!({ "query": query, "variables": variables }))
                .map_err(anyhow::Error::from)?;
        let response = self
            .http
            .post(self.graphql_url.clone())
            .bearer_auth(&self.token)
            .header("Content-Type", "application/json")
            .body(body)
            .send()
            .await
            .map_err(|error| anyhow::Error::from(error.without_url()))?;
        let status = response.status();
        let headers = response.headers().clone();
        let body = response
            .bytes()
            .await
            .map_err(|error| anyhow::Error::from(error.without_url()))?;
        let answer = serde_json::from_slice::<GraphQlResponse<T>>(&body).ok();
        let header = |name: &str| headers.get(name).and_then(|value| value.to_str().ok());
        let rate_limited = is_rate_limited(
            status,
            header("x-ratelimit-remaining"),
            header("retry-after").is_some(),
            answer.as_ref().map(|answer| answer.errors.as_slice()),
            &String::from_utf8_lossy(&body),
        );
        if rate_limited {
            return Err(GitHubError::RateLimited);
        }
        if status == StatusCode::UNAUTHORIZED {
            lock_tokens().remove(&self.host);
        }
        if !status.is_success() {
            return Err(GitHubError::Status(status));
        }
        answer.ok_or_else(|| anyhow::anyhow!("GitHub sent an unreadable GraphQL answer").into())
    }
}

/// Whether a host speaks GitHub's API: github.com, GHE.com data residency, or
/// the Enterprise Server named by `GH_HOST`.
pub fn is_github_host(host: &str) -> bool {
    is_github_dot_com(host)
        || std::env::var("GH_HOST")
            .is_ok_and(|configured| configured.trim().eq_ignore_ascii_case(host))
}

fn is_github_dot_com(host: &str) -> bool {
    host.eq_ignore_ascii_case(PUBLIC_HOST) || host.to_ascii_lowercase().ends_with(".ghe.com")
}

/// GitHub's own reading: a 429, a 403 that names the limit, or GraphQL errors
/// that do, which GitHub may send with a 200.
fn is_rate_limited(
    status: StatusCode,
    remaining: Option<&str>,
    retry_after: bool,
    errors: Option<&[GraphQlError]>,
    body: &str,
) -> bool {
    let limit_message = |message: &str| {
        let message = message.to_ascii_lowercase();
        message.contains("rate limit exceeded") || message.contains("rate limit already exceeded")
    };
    status == StatusCode::TOO_MANY_REQUESTS
        || errors.is_some_and(|errors| {
            !errors.is_empty()
                && (remaining == Some("0")
                    || errors.iter().any(|error| {
                        error.kind.as_deref() == Some("RATE_LIMITED")
                            || limit_message(&error.message)
                    }))
        })
        || (status == StatusCode::FORBIDDEN
            && (remaining == Some("0")
                || retry_after
                || body.to_ascii_lowercase().contains("rate limit")))
}

fn graphql_url(host: &str) -> anyhow::Result<Url> {
    let valid = !host.is_empty()
        && !host.starts_with(['-', '.'])
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-'));
    anyhow::ensure!(valid, "invalid GitHub host {host:?}");
    let url = if host == PUBLIC_HOST {
        "https://api.github.com/graphql".to_string()
    } else if host.ends_with(".ghe.com") {
        format!("https://api.{host}/graphql")
    } else {
        format!("https://{host}/api/graphql")
    };
    Ok(Url::parse(&url)?)
}

async fn cached_token(host: &str) -> Option<String> {
    if let Some(token) = env_token(host, |name| std::env::var(name).ok()) {
        return Some(token);
    }
    if let Some((token, expires)) = lock_tokens().get(host)
        && *expires > Instant::now()
    {
        return token.clone();
    }
    let token = gh_auth_token(host).await;
    let ttl = if token.is_some() {
        TOKEN_TTL
    } else {
        MISSING_TOKEN_TTL
    };
    lock_tokens().insert(host.to_string(), (token.clone(), Instant::now() + ttl));
    token
}

fn lock_tokens() -> std::sync::MutexGuard<'static, HashMap<String, (Option<String>, Instant)>> {
    TOKENS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Follows `gh`'s variables, except an enterprise token only goes to the host
/// named by `GH_HOST`, so a crafted remote can't capture it.
fn env_token(host: &str, var: impl Fn(&str) -> Option<String>) -> Option<String> {
    let read = |name: &str| {
        var(name)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    };
    if is_github_dot_com(host) {
        return read("GH_TOKEN").or_else(|| read("GITHUB_TOKEN"));
    }
    if !read("GH_HOST").is_some_and(|configured| configured.eq_ignore_ascii_case(host)) {
        return None;
    }
    read("GH_ENTERPRISE_TOKEN").or_else(|| read("GITHUB_ENTERPRISE_TOKEN"))
}

async fn gh_auth_token(host: &str) -> Option<String> {
    let output = tokio::time::timeout(GH_AUTH_TIMEOUT, gh_auth_command(host).output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let token = String::from_utf8(output.stdout).ok()?.trim().to_string();
    (!token.is_empty()).then_some(token)
}

fn gh_auth_command(host: &str) -> Command {
    let mut command = Command::new("gh");
    command
        .args(["auth", "token", "--hostname", host])
        .env("GH_PROMPT_DISABLED", "1")
        .env_remove("GH_DEBUG")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    // `gh` would otherwise hand any enterprise host the environment's token.
    for name in TOKEN_VARIABLES {
        command.env_remove(name);
    }
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    command
}

#[cfg(test)]
mod tests;
