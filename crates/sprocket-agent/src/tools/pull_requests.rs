use std::collections::BTreeMap;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use convex::Value;
use rig::tool::ToolExecutionError;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sprocket_workspace::WorkspaceOperationCancelled;
use sprocket_workspace::github::pull_requests::activity::{
    Activity, CheckOutcome, Report, Seen, compare, fetch_activity,
};
use sprocket_workspace::github::pull_requests::{PullRequestRef, fetch_states};
use tokio::time::{Instant, sleep_until};

use super::async_tools::{YieldMode, default_yield_ms, is_default_yield_ms, yield_time_schema};
use super::context::{AgentToolContext, cancelled_error, tool_error};
use super::job::{execute_serialized_tool_job, execute_tool_job};

const POLL_PR_INTERVAL: Duration = Duration::from_secs(30);
const LISTED_COMMENTS: usize = 10;

#[derive(Clone)]
pub(crate) struct LinkPrsTool(pub(super) AgentToolContext);

#[derive(Clone)]
pub(crate) struct PollPrTool(pub(super) AgentToolContext);

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LinkPrsArgs {
    pub(crate) pull_requests: Vec<LinkedPr>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct LinkedPr {
    /// Repository the PR was opened against, as `github.com/owner/name`. For GitHub Enterprise, use its host instead of `github.com`.
    repository: String,
    number: u32,
}

impl rig::tool::Tool for LinkPrsTool {
    const NAME: &'static str = "link_prs";
    type Error = ToolExecutionError;
    type Args = LinkPrsArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        "Link pull requests you are working on to this thread".to_string()
    }

    fn parameters(&self) -> serde_json::Value {
        json!(schemars::schema_for!(LinkPrsArgs))
    }

    async fn call(
        &self,
        _context: &mut rig::tool::ToolContext,
        args: Self::Args,
    ) -> Result<Self::Output, Self::Error> {
        let payload = serde_json::to_value(&args).map_err(|e| tool_error(e.into()))?;
        execute_tool_job(&self.0, Self::NAME, payload, |cancellation| async move {
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => Err(tool_error(WorkspaceOperationCancelled.into())),
                result = link(&self.0, args.pull_requests) => result.map_err(tool_error),
            }
        })
        .await
    }
}

async fn link(
    context: &AgentToolContext,
    pull_requests: Vec<LinkedPr>,
) -> anyhow::Result<serde_json::Value> {
    anyhow::ensure!(!pull_requests.is_empty(), "Pass at least one PR.");

    let refs: Vec<_> = pull_requests
        .into_iter()
        .map(|pr| pull_request_ref(&pr.repository, pr.number))
        .collect();
    let fetched = fetch_states(&context.user_id, &refs).await;
    if let Some((host, error)) = fetched.failures.into_iter().next() {
        anyhow::bail!("Reading pull requests from {host} failed: {error}");
    }
    let states = refs
        .iter()
        .map(|pr| {
            fetched
                .states
                .iter()
                .find(|status| status.repository == pr.repository && status.number == pr.number)
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "{}#{} was not found on GitHub. Repositories look like `github.com/owner/name`.",
                        pr.repository,
                        pr.number
                    )
                })
        })
        .collect::<anyhow::Result<Vec<_>>>()?;

    let args = BTreeMap::from([
        ("runId".to_string(), Value::from(context.run_id.clone())),
        ("claimId".to_string(), Value::from(context.claim_id.clone())),
        (
            "pullRequests".to_string(),
            Value::try_from(serde_json::to_value(&states)?)?,
        ),
    ]);
    context
        .runtime
        .mutation_unit("pullRequests:link", args)
        .await?;
    Ok(json!("Linked."))
}

/// GitHub matches repositories case-insensitively, so one spelling keeps
/// relinks from adding a duplicate.
fn pull_request_ref(repository: &str, number: u32) -> PullRequestRef {
    PullRequestRef {
        repository: repository.trim().to_ascii_lowercase(),
        number,
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PollPrArgs {
    /// Repository the PR was opened against, as `github.com/owner/name`.
    repository: String,
    number: u32,
    /// The `cursor` from your last poll of this PR, so only later news counts. Omit it on your first poll.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cursor: Option<String>,
    #[serde(
        default = "default_yield_ms",
        skip_serializing_if = "is_default_yield_ms"
    )]
    #[schemars(default = "default_yield_ms")]
    yield_time_ms: u64,
}

