use std::path::{Path, PathBuf};
use std::process::Stdio;

use anyhow::{Context, bail};
use serde::Deserialize;
use tokio::process::Command;

use super::{GitHubApi, GitHubError, PUBLIC_HOST, agent_environment};

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Visibility {
    Public,
    Private,
}

/// Creates `name` under the signed-in GitHub account and returns its URL.
pub async fn create_repository(
    user_id: &str,
    name: &str,
    visibility: Visibility,
) -> Result<String, GitHubError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Data {
        create_repository: Option<Created>,
    }

    #[derive(Deserialize)]
    struct Created {
        repository: Repository,
    }

    #[derive(Deserialize)]
    struct Repository {
        url: String,
    }

    let api = GitHubApi::connect(user_id, PUBLIC_HOST).await?;
    let visibility = match visibility {
        Visibility::Public => "PUBLIC",
        Visibility::Private => "PRIVATE",
    };
    let response = api
        .graphql::<Data>(
            "mutation($name: String!, $visibility: RepositoryVisibility!) { createRepository(input: { name: $name, visibility: $visibility }) { repository { url } } }",
            serde_json::json!({ "name": name.trim(), "visibility": visibility }),
        )
        .await?;
    match response.data.and_then(|data| data.create_repository) {
        Some(created) => Ok(created.repository.url),
        None => {
            let message = response
                .errors
                .first()
                .map_or("no data", |error| error.message.as_str());
            Err(anyhow::anyhow!("GitHub couldn't create the repository: {message}").into())
        }
    }
}

/// Clones `source` into a new directory under `parent_directory`, named after the repository.
pub async fn clone_repository(
    user_id: &str,
    source: &str,
    parent_directory: &Path,
) -> anyhow::Result<PathBuf> {
    let url = clone_url(source)?;
    let destination = parent_directory.join(directory_name(&url)?);
    if destination.exists() {
        bail!("{} already exists", destination.display());
    }
    let mut git = Command::new("git");
    git.args(["clone", "--", &url])
        .arg(&destination)
        .envs(agent_environment(user_id).await)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        git.creation_flags(CREATE_NO_WINDOW);
    }
    let output = git.output().await.context("couldn't run git")?;
    if !output.status.success() {
        bail!(
            "git clone failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(destination)
}

/// Expands GitHub's `owner/name` shorthand; other sources go to git as written.
fn clone_url(source: &str) -> anyhow::Result<String> {
    let source = source.trim();
    if source.is_empty() {
        bail!("Enter a repository to clone");
    }
    let is_shorthand = !source.contains(':')
        && source.split_once('/').is_some_and(|(owner, name)| {
            !owner.is_empty() && !name.is_empty() && !name.contains('/')
        });
    Ok(if is_shorthand {
        format!("https://{PUBLIC_HOST}/{source}.git")
    } else {
        source.to_string()
    })
}

fn directory_name(url: &str) -> anyhow::Result<&str> {
    let name = url
        .trim_end_matches('/')
        .rsplit(['/', ':', '\\'])
        .next()
        .unwrap_or_default();
    let name = name.strip_suffix(".git").unwrap_or(name);
    if name.is_empty() || name == "." || name == ".." {
        bail!("couldn't name a directory after {url}");
    }
    Ok(name)
}

#[cfg(test)]
mod tests;
