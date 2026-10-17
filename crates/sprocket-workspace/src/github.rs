use std::collections::{BTreeMap, HashMap};
use std::process::Stdio;
use std::sync::{LazyLock, Mutex, RwLock};
use std::time::{Duration, Instant};

use reqwest::{StatusCode, Url};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tokio::process::Command;

pub mod pull_requests;
pub mod saved_tokens;
pub mod status;

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

static SETTINGS: LazyLock<RwLock<GitHubSettings>> = LazyLock::new(Default::default);

/// Which hosts the user turned off on this machine in Settings → Version
/// Control. The host persists it; tokens are saved per user in `saved_tokens`.
#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GitHubSettings {
    pub disabled: bool,
    pub hosts: BTreeMap<String, HostSettings>,
}

#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HostSettings {
    pub disabled: bool,
}

pub fn settings() -> GitHubSettings {
    read_settings().clone()
}

pub fn apply_settings(settings: GitHubSettings) {
    *SETTINGS
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = settings;
    lock_tokens().clear();
}

fn read_settings() -> std::sync::RwLockReadGuard<'static, GitHubSettings> {
    SETTINGS
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CredentialSource {
    Settings,
    Environment,
    GitHubCli,
}

#[derive(Debug, thiserror::Error)]
pub enum GitHubError {
    #[error(
        "No GitHub credential for {0}: save a token in Settings → Version Control, set GH_TOKEN, or install the GitHub CLI and run `gh auth login`."
    )]
    NoCredential(String),
    #[error("GitHub access to {0} is turned off in Settings → Version Control.")]
    Disabled(String),
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
    source: CredentialSource,
}

impl GitHubApi {
    /// Connects with `user_id`'s saved token for `host`, or this machine's own
    /// credentials when they saved none.
    pub async fn connect(user_id: &str, host: &str) -> Result<Self, GitHubError> {
        let host = host.trim().to_ascii_lowercase();
        let graphql_url = graphql_url(&host)?;
        let (token, source) = credential(user_id, &host).await?;
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
            source,
        })
    }

    pub fn source(&self) -> CredentialSource {
        self.source
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

pub fn is_valid_host(host: &str) -> bool {
    !host.is_empty()
        && !host.starts_with(['-', '.'])
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-'))
}

fn graphql_url(host: &str) -> anyhow::Result<Url> {
    anyhow::ensure!(is_valid_host(host), "invalid GitHub host {host:?}");
    let url = if host == PUBLIC_HOST {
        "https://api.github.com/graphql".to_string()
    } else if host.ends_with(".ghe.com") {
        format!("https://api.{host}/graphql")
    } else {
        format!("https://{host}/api/graphql")
    };
    Ok(Url::parse(&url)?)
}

/// Saved token, then the environment's, then the `gh` login, like t3code.
async fn credential(user_id: &str, host: &str) -> Result<(String, CredentialSource), GitHubError> {
    {
        let settings = read_settings();
        if settings.disabled || settings.hosts.get(host).is_some_and(|saved| saved.disabled) {
            return Err(GitHubError::Disabled(host.to_string()));
        }
    }
    if let Some(token) = saved_tokens::load(user_id, false).await.tokens.remove(host) {
        return Ok((token, CredentialSource::Settings));
    }
    if let Some(token) = env_token(host, |name| std::env::var(name).ok()) {
        return Ok((token, CredentialSource::Environment));
    }
    cached_gh_token(host)
        .await
        .map(|token| (token, CredentialSource::GitHubCli))
        .ok_or_else(|| GitHubError::NoCredential(host.to_string()))
}

async fn cached_gh_token(host: &str) -> Option<String> {
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
    let token = gh_output(&["auth", "token", "--hostname", host]).await?;
    let token = token.trim().to_string();
    (!token.is_empty()).then_some(token)
}

/// Stdout of a `gh` run, or `None` when `gh` is missing or hangs. The exit
/// status is ignored: `gh auth status` fails when any one host is signed out.
async fn gh_output(args: &[&str]) -> Option<String> {
    let output = tokio::time::timeout(GH_AUTH_TIMEOUT, gh_command(args).output())
        .await
        .ok()?
        .ok()?;
    String::from_utf8(output.stdout).ok()
}

fn gh_command(args: &[&str]) -> Command {
    let mut command = Command::new("gh");
    command
        .args(args)
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
