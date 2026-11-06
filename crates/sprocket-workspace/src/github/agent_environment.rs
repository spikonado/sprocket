use std::collections::BTreeSet;
use std::time::Duration;

use tokio::time::{Instant, timeout_at};

use super::credentials::{self, ResolvedCredential};
use super::{CredentialSource, PUBLIC_HOST, is_valid_host, saved_tokens};

/// Keeps an unreachable Convex or a hung `gh` from stalling every command; the
/// lookups keep running and fill the caches for the next one.
const RESOLVE_TIMEOUT: Duration = Duration::from_secs(5);

/// Gives an agent's git and `gh` the credential Sprocket uses for each GitHub
/// host, and makes them fail instead of waiting for a password.
pub async fn agent_environment(user_id: &str) -> Vec<(String, String)> {
    let credentials = host_credentials(user_id, Instant::now() + RESOLVE_TIMEOUT).await;
    environment(&credentials, |name| std::env::var(name).ok())
}

/// Hosts without a saved token or `GH_HOST` are left to the user's git setup,
/// as are hosts whose lookup misses the deadline.
async fn host_credentials(user_id: &str, deadline: Instant) -> Vec<(String, ResolvedCredential)> {
    let loading = tokio::spawn({
        let user_id = user_id.to_string();
        async move { saved_tokens::load(&user_id).await.tokens }
    });
    let mut hosts: BTreeSet<String> = match timeout_at(deadline, loading).await {
        Ok(Ok(tokens)) => tokens.into_keys().collect(),
        _ => BTreeSet::new(),
    };
    hosts.insert(PUBLIC_HOST.to_string());
    if let Ok(configured) = std::env::var("GH_HOST") {
        hosts.insert(configured.trim().to_ascii_lowercase());
    }
    let lookups: Vec<_> = hosts
        .into_iter()
        .filter(|host| is_valid_host(host))
        .map(|host| {
            let user_id = user_id.to_string();
            let lookup = tokio::spawn({
                let host = host.clone();
                async move { credentials::resolve(&user_id, &host).await }
            });
            (host, lookup)
        })
        .collect();
    let mut resolved = Vec::new();
    for (host, lookup) in lookups {
        if let Ok(Ok(Ok(credential))) = timeout_at(deadline, lookup).await {
            resolved.push((host, credential));
        }
    }
    resolved
}

fn environment(
    credentials: &[(String, ResolvedCredential)],
    var: impl Fn(&str) -> Option<String>,
) -> Vec<(String, String)> {
    let mut environment = vec![
        ("GIT_TERMINAL_PROMPT".into(), "0".into()),
        ("GH_PROMPT_DISABLED".into(), "1".into()),
    ];
    let inherited = var("GIT_CONFIG_COUNT")
        .and_then(|count| count.trim().parse::<usize>().ok())
        .unwrap_or(0);
    let mut count = inherited;
    for (index, (host, credential)) in credentials.iter().enumerate() {
        let key = format!("credential.https://{host}.helper");
        // The empty helper drops the user's own, which may be broken or prompt.
        for value in [String::new(), helper(index)] {
            environment.push((format!("GIT_CONFIG_KEY_{count}"), key.clone()));
            environment.push((format!("GIT_CONFIG_VALUE_{count}"), value));
            count += 1;
        }
        environment.push((git_token_variable(index), credential.token.clone()));
    }
    if count > inherited {
        environment.push(("GIT_CONFIG_COUNT".into(), count.to_string()));
    }
    // `gh` already reads its own login and the environment's tokens. Saved
    // Enterprise tokens stay git-only: `gh` would send `GH_ENTERPRISE_TOKEN` to
    // every Enterprise host, and `GH_HOST` would move its default off github.com.
    if let Some((_, credential)) = credentials.iter().find(|(host, credential)| {
        host == PUBLIC_HOST && credential.source == CredentialSource::Settings
    }) {
        environment.push(("GH_TOKEN".into(), credential.token.clone()));
    }
    environment
}

fn git_token_variable(index: usize) -> String {
    format!("SPROCKET_GIT_TOKEN_{index}")
}

/// Reads the token from the environment so it stays out of git's config and
/// process arguments. GitHub accepts any username with a token.
fn helper(index: usize) -> String {
    format!(
        r#"!f() {{ if [ "$1" = get ]; then printf 'username=x-access-token\npassword=%s\n' "${}"; fi; }}; f"#,
        git_token_variable(index)
    )
}

#[cfg(test)]
mod tests;
