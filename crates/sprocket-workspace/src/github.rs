mod agent_environment;
mod credentials;
pub mod pull_requests;
pub mod saved_tokens;
pub mod status;

pub use agent_environment::agent_environment;

use std::collections::BTreeSet;
use std::sync::{LazyLock, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use reqwest::{StatusCode, Url};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

pub use credentials::use_pinned_gh;

const PUBLIC_HOST: &str = "github.com";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

static SETTINGS: LazyLock<RwLock<GitHubSettings>> = LazyLock::new(Default::default);

#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GitHubSettings {
    pub disabled: bool,
    pub disabled_hosts: BTreeSet<String>,
}

pub fn settings() -> GitHubSettings {
    read_settings().clone()
}

pub fn apply_settings(settings: GitHubSettings) {
    *SETTINGS
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = settings;
    credentials::clear_cache();
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
    RateLimited { retry_after: Option<Duration> },
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
}

#[derive(Debug, Deserialize)]
pub struct GraphQlResponse<T> {
    pub data: Option<T>,
    #[serde(default)]
    pub errors: Vec<GraphQlError>,
}

pub struct GitHubApi {
    http: reqwest::Client,
    host: String,
    graphql_url: Url,
    token: String,
    source: CredentialSource,
}

impl GitHubApi {
    pub async fn connect(user_id: &str, host: &str) -> Result<Self, GitHubError> {
        let host = host.trim().to_ascii_lowercase();
        let credential = credentials::resolve(user_id, &host).await?;
        let graphql_url = graphql_url(&host)?;
        let http = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .user_agent("Sprocket")
            .build()
            .map_err(anyhow::Error::from)?;
        Ok(Self {
            http,
            host,
            graphql_url,
            token: credential.token,
            source: credential.source,
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
        self.send(serde_json::json!({ "query": query, "variables": variables }))
            .await
    }

    pub async fn operation<T: DeserializeOwned>(
        &self,
        document: &str,
        operation_name: &str,
        variables: serde_json::Value,
    ) -> Result<GraphQlResponse<T>, GitHubError> {
        self.send(serde_json::json!({
            "query": document,
            "operationName": operation_name,
            "variables": variables,
        }))
        .await
    }

    async fn send<T: DeserializeOwned>(
        &self,
        request: serde_json::Value,
    ) -> Result<GraphQlResponse<T>, GitHubError> {
        let body = serde_json::to_vec(&request).map_err(anyhow::Error::from)?;
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
            return Err(GitHubError::RateLimited {
                retry_after: retry_after(
                    header("retry-after"),
                    header("x-ratelimit-remaining"),
                    header("x-ratelimit-reset"),
                    SystemTime::now(),
                ),
            });
        }
        if status == StatusCode::UNAUTHORIZED {
            credentials::forget_cached(&self.host);
        }
        if !status.is_success() {
            return Err(GitHubError::Status(status));
        }
        answer.ok_or_else(|| anyhow::anyhow!("GitHub sent an unreadable GraphQL answer").into())
    }
}

/// GitHub's guidance: wait `retry-after` seconds, or until `x-ratelimit-reset`
/// once the quota is used up.
fn retry_after(
    retry_after: Option<&str>,
    remaining: Option<&str>,
    reset: Option<&str>,
    now: SystemTime,
) -> Option<Duration> {
    if let Some(seconds) = retry_after.and_then(|value| value.trim().parse().ok()) {
        return Some(Duration::from_secs(seconds));
    }
    if remaining != Some("0") {
        return None;
    }
    let reset = UNIX_EPOCH + Duration::from_secs(reset?.trim().parse().ok()?);
    reset.duration_since(now).ok()
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

#[cfg(test)]
mod tests;
