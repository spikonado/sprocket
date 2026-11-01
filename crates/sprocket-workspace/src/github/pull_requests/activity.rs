use serde::{Deserialize, Serialize};

use super::{PullRequestRef, PullRequestState, parse_repository};
use crate::github::{GitHubApi, GitHubError};

const SNIPPET_CHARS: usize = 300;
const MARKUP_TAGS: &[&str] = &[
    "a", "b", "br", "code", "details", "em", "img", "p", "strong", "sub", "summary", "sup",
];

const QUERY: &str = "query PullRequestActivity($owner: String!, $name: String!, $number: Int!) { \
    viewer { login } \
    repository(owner: $owner, name: $name) { pullRequest(number: $number) { \
        state mergeable headRefOid \
        commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes { \
            __typename \
            ... on CheckRun { name status conclusion detailsUrl } \
            ... on StatusContext { context state targetUrl } \
        } } } } } } \
        comments(last: 20) { nodes { id author { login } body createdAt lastEditedAt url } } \
        reviews(last: 20) { nodes { id author { login } state body submittedAt url \
            comments(first: 20) { nodes { id path body url } } } } \
    } } }";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CheckOutcome {
    Pending,
    Passed,
    Failed,
}

#[derive(Clone, Debug, Serialize)]
pub struct Check {
    pub name: String,
    #[serde(skip)]
    pub outcome: CheckOutcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

/// A comment, review, or inline review comment.
#[derive(Clone, Debug, Serialize)]
pub struct Remark {
    #[serde(skip)]
    pub id: String,
    pub author: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub body: String,
    /// RFC 3339 in UTC, as GitHub writes it, so it orders as text.
    #[serde(skip)]
    pub at: String,
    pub url: String,
}

#[derive(Clone, Debug)]
pub struct Activity {
    pub state: PullRequestState,
    pub head_sha: String,
    /// `None` while GitHub is still working it out.
    pub conflicting: Option<bool>,
    pub checks: Vec<Check>,
    /// Everyone's but the viewer's, oldest first.
    pub remarks: Vec<Remark>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Change {
    Merged,
    Closed,
    ChecksFailed,
    ChecksFinished,
    Conflicting,
    NewComments,
}

/// What an agent already knows about a PR. It travels as the poll cursor, so
/// no watch state lives on the machine.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Seen {
    open: bool,
    head_sha: String,
    failed_checks: Vec<String>,
    checks_finished: bool,
    conflicting: bool,
    remarks_through: Option<String>,
    /// Remarks at `remarks_through`, since GitHub stamps to the second.
    remark_ids: Vec<String>,
}

impl Seen {
    /// A first look knows the PR's remarks but none of its check results, so
    /// failed or finished checks are news right away.
    pub fn first_look(activity: &Activity) -> Self {
        let (remarks_through, remark_ids) = seen_through(None, &[], &activity.remarks);
        Self {
            open: true,
            head_sha: activity.head_sha.clone(),
            failed_checks: Vec::new(),
            checks_finished: false,
            conflicting: false,
            remarks_through,
            remark_ids,
        }
    }
}

#[derive(Debug)]
pub struct Report {
    pub changes: Vec<Change>,
    pub new_remarks: Vec<Remark>,
    pub next: Seen,
}

pub fn compare(seen: &Seen, activity: &Activity) -> Report {
    let mut changes = Vec::new();
    let open = activity.state == PullRequestState::Open;
    if seen.open && !open {
        changes.push(match activity.state {
            PullRequestState::Merged => Change::Merged,
            _ => Change::Closed,
        });
    }

    let same_head = seen.head_sha == activity.head_sha;
    let failed_checks: Vec<String> = activity
        .checks
        .iter()
        .filter(|check| check.outcome == CheckOutcome::Failed)
        .map(|check| check.name.clone())
        .collect();
    if failed_checks
        .iter()
        .any(|name| !same_head || !seen.failed_checks.contains(name))
    {
        changes.push(Change::ChecksFailed);
    }
    let checks_finished = !activity.checks.is_empty()
        && activity
            .checks
            .iter()
            .all(|check| check.outcome != CheckOutcome::Pending);
    if checks_finished && !(same_head && seen.checks_finished) {
        changes.push(Change::ChecksFinished);
    }

    if activity.conflicting == Some(true) && !seen.conflicting {
        changes.push(Change::Conflicting);
    }

    let through = seen.remarks_through.as_deref();
    let new_remarks: Vec<Remark> = activity
        .remarks
        .iter()
        .filter(|remark| match through {
            None => true,
            Some(through) => {
                remark.at.as_str() > through
                    || (remark.at == through && !seen.remark_ids.contains(&remark.id))
            }
        })
        .cloned()
        .collect();
    if !new_remarks.is_empty() {
        changes.push(Change::NewComments);
    }
    let (remarks_through, remark_ids) = seen_through(through, &seen.remark_ids, &new_remarks);

    Report {
        changes,
        new_remarks,
        next: Seen {
            open,
            head_sha: activity.head_sha.clone(),
            failed_checks,
            checks_finished,
            conflicting: activity.conflicting.unwrap_or(seen.conflicting),
            remarks_through,
            remark_ids,
        },
    }
}

/// `fresh` are all at or after `through`.
fn seen_through(
    through: Option<&str>,
    ids: &[String],
    fresh: &[Remark],
) -> (Option<String>, Vec<String>) {
    let Some(latest) = fresh.iter().map(|remark| remark.at.as_str()).max() else {
        return (through.map(str::to_owned), ids.to_vec());
    };
    let mut latest_ids = if through == Some(latest) {
        ids.to_vec()
    } else {
        Vec::new()
    };
    latest_ids.extend(
        fresh
            .iter()
            .filter(|remark| remark.at == latest)
            .map(|remark| remark.id.clone()),
    );
    (Some(latest.to_owned()), latest_ids)
}

pub async fn fetch_activity(
    user_id: &str,
    pull_request: &PullRequestRef,
) -> Result<Activity, GitHubError> {
    let repository = parse_repository(&pull_request.repository).ok_or_else(|| {
        anyhow::anyhow!(
            "{:?} is not a repository. Repositories look like `github.com/owner/name`.",
            pull_request.repository
        )
    })?;
    let api = GitHubApi::connect(user_id, repository.host).await?;
    let variables = serde_json::json!({
        "owner": repository.owner,
        "name": repository.name,
        "number": pull_request.number,
    });
    let response = api.graphql::<Data>(QUERY, variables).await?;
    let missing = || {
        let reason = response
            .errors
            .first()
            .map_or("not found", |error| error.message.as_str());
        anyhow::anyhow!(
            "Reading {}#{} failed: {reason}",
            pull_request.repository,
            pull_request.number
        )
    };
    let data = response.data.as_ref().ok_or_else(missing)?;
    let node = data
        .repository
        .as_ref()
        .and_then(|repository| repository.pull_request.as_ref())
        .ok_or_else(missing)?;
    Ok(node.activity(&data.viewer.login))
}

#[derive(Deserialize)]
struct Data {
    viewer: Author,
    repository: Option<RepositoryNode>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RepositoryNode {
    pull_request: Option<PullRequestNode>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PullRequestNode {
    state: PullRequestState,
    mergeable: String,
    head_ref_oid: String,
    commits: Nodes<CommitNode>,
    comments: Nodes<CommentNode>,
    reviews: Nodes<ReviewNode>,
}

#[derive(Deserialize)]
struct Nodes<T> {
    nodes: Vec<T>,
}

#[derive(Deserialize)]
struct Author {
    login: String,
}

#[derive(Deserialize)]
struct CommitNode {
    commit: Commit,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Commit {
    status_check_rollup: Option<Rollup>,
}

#[derive(Deserialize)]
struct Rollup {
    contexts: Nodes<Context>,
}

#[derive(Deserialize)]
#[serde(tag = "__typename")]
enum Context {
    CheckRun(CheckRunNode),
    StatusContext(StatusContextNode),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CheckRunNode {
    name: String,
    status: String,
    conclusion: Option<String>,
    details_url: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StatusContextNode {
    context: String,
    state: String,
    target_url: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommentNode {
    id: String,
    author: Option<Author>,
    body: String,
    created_at: String,
    last_edited_at: Option<String>,
    url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReviewNode {
    id: String,
    author: Option<Author>,
    state: String,
    body: String,
    /// `None` for a review that is still a draft.
    submitted_at: Option<String>,
    url: String,
    comments: Nodes<ReviewCommentNode>,
}

#[derive(Deserialize)]
struct ReviewCommentNode {
    id: String,
    path: String,
    body: String,
    url: String,
}

impl PullRequestNode {
    fn activity(&self, viewer: &str) -> Activity {
        let checks = self
            .commits
            .nodes
            .last()
            .and_then(|node| node.commit.status_check_rollup.as_ref())
            .map_or_else(Vec::new, |rollup| {
                rollup.contexts.nodes.iter().map(Context::check).collect()
            });

        let author = |author: &Option<Author>| {
            author
                .as_ref()
                .map_or_else(|| "ghost".to_string(), |author| author.login.clone())
        };
        let mut remarks = Vec::new();
        for comment in &self.comments.nodes {
            remarks.push(Remark {
                id: comment.id.clone(),
                author: author(&comment.author),
                path: None,
                body: snippet(&comment.body),
                at: comment
                    .last_edited_at
                    .clone()
                    .unwrap_or_else(|| comment.created_at.clone()),
                url: comment.url.clone(),
            });
        }
        for review in &self.reviews.nodes {
            let Some(at) = &review.submitted_at else {
                continue;
            };
            let verdict = match review.state.as_str() {
                "APPROVED" => "Approved",
                "CHANGES_REQUESTED" => "Requested changes",
                _ => "",
            };
            let summary = snippet(&review.body);
            let body = match (verdict, summary.as_str()) {
                ("", _) => summary.clone(),
                (verdict, "") => verdict.to_string(),
                (verdict, summary) => format!("{verdict}: {summary}"),
            };
            if !body.is_empty() {
                remarks.push(Remark {
                    id: review.id.clone(),
                    author: author(&review.author),
                    path: None,
                    body,
                    at: at.clone(),
                    url: review.url.clone(),
                });
            }
            for comment in &review.comments.nodes {
                remarks.push(Remark {
                    id: comment.id.clone(),
                    author: author(&review.author),
                    path: Some(comment.path.clone()),
                    body: snippet(&comment.body),
                    at: at.clone(),
                    url: comment.url.clone(),
                });
            }
        }
        remarks.retain(|remark| !remark.author.eq_ignore_ascii_case(viewer));
        remarks.sort_by(|a, b| a.at.cmp(&b.at));

        Activity {
            state: self.state,
            head_sha: self.head_ref_oid.clone(),
            conflicting: match self.mergeable.as_str() {
                "CONFLICTING" => Some(true),
                "MERGEABLE" => Some(false),
                _ => None,
            },
            checks,
            remarks,
        }
    }
}

impl Context {
    fn check(&self) -> Check {
        match self {
            Self::CheckRun(run) => Check {
                name: run.name.clone(),
                outcome: match (run.status.as_str(), run.conclusion.as_deref()) {
                    ("COMPLETED", Some("SUCCESS" | "NEUTRAL" | "SKIPPED")) => CheckOutcome::Passed,
                    ("COMPLETED", _) => CheckOutcome::Failed,
                    _ => CheckOutcome::Pending,
                },
                url: run.details_url.clone(),
            },
            Self::StatusContext(status) => Check {
                name: status.context.clone(),
                outcome: match status.state.as_str() {
                    "SUCCESS" => CheckOutcome::Passed,
                    "ERROR" | "FAILURE" => CheckOutcome::Failed,
                    _ => CheckOutcome::Pending,
                },
                url: status.target_url.clone(),
            },
        }
    }
}

/// The start of `body` as plain text. Review bots wrap findings in HTML, and
/// an image's alt text can carry a finding's priority.
fn snippet(body: &str) -> String {
    let mut text = String::new();
    let mut rest = body;
    while let Some(start) = rest.find('<') {
        text.push_str(&rest[..start]);
        rest = &rest[start..];
        let markup_len = if let Some(comment) = rest.strip_prefix("<!--") {
            comment
                .find("-->")
                .map(|end| "<!--".len() + end + "-->".len())
        } else if is_markup_tag(rest) {
            rest.find('>').map(|end| end + 1)
        } else {
            None
        };
        let Some(markup_len) = markup_len else {
            text.push('<');
            rest = &rest[1..];
            continue;
        };
        let tag = &rest[..markup_len];
        text.push(' ');
        if let Some(alt) = tag
            .strip_prefix("<img")
            .and_then(|attributes| attributes.split_once("alt=\""))
            .and_then(|(_, alt)| alt.split_once('"'))
            .map(|(alt, _)| alt)
        {
            text.push_str(alt);
            text.push(' ');
        }
        rest = &rest[markup_len..];
    }
    text.push_str(rest);

    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.chars().count() <= SNIPPET_CHARS {
        return text;
    }
    let cut: String = text.chars().take(SNIPPET_CHARS - 3).collect();
    format!("{}...", cut.trim_end())
}

fn is_markup_tag(text: &str) -> bool {
    let name = text[1..].strip_prefix('/').unwrap_or(&text[1..]);
    let name_len = name
        .find(|c: char| !c.is_ascii_alphanumeric())
        .unwrap_or(name.len());
    MARKUP_TAGS.contains(&name[..name_len].to_ascii_lowercase().as_str())
        && name[name_len..]
            .chars()
            .next()
            .is_some_and(|c| c == '>' || c == '/' || c.is_whitespace())
}

#[cfg(test)]
mod tests;
