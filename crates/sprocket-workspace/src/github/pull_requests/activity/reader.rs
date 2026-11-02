use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use super::{Activity, Check, CheckOutcome, Remark, snippet};
use crate::github::pull_requests::{PullRequestRef, PullRequestState, parse_repository};
use crate::github::{GitHubApi, GitHubError};

const QUERIES: &str = include_str!("queries.graphql");

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
    activity: Activity,
}

#[derive(PartialEq, Eq, Debug)]
struct Fingerprint {
    status: String,
    remarks: String,
    /// True when the fingerprint only sampled the first page of threads or checks.
    incomplete: bool,
}

impl Fingerprint {
    fn of(pr: FingerprintPullRequest) -> Self {
        let rollup = pr
            .commits
            .nodes
            .last()
            .and_then(|node| node.commit.status_check_rollup.as_ref());
        let reviews = pr.reviews.as_ref();
        let more_threads = pr
            .review_threads
            .page_info
            .as_ref()
            .is_some_and(|page| page.has_next_page);
        let more_checks = rollup.is_some_and(|rollup| {
            rollup
                .contexts
                .page_info
                .as_ref()
                .is_some_and(|page| page.has_next_page)
        });
        Self {
            status: [
                pr.state,
                pr.mergeable,
                pr.head_ref_oid,
                rollup
                    .map(|rollup| rollup.state.clone())
                    .unwrap_or_default(),
                state_counts(
                    rollup.and_then(|rollup| rollup.contexts.check_run_counts_by_state.as_deref()),
                ),
                state_counts(
                    rollup.and_then(|rollup| {
                        rollup.contexts.status_context_counts_by_state.as_deref()
                    }),
                ),
                check_outcomes(
                    rollup
                        .map(|rollup| rollup.contexts.nodes.as_slice())
                        .unwrap_or(&[]),
                ),
            ]
            .join(" "),
            remarks: [
                pr.comments.total_count.to_string(),
                newest_edit(Some(&pr.comments)),
                reviews.map_or(0, |reviews| reviews.total_count).to_string(),
                newest_edit(reviews),
                pr.review_threads.total_count.to_string(),
                thread_comment_signal(&pr.review_threads),
            ]
            .join(" "),
            incomplete: more_threads || more_checks,
        }
    }
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
        Ok(Self {
            variables: json!({
                "owner": repository.owner,
                "name": repository.name,
                "number": pull_request.number,
            }),
            label: format!("{}#{}", pull_request.repository, pull_request.number),
            api,
            last: None,
        })
    }

    pub async fn read(&mut self) -> Result<Activity, GitHubError> {
        let fingerprint = self.fingerprint().await?;
        if let Some(last) = &self.last
            && last.fingerprint == fingerprint
            && !fingerprint.incomplete
        {
            return Ok(last.activity.clone());
        }
        let (viewer, mut activity) = self.status().await?;
        activity.remarks = match self.last.take() {
            Some(last) if last.fingerprint.remarks == fingerprint.remarks => last.activity.remarks,
            _ => self.remarks(&viewer).await?,
        };
        self.last = Some(LastRead {
            fingerprint,
            activity: activity.clone(),
        });
        Ok(activity)
    }

    async fn query<T: DeserializeOwned>(
        &self,
        operation: &str,
        extra: Value,
    ) -> Result<T, GitHubError> {
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

    async fn fingerprint(&self) -> Result<Fingerprint, GitHubError> {
        let data: FingerprintData = self.query("PullRequestFingerprint", json!({})).await?;
        Ok(Fingerprint::of(self.pull_request(data.repository)?))
    }

    /// The viewer's login and everything but the remarks.
    async fn status(&self) -> Result<(String, Activity), GitHubError> {
        let data: StatusData = self.query("PullRequestStatus", json!({})).await?;
        let pr = self.pull_request(data.repository)?;
        let mut checks = Vec::new();
        let mut after = pr.commits.read_contexts(&mut checks);
        while let Some(cursor) = after.take() {
            let next: StatusData = self
                .query("PullRequestStatus", json!({ "after": cursor }))
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
    async fn remarks(&self, viewer: &str) -> Result<Vec<Remark>, GitHubError> {
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
                )
                .await?;
            let pr = self.pull_request(data.repository)?;
            comments_after = pr.comments.and_then(|page| {
                remarks.extend(page.nodes.iter().map(|comment| comment.remark(None)));
                page.page_info.next()
            });
            reviews_after = pr.reviews.and_then(|page| {
                remarks.extend(page.nodes.iter().filter_map(ReviewNode::remark));
                page.page_info.next()
            });
            with_comments = comments_after.is_some();
            with_reviews = reviews_after.is_some();
        }

        let mut threads_after = None;
        loop {
            let data: ThreadsData = self
                .query("ReviewThreads", json!({ "after": threads_after }))
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

fn check_outcomes(nodes: &[FingerprintContext]) -> String {
    let mut lines: Vec<String> = nodes
        .iter()
        .map(|node| match node {
            FingerprintContext::CheckRun(run) => format!(
                "{}:{}:{}",
                run.name,
                run.status,
                run.conclusion.as_deref().unwrap_or("")
            ),
            FingerprintContext::StatusContext(status) => {
                format!("{}:{}", status.context, status.state)
            }
        })
        .collect();
    lines.sort();
    lines.join(",")
}

fn thread_comment_signal(threads: &ThreadCounts) -> String {
    let comments: u64 = threads
        .nodes
        .iter()
        .map(|thread| thread.comments.total_count)
        .sum();
    let newest = threads
        .nodes
        .iter()
        .flat_map(|thread| &thread.comments.nodes)
        .flat_map(|comment| {
            [
                Some(comment.created_at.as_str()),
                comment.last_edited_at.as_deref(),
            ]
        })
        .flatten()
        .max()
        .unwrap_or_default();
    format!("{comments} {newest}")
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NextPage {
    #[serde(default)]
    has_next_page: bool,
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
    review_threads: ThreadCounts,
    commits: Nodes<FingerprintCommitNode>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadCounts {
    total_count: u64,
    #[serde(default)]
    nodes: Vec<ThreadFingerprint>,
    #[serde(default)]
    page_info: Option<NextPage>,
}

#[derive(Deserialize)]
struct ThreadFingerprint {
    comments: CountedComments,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CountedComments {
    total_count: u64,
    #[serde(default)]
    nodes: Vec<CommentStamp>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommentStamp {
    created_at: String,
    last_edited_at: Option<String>,
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
    #[serde(default)]
    state: String,
    contexts: StateCounts,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StateCounts {
    check_run_counts_by_state: Option<Vec<StateCount>>,
    status_context_counts_by_state: Option<Vec<StateCount>>,
    #[serde(default)]
    nodes: Vec<FingerprintContext>,
    #[serde(default)]
    page_info: Option<NextPage>,
}

#[derive(Deserialize)]
#[serde(tag = "__typename")]
enum FingerprintContext {
    CheckRun(FingerprintCheckRun),
    StatusContext(FingerprintStatusContext),
}

#[derive(Deserialize)]
struct FingerprintCheckRun {
    name: String,
    status: String,
    conclusion: Option<String>,
}

#[derive(Deserialize)]
struct FingerprintStatusContext {
    context: String,
    state: String,
}

#[derive(Deserialize)]
struct StateCount {
    state: String,
    count: u64,
}

#[derive(Deserialize)]
struct StatusData {
    viewer: Login,
    repository: Option<Repo<StatusPullRequest>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StatusPullRequest {
    state: PullRequestState,
    mergeable: String,
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
    is_required: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StatusContextNode {
    context: String,
    state: String,
    target_url: Option<String>,
    is_required: bool,
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
                required: run.is_required,
            },
            Self::StatusContext(status) => Check {
                name: status.context.clone(),
                outcome: match status.state.as_str() {
                    "SUCCESS" => CheckOutcome::Passed,
                    "ERROR" | "FAILURE" => CheckOutcome::Failed,
                    _ => CheckOutcome::Pending,
                },
                url: status.target_url.clone(),
                required: status.is_required,
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
