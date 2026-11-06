use std::collections::HashMap;
use std::ffi::OsStr;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{LazyLock, Mutex, OnceLock};
use std::time::{Duration, Instant};

use tokio::process::Command;

use super::{CredentialSource, GitHubError, PUBLIC_HOST, read_settings, saved_tokens};

const GH_AUTH_TIMEOUT: Duration = Duration::from_secs(10);
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

static PINNED_GH: OnceLock<PathBuf> = OnceLock::new();

/// Runs `gh` from `executable` once it's installed, instead of the one on the `PATH`.
pub fn use_pinned_gh(executable: PathBuf) {
    let _ = PINNED_GH.set(executable);
}

pub(super) struct ResolvedCredential {
    pub token: String,
    pub source: CredentialSource,
}

pub(super) async fn resolve(user_id: &str, host: &str) -> Result<ResolvedCredential, GitHubError> {
    {
        let settings = read_settings();
        if settings.disabled || settings.disabled_hosts.contains(host) {
            return Err(GitHubError::Disabled(host.to_string()));
        }
    }
    if let Some(token) = saved_tokens::load(user_id).await.tokens.remove(host) {
        return Ok(ResolvedCredential {
            token,
            source: CredentialSource::Settings,
        });
    }
    if let Some(token) = env_token(host, |name| std::env::var(name).ok()) {
        return Ok(ResolvedCredential {
            token,
            source: CredentialSource::Environment,
        });
    }
    cached_gh_token(host)
        .await
        .map(|token| ResolvedCredential {
            token,
            source: CredentialSource::GitHubCli,
        })
        .ok_or_else(|| GitHubError::NoCredential(host.to_string()))
}

pub(super) fn forget_cached(host: &str) {
    lock_tokens().remove(host);
}

pub(super) fn clear_cache() {
    lock_tokens().clear();
}

pub(super) async fn gh_output(args: &[&str]) -> Option<String> {
    let output = tokio::time::timeout(GH_AUTH_TIMEOUT, gh_command(args).output())
        .await
        .ok()?
        .ok()?;
    String::from_utf8(output.stdout).ok()
}

fn is_github_dot_com(host: &str) -> bool {
    host == PUBLIC_HOST || host.ends_with(".ghe.com")
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

fn gh_command(args: &[&str]) -> Command {
    let program = PINNED_GH
        .get()
        .filter(|executable| executable.is_file())
        .map_or(OsStr::new("gh"), |executable| executable.as_os_str());
    let mut command = Command::new(program);
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
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

#[cfg(test)]
mod tests;
