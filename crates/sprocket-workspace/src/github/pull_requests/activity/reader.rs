use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use super::{Activity, Check, CheckOutcome, Remark, snippet};
use crate::github::pull_requests::{PullRequestRef, PullRequestState, parse_repository};
use crate::github::{GitHubApi, GitHubError};

const QUERIES: &str = include_str!("queries.graphql");
/// Ends a read that keeps paging, such as on a cursor that never runs out.
const MAX_REQUESTS_PER_READ: usize = 50;

/// Reads one PR's activity, skipping full reads while a cheap fingerprint
/// says nothing changed.
pub struct ActivityReader {
    api: GitHubApi,
    label: String,
    variables: Value,
    last: Option<LastRead>,
}

struct LastRead {
    fingerprint: Fingerprint,
    remarks: Vec<Remark>,
}

#[derive(PartialEq, Eq)]
struct Fingerprint {
    status: String,
    remarks: String,
}

impl ActivityReader {
    pub async fn connect(
        user_id: &str,
        pull_request: &PullRequestRef,
    ) -> Result<Self, GitHubError> {
        let repository = parse_repository(&pull_request.repository).ok_or_else(|| {
            anyhow::anyhow!(
                "{:?} is not a repository. Repositories look like `github.com/owner/name`.",
                pull_request.repository
            )
        })?;
        let api = GitHubApi::connect(user_id, repository.host).await?;
        // Older Enterprise servers may lack `isRequired`.
        let required = api.host() == "github.com";
        Ok(Self {
            variables: json!({
                "owner": repository.owner,
                "name": repository.name,
                "number": pull_request.number,
                "required": required,
            }),
            label: format!("{}#{}", pull_request.repository, pull_request.number),
            api,
            last: None,
        })
    }

    /// `None` when GitHub reports nothing new since the last read.
    pub async fn read(&mut self) -> Result<Option<Activity>, GitHubError> {
        let mut budget = MAX_REQUESTS_PER_READ;
        let fingerprint = self.fingerprint(&mut budget).await?;
        if self
            .last
            .as_ref()
            .is_some_and(|last| last.fingerprint == fingerprint)
        {
            return Ok(None);
        }
        let (viewer, mut activity) = self.status(&mut budget).await?;
        activity.remarks = match self.last.take() {
            Some(last) if last.fingerprint.remarks == fingerprint.remarks => last.remarks,
            _ => self.remarks(&viewer, &mut budget).await?,
        };
        self.last = Some(LastRead {
            fingerprint,
            remarks: activity.remarks.clone(),
        });
        Ok(Some(activity))
    }

    async fn query<T: DeserializeOwned>(
        &self,
        operation: &str,
        extra: Value,
        budget: &mut usize,
    ) -> Result<T, GitHubError> {
        if *budget == 0 {
            return Err(
                anyhow::anyhow!("{} has too much activity to read at once.", self.label).into(),
            );
        }
        *budget -= 1;
        let mut variables = self.variables.clone();
        if let (Value::Object(base), Value::Object(extra)) = (&mut variables, extra) {
            base.extend(extra);
        }
        let response = self
            .api
            .operation::<T>(QUERIES, operation, variables)
            .await?;
        let reason = response
            .errors
            .first()
            .map_or("no data", |error| error.message.as_str())
            .to_string();
        response
            .data
            .ok_or_else(|| anyhow::anyhow!("Reading {} failed: {reason}", self.label).into())
    }

    fn pull_request<T>(&self, repository: Option<Repo<T>>) -> Result<T, GitHubError> {
        repository
            .and_then(|repository| repository.pull_request)
            .ok_or_else(|| anyhow::anyhow!("{} was not found on GitHub.", self.label).into())
    }

