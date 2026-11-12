use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use anyhow::{Context, bail};
use serde::Deserialize;
use tokio::process::Command;

use super::{GitHubApi, GitHubError, PUBLIC_HOST, agent_environment, hide_console_window};

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Visibility {
    Public,
    Private,
}

/// Where a clone lands. `tool_environment` carries the `PATH` with Sprocket's bundled git.
pub struct CloneTarget<'a> {
    pub user_id: &'a str,
    pub parent_directory: &'a Path,
    pub tool_environment: Vec<(OsString, OsString)>,
}

pub async fn clone_repository(target: CloneTarget<'_>, source: &str) -> anyhow::Result<PathBuf> {
    let url = clone_url(source)?;
    let destination = free_destination(target.parent_directory, &url)?;
    git_clone(target, &url, &destination).await?;
    Ok(destination)
}

/// Creates `name` on the signed-in github.com account, then clones it.
pub async fn create_repository(
    target: CloneTarget<'_>,
    name: &str,
    visibility: Visibility,
) -> anyhow::Result<PathBuf> {
    let name = name.trim();
    let destination = free_destination(target.parent_directory, name)?;
    let url = create_remote(target.user_id, name, visibility).await?;
    git_clone(target, &url, &destination)
        .await
        .map_err(|error| anyhow::anyhow!("Created {url}, but {error:#}"))?;
    Ok(destination)
}

async fn create_remote(
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
            serde_json::json!({ "name": name, "visibility": visibility }),
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

fn free_destination(parent_directory: &Path, url: &str) -> anyhow::Result<PathBuf> {
    let destination = parent_directory.join(directory_name(url)?);
    if destination.exists() {
        bail!("{} already exists", destination.display());
    }
    Ok(destination)
}

async fn git_clone(target: CloneTarget<'_>, url: &str, destination: &Path) -> anyhow::Result<()> {
    let mut git = Command::new("git");
    git.args(["clone", "--", url])
        .arg(destination)
        .envs(target.tool_environment)
        .envs(agent_environment(target.user_id).await)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    hide_console_window(&mut git);
    let output = git.output().await.context("couldn't run git")?;
    if !output.status.success() {
        bail!(
            "git clone failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(())
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
        let repository = source.strip_suffix(".git").unwrap_or(source);
        format!("https://{PUBLIC_HOST}/{repository}.git")
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