fn poll_pr_parameters(max_yield_ms: u64) -> serde_json::Value {
    let mut schema = json!(schemars::schema_for!(PollPrArgs));
    schema["properties"]["yieldTimeMs"] = yield_time_schema(
        YieldMode::Poll,
        max_yield_ms,
        "Maximum time to wait for news before returning the tool call. Zero returns an immediate snapshot.",
    );
    schema
}

impl rig::tool::Tool for PollPrTool {
    const NAME: &'static str = "poll_pr";
    type Error = ToolExecutionError;
    type Args = PollPrArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        "Wait for news on a pull request: a check failed, all checks finished, someone else commented or reviewed, the branch conflicts, or the PR merged or closed. Keep working while CI runs and poll when you need the result. Comments from before your first poll are not news; read those yourself.".to_string()
    }

    fn parameters(&self) -> serde_json::Value {
        poll_pr_parameters(self.0.max_yield_ms)
    }

    async fn call(
        &self,
        _context: &mut rig::tool::ToolContext,
        args: Self::Args,
    ) -> Result<Self::Output, Self::Error> {
        let wait = Duration::from_millis(
            YieldMode::Poll.normalize(args.yield_time_ms, self.0.max_yield_ms),
        );
        let (user_id, poll_args) = (&self.0.user_id, &args);
        execute_serialized_tool_job(&self.0, Self::NAME, &args, |cancellation| async move {
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => Err(cancelled_error()),
                result = poll_pr(user_id, poll_args, wait) => result.map_err(tool_error),
            }
        })
        .await
    }
}

async fn poll_pr(
    user_id: &str,
    args: &PollPrArgs,
    wait: Duration,
) -> anyhow::Result<serde_json::Value> {
    let pull_request = pull_request_ref(&args.repository, args.number);
    let mut seen = args.cursor.as_deref().map(decode_cursor).transpose()?;
    let deadline = Instant::now() + wait;
    loop {
        let activity = fetch_activity(user_id, &pull_request).await?;
        let report = compare(
            seen.get_or_insert_with(|| Seen::first_look(&activity)),
            &activity,
        );
        let now = Instant::now();
        if !report.changes.is_empty() || now >= deadline {
            return poll_pr_output(&activity, &report);
        }
        sleep_until(deadline.min(now + POLL_PR_INTERVAL)).await;
    }
}

fn poll_pr_output(activity: &Activity, report: &Report) -> anyhow::Result<serde_json::Value> {
    let checks = |outcome: CheckOutcome| {
        activity
            .checks
            .iter()
            .filter(move |check| check.outcome == outcome)
    };
    let mut output = json!({
        "changes": report.changes,
        "cursor": URL_SAFE_NO_PAD.encode(serde_json::to_vec(&report.next)?),
        "state": activity.state,
        "headSha": activity.head_sha,
        "conflicting": activity.conflicting,
        "checks": {
            "passed": checks(CheckOutcome::Passed).count(),
            "pending": checks(CheckOutcome::Pending).map(|check| &check.name).collect::<Vec<_>>(),
            "failed": checks(CheckOutcome::Failed).collect::<Vec<_>>(),
        },
    });
    if !report.new_remarks.is_empty() {
        output["newComments"] = json!(
            report
                .new_remarks
                .iter()
                .take(LISTED_COMMENTS)
                .collect::<Vec<_>>()
        );
    }
    if report.new_remarks.len() > LISTED_COMMENTS {
        output["moreNewComments"] = json!(report.new_remarks.len() - LISTED_COMMENTS);
    }
    Ok(output)
}

fn decode_cursor(cursor: &str) -> anyhow::Result<Seen> {
    URL_SAFE_NO_PAD
        .decode(cursor)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .ok_or_else(|| anyhow::anyhow!("That cursor is not from poll_pr. Omit it to start over."))
}