    async fn fingerprint(&self, budget: &mut usize) -> Result<Fingerprint, GitHubError> {
        let data: FingerprintData = self
            .query("PullRequestWatchFingerprint", json!({}), budget)
            .await?;
        let pr = self.pull_request(data.repository)?;
        let counts = pr
            .commits
            .nodes
            .last()
            .and_then(|node| node.commit.status_check_rollup.as_ref())
            .map(|rollup| &rollup.contexts);
        let reviews = pr.reviews.as_ref();
        Ok(Fingerprint {
            status: [
                pr.state,
                pr.mergeable,
                pr.head_ref_oid,
                state_counts(counts.and_then(|counts| counts.check_run_counts_by_state.as_deref())),
                state_counts(
                    counts.and_then(|counts| counts.status_context_counts_by_state.as_deref()),
                ),
            ]
            .join(" "),
            remarks: [
                pr.comments.total_count.to_string(),
                newest_edit(Some(&pr.comments)),
                reviews.map_or(0, |reviews| reviews.total_count).to_string(),
                newest_edit(reviews),
                pr.review_threads.total_count.to_string(),
            ]
            .join(" "),
        })
    }

    /// The viewer's login and everything but the remarks.
    async fn status(&self, budget: &mut usize) -> Result<(String, Activity), GitHubError> {
        let data: CoreData = self.query("PullRequestCore", json!({}), budget).await?;
        let pr = self.pull_request(data.repository)?;
        let mut checks = Vec::new();
        let mut after = pr.commits.read_contexts(&mut checks);
        while let Some(cursor) = after.take() {
            let next: CheckContextsData = self
                .query(
                    "PullRequestCheckContexts",
                    json!({ "after": cursor }),
                    budget,
                )
                .await?;
            let page = self.pull_request(next.repository)?;
            // Each page names the head it read, so a push mid-walk fails rather
            // than mixing two commits' checks.
            if page.head_ref_oid != pr.head_ref_oid {
                return Err(anyhow::anyhow!(
                    "{} got a new commit while its checks were read. Poll again.",
                    self.label
                )
                .into());
            }
            after = page.commits.read_contexts(&mut checks);
        }
        Ok((
            data.viewer.login,
            Activity {
                state: pr.state,
                head_sha: pr.head_ref_oid,
                conflicting: match pr.mergeable.as_str() {
                    "CONFLICTING" => Some(true),
                    "MERGEABLE" => Some(false),
                    _ => None,
                },
                checks,
                remarks: Vec::new(),
            },
        ))
    }

    /// Everyone's but the viewer's, oldest first.
    async fn remarks(&self, viewer: &str, budget: &mut usize) -> Result<Vec<Remark>, GitHubError> {
        let mut remarks = Vec::new();

        let (mut comments_after, mut reviews_after) = (None::<String>, None::<String>);
        let (mut with_comments, mut with_reviews) = (true, true);
        while with_comments || with_reviews {
            let data: ActivityData = self
                .query(
                    "PullRequestActivity",
                    json!({
                        "withComments": with_comments,
                        "commentsAfter": comments_after,
                        "withReviews": with_reviews,
                        "reviewsAfter": reviews_after,
                    }),
                    budget,
                )
                .await?;
            let pr = self.pull_request(data.repository)?;
            comments_after = pr.comments.filter(|_| with_comments).and_then(|page| {
                remarks.extend(page.nodes.iter().map(|comment| comment.remark(None)));
                page.page_info.next()
            });
            reviews_after = pr.reviews.filter(|_| with_reviews).and_then(|page| {
                remarks.extend(page.nodes.iter().filter_map(ReviewNode::remark));
                page.page_info.next()
            });
            with_comments = comments_after.is_some();
            with_reviews = reviews_after.is_some();
        }

        let mut threads_after = None;
        loop {
            let data: ThreadsData = self
                .query("ReviewThreads", json!({ "after": threads_after }), budget)
                .await?;
            let threads = self.pull_request(data.repository)?.review_threads;
            for thread in &threads.nodes {
                let path = Some(thread.path.as_str());
                remarks.extend(
                    thread
                        .comments
                        .nodes
                        .iter()
                        .map(|comment| comment.remark(path)),
                );
                let mut after = thread.comments.page_info.next();
                while let Some(cursor) = after.take() {
                    let data: ThreadCommentsData = self
                        .query(
                            "ReviewThreadComments",
                            json!({ "threadId": thread.id, "after": cursor }),
                            budget,
                        )
                        .await?;
                    if let Some(node) = data.node {
                        remarks.extend(
                            node.comments
                                .nodes
                                .iter()
                                .map(|comment| comment.remark(path)),
                        );
                        after = node.comments.page_info.next();
                    }
                }
            }
            threads_after = threads.page_info.next();
            if threads_after.is_none() {
                break;
            }
        }

        remarks.retain(|remark| !remark.author.eq_ignore_ascii_case(viewer));
        remarks.sort_by(|a, b| a.at.cmp(&b.at));
        Ok(remarks)
    }
}

