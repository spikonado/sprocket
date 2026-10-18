use std::collections::{BTreeMap, HashMap};
use std::sync::{LazyLock, Mutex, PoisonError};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::{GitHubApi, GitHubError, is_valid_host};

/// t3code's batch size: one GraphQL request answers this many aliased lookups.
const PULL_REQUESTS_PER_REQUEST: usize = 25;

const FIRST_PAUSE: Duration = Duration::from_secs(2 * 60);
const LONGEST_PAUSE: Duration = Duration::from_secs(30 * 60);

static REFRESH_PAUSES: LazyLock<HostPauses> = LazyLock::new(HostPauses::default);

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
    pub title: String,
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

/// Background refreshes back off from a host after it fails, doubling the
/// pause each time, so a rate limit or an outage isn't hit every minute.
/// A missing or switched-off credential doesn't pause, so fixing it in
/// Settings applies on the next refresh.
#[derive(Default)]
struct HostPauses {
    hosts: Mutex<HashMap<(String, String), Pause>>,
}

struct Pause {
    failures: u32,
    until: Instant,
}

impl HostPauses {
    fn is_paused(&self, user_id: &str, host: &str, now: Instant) -> bool {
        self.lock()
            .get(&(user_id.to_string(), host.to_string()))
            .is_some_and(|pause| now < pause.until)
    }

    fn record(&self, user_id: &str, host: &str, error: Option<&GitHubError>, now: Instant) {
        let key = (user_id.to_string(), host.to_string());
        let mut hosts = self.lock();
        let backs_off = matches!(
            error,
            Some(error) if !matches!(error, GitHubError::NoCredential(_) | GitHubError::Disabled(_))
        );
        if !backs_off {
            hosts.remove(&key);
            return;
        }
        let failures = hosts.get(&key).map_or(0, |pause| pause.failures) + 1;
        let pause = FIRST_PAUSE
            .saturating_mul(2u32.saturating_pow(failures - 1))
            .min(LONGEST_PAUSE);
        hosts.insert(
            key,
            Pause {
                failures,
                until: now + pause,
            },
        );
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<(String, String), Pause>> {
        self.hosts.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Reads the states of many PRs with one GraphQL request per host and batch.
pub async fn fetch_states(user_id: &str, pull_requests: &[PullRequestRef]) -> FetchedStates {
    fetch_by_host(user_id, pull_requests, None).await
}

/// Like `fetch_states`, but skips hosts that are backing off after failing.
pub async fn refresh_states(user_id: &str, pull_requests: &[PullRequestRef]) -> FetchedStates {
    fetch_by_host(user_id, pull_requests, Some(&REFRESH_PAUSES)).await
}

async fn fetch_by_host(
    user_id: &str,
    pull_requests: &[PullRequestRef],
    pauses: Option<&HostPauses>,
) -> FetchedStates {
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
        if pauses.is_some_and(|pauses| pauses.is_paused(user_id, host, Instant::now())) {
            continue;
        }
        let error = fetch_host(user_id, host, &lookups, &mut fetched.states)
            .await
            .err();
        if let Some(pauses) = pauses {
            pauses.record(user_id, host, error.as_ref(), Instant::now());
        }
        if let Some(error) = error {
            fetched.failures.push((host.to_string(), error));
        }
    }
    fetched
}

/// Stops at the first failed batch, keeping the states read before it.
async fn fetch_host(
    user_id: &str,
    host: &str,
    lookups: &[(&PullRequestRef, Repository<'_>)],
    states: &mut Vec<PullRequestStatus>,
) -> Result<(), GitHubError> {
    let api = GitHubApi::connect(user_id, host).await?;
    for batch in lookups.chunks(PULL_REQUESTS_PER_REQUEST) {
        states.extend(fetch_batch(&api, batch).await?);
    }
    Ok(())
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
        title: String,
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
    let Some(mut data) = response.data else {
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
                .get_mut(&format!("pr{index}"))?
                .as_mut()?
                .pull_request
                .take()?;
            Some(PullRequestStatus {
                repository: pull_request.repository.clone(),
                number: pull_request.number,
                state: match node.state {
                    GraphQlState::Open => PullRequestState::Open,
                    GraphQlState::Closed => PullRequestState::Closed,
                    GraphQlState::Merged => PullRequestState::Merged,
                },
                title: node.title,
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
            "pr{index}: repository(owner: $o{index}, name: $n{index}) {{ pullRequest(number: $p{index}) {{ state title }} }}"
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
