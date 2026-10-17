use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};

use super::{GitHubApi, GitHubError, is_valid_host};

/// t3code's batch size: one GraphQL request answers this many aliased lookups.
const PULL_REQUESTS_PER_REQUEST: usize = 25;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PullRequestState {
    Open,
    Closed,
    Merged,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestRef {
    pub repository: String,
    pub number: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestStatus {
    pub repository: String,
    pub number: u32,
    pub state: PullRequestState,
}

/// What GitHub answered. PRs it could not find are left out; hosts that could
/// not answer at all are listed with why.
#[derive(Debug, Default)]
pub struct FetchedStates {
    pub states: Vec<PullRequestStatus>,
    pub failures: Vec<(String, GitHubError)>,
}

/// A `host/owner/name` repository. A host that doesn't speak GitHub's API
/// fails at `GitHubApi::connect`, since no GitHub credential exists for it.
#[derive(Debug, PartialEq, Eq)]
struct Repository<'a> {
    host: &'a str,
    owner: &'a str,
    name: &'a str,
}

fn parse_repository(repository: &str) -> Option<Repository<'_>> {
    let mut parts = repository.split('/');
    let (host, owner, name) = (parts.next()?, parts.next()?, parts.next()?);
    let segment = |segment: &str| {
        !matches!(segment, "" | "." | "..")
            && segment
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    };
    (parts.next().is_none() && is_valid_host(host) && segment(owner) && segment(name))
        .then_some(Repository { host, owner, name })
}

/// Reads the states of many PRs with one GraphQL request per host and batch.
pub async fn fetch_states(pull_requests: &[PullRequestRef]) -> FetchedStates {
    let mut by_host: BTreeMap<&str, Vec<(&PullRequestRef, Repository)>> = BTreeMap::new();
    for pull_request in pull_requests {
        if let Some(repository) = parse_repository(&pull_request.repository) {
            by_host
                .entry(repository.host)
                .or_default()
                .push((pull_request, repository));
        }
    }

    let mut fetched = FetchedStates::default();
    for (host, lookups) in by_host {
        let api = match GitHubApi::connect(host).await {
            Ok(api) => api,
            Err(error) => {
                fetched.failures.push((host.to_string(), error));
                continue;
            }
        };
        for batch in lookups.chunks(PULL_REQUESTS_PER_REQUEST) {
            match fetch_batch(&api, batch).await {
                Ok(states) => fetched.states.extend(states),
                Err(error) => {
                    fetched.failures.push((host.to_string(), error));
                    break;
                }
            }
        }
    }
    fetched
}

async fn fetch_batch(
    api: &GitHubApi,
    batch: &[(&PullRequestRef, Repository<'_>)],
) -> Result<Vec<PullRequestStatus>, GitHubError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct RepositoryNode {
        pull_request: Option<PullRequestNode>,
    }

    #[derive(Deserialize)]
    struct PullRequestNode {
        state: GraphQlState,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "UPPERCASE")]
    enum GraphQlState {
        Open,
        Closed,
        Merged,
    }

    let (query, variables) = batch_query(batch);
    let response = api
        .graphql::<HashMap<String, Option<RepositoryNode>>>(&query, variables)
        .await?;
    // A PR or repository GitHub can't find fails only its own alias, which
    // comes back null next to an error.
    let Some(data) = response.data else {
        let message = response
            .errors
            .first()
            .map_or("no data", |error| error.message.as_str());
        return Err(anyhow::anyhow!("GitHub GraphQL error: {message}").into());
    };
    Ok(batch
        .iter()
        .enumerate()
        .filter_map(|(index, (pull_request, _))| {
            let node = data
                .get(&format!("pr{index}"))?
                .as_ref()?
                .pull_request
                .as_ref()?;
            Some(PullRequestStatus {
                repository: pull_request.repository.clone(),
                number: pull_request.number,
                state: match node.state {
                    GraphQlState::Open => PullRequestState::Open,
                    GraphQlState::Closed => PullRequestState::Closed,
                    GraphQlState::Merged => PullRequestState::Merged,
                },
            })
        })
        .collect())
}

/// Each lookup goes under its own alias with typed variables, so repository
/// names never become query text.
fn batch_query(batch: &[(&PullRequestRef, Repository<'_>)]) -> (String, serde_json::Value) {
    let mut parameters = Vec::with_capacity(batch.len());
    let mut fields = Vec::with_capacity(batch.len());
    let mut variables = serde_json::Map::new();
    for (index, (pull_request, repository)) in batch.iter().enumerate() {
        parameters.push(format!(
            "$o{index}: String!, $n{index}: String!, $p{index}: Int!"
        ));
        fields.push(format!(
            "pr{index}: repository(owner: $o{index}, name: $n{index}) {{ pullRequest(number: $p{index}) {{ state }} }}"
        ));
        variables.insert(format!("o{index}"), repository.owner.into());
        variables.insert(format!("n{index}"), repository.name.into());
        variables.insert(format!("p{index}"), pull_request.number.into());
    }
    (
        format!(
            "query PullRequestStates({}) {{ {} }}",
            parameters.join(", "),
            fields.join(" ")
        ),
        variables.into(),
    )
}

#[cfg(test)]
mod tests;