fn state_counts(counts: Option<&[StateCount]>) -> String {
    let mut counts: Vec<String> = counts
        .unwrap_or_default()
        .iter()
        .filter(|count| count.count > 0)
        .map(|count| format!("{}:{}", count.state, count.count))
        .collect();
    counts.sort();
    counts.join(",")
}

fn newest_edit(connection: Option<&Edited>) -> String {
    connection
        .into_iter()
        .flat_map(|connection| &connection.nodes)
        .filter_map(|node| node.last_edited_at.as_deref())
        .max()
        .unwrap_or_default()
        .to_string()
}

fn author_login(author: &Option<Login>) -> String {
    author
        .as_ref()
        .map_or_else(|| "ghost".to_string(), |author| author.login.clone())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Repo<T> {
    pull_request: Option<T>,
}

#[derive(Deserialize)]
struct Nodes<T> {
    nodes: Vec<T>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Page<T> {
    nodes: Vec<T>,
    page_info: PageInfo,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageInfo {
    has_next_page: bool,
    end_cursor: Option<String>,
}

impl PageInfo {
    fn next(&self) -> Option<String> {
        self.end_cursor.clone().filter(|_| self.has_next_page)
    }
}

#[derive(Deserialize)]
struct Login {
    login: String,
}

#[derive(Deserialize)]
struct FingerprintData {
    repository: Option<Repo<FingerprintPullRequest>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FingerprintPullRequest {
    state: String,
    mergeable: String,
    head_ref_oid: String,
    comments: Edited,
    reviews: Option<Edited>,
    review_threads: Count,
    commits: Nodes<FingerprintCommitNode>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Edited {
    total_count: u64,
    nodes: Vec<LastEdited>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LastEdited {
    last_edited_at: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Count {
    total_count: u64,
}

#[derive(Deserialize)]
struct FingerprintCommitNode {
    commit: FingerprintCommit,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FingerprintCommit {
    status_check_rollup: Option<CountsRollup>,
}

#[derive(Deserialize)]
struct CountsRollup {
    contexts: StateCounts,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StateCounts {
    check_run_counts_by_state: Option<Vec<StateCount>>,
    status_context_counts_by_state: Option<Vec<StateCount>>,
}

#[derive(Deserialize)]
struct StateCount {
    state: String,
    count: u64,
}

#[derive(Deserialize)]
struct CoreData {
    viewer: Login,
    repository: Option<Repo<CorePullRequest>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CorePullRequest {
    state: PullRequestState,
    mergeable: String,
    head_ref_oid: String,
    commits: Nodes<ContextsCommitNode>,
}

#[derive(Deserialize)]
struct CheckContextsData {
    repository: Option<Repo<CheckContextsPullRequest>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CheckContextsPullRequest {
    head_ref_oid: String,
    commits: Nodes<ContextsCommitNode>,
}

#[derive(Deserialize)]
struct ContextsCommitNode {
    commit: ContextsCommit,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContextsCommit {
    status_check_rollup: Option<ContextsRollup>,
}

#[derive(Deserialize)]
struct ContextsRollup {
    contexts: Page<Context>,
}

impl Nodes<ContextsCommitNode> {
    /// Adds the page's checks and returns the next page's cursor.
    fn read_contexts(&self, checks: &mut Vec<Check>) -> Option<String> {
        let page = &self
            .nodes
            .last()?
            .commit
            .status_check_rollup
            .as_ref()?
            .contexts;
        checks.extend(page.nodes.iter().map(Context::check));
        page.page_info.next()
    }
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
    /// Absent when not asked for.
    is_required: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StatusContextNode {
    context: String,
    state: String,
    target_url: Option<String>,
    is_required: Option<bool>,
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
                required: run.is_required.unwrap_or(false),
            },
            Self::StatusContext(status) => Check {
                name: status.context.clone(),
                outcome: match status.state.as_str() {
                    "SUCCESS" => CheckOutcome::Passed,
                    "ERROR" | "FAILURE" => CheckOutcome::Failed,
                    _ => CheckOutcome::Pending,
                },
                url: status.target_url.clone(),
                required: status.is_required.unwrap_or(false),
            },
        }
    }
}

#[derive(Deserialize)]
struct ActivityData {
    repository: Option<Repo<ActivityPullRequest>>,
}

/// Each connection is absent once it has no more pages to read.
#[derive(Deserialize)]
struct ActivityPullRequest {
    comments: Option<Page<CommentNode>>,
    reviews: Option<Page<ReviewNode>>,
}

#[derive(Deserialize)]
struct ThreadsData {
    repository: Option<Repo<ThreadsPullRequest>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadsPullRequest {
    review_threads: Page<ThreadNode>,
}

#[derive(Deserialize)]
struct ThreadNode {
    id: String,
    path: String,
    comments: Page<CommentNode>,
}

#[derive(Deserialize)]
struct ThreadCommentsData {
    node: Option<ThreadCommentsNode>,
}

#[derive(Deserialize)]
struct ThreadCommentsNode {
    comments: Page<CommentNode>,
}

/// A PR comment or a review thread comment.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommentNode {
    id: String,
    author: Option<Login>,
    body: String,
    created_at: String,
    last_edited_at: Option<String>,
    url: String,
}

impl CommentNode {
    fn remark(&self, path: Option<&str>) -> Remark {
        Remark {
            id: self.id.clone(),
            author: author_login(&self.author),
            path: path.map(str::to_owned),
            body: snippet(&self.body),
            at: self
                .last_edited_at
                .clone()
                .unwrap_or_else(|| self.created_at.clone()),
            url: self.url.clone(),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReviewNode {
    id: String,
    author: Option<Login>,
    state: String,
    body: String,
    /// `None` for a review that is still a draft.
    submitted_at: Option<String>,
    last_edited_at: Option<String>,
    url: String,
}

impl ReviewNode {
    /// The review's own verdict and summary. Its inline comments come with
    /// the review threads.
    fn remark(&self) -> Option<Remark> {
        let submitted_at = self.submitted_at.as_ref()?;
        let verdict = match self.state.as_str() {
            "APPROVED" => "Approved",
            "CHANGES_REQUESTED" => "Requested changes",
            _ => "",
        };
        let summary = snippet(&self.body);
        let body = match (verdict, summary.as_str()) {
            ("", "") => return None,
            ("", _) => summary.clone(),
            (verdict, "") => verdict.to_string(),
            (verdict, summary) => format!("{verdict}: {summary}"),
        };
        Some(Remark {
            id: self.id.clone(),
            author: author_login(&self.author),
            path: None,
            body,
            at: self
                .last_edited_at
                .clone()
                .unwrap_or_else(|| submitted_at.clone()),
            url: self.url.clone(),
        })
    }
}

#[cfg(test)]
mod tests;
