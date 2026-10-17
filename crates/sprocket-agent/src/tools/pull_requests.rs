use std::collections::BTreeMap;

use anyhow::Context;
use convex::Value;
use rig::tool::ToolExecutionError;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sprocket_workspace::WorkspaceOperationCancelled;
use sprocket_workspace::github::pull_requests::{
    PullRequestRef, fetch_states, is_github_repository,
};
use sprocket_workspace::resolve_git_repository_identity;

use super::context::{AgentToolContext, tool_error};
use super::job::execute_tool_job;

const MAX_LINKED_PRS: usize = 20;

#[derive(Clone)]
pub(crate) struct LinkPrsTool(pub(super) AgentToolContext);

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct LinkPrsArgs {
    /// PR numbers in this thread's GitHub repository.
    pub(crate) numbers: Vec<u32>,
}

impl rig::tool::Tool for LinkPrsTool {
    const NAME: &'static str = "link_prs";
    type Error = ToolExecutionError;
    type Args = LinkPrsArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        "Link GitHub pull requests to this thread so the user sees them and their status in the sidebar. Link a PR right after you create it. The repository comes from the thread's project."
            .to_string()
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
                result = link(&self.0, args.numbers) => result.map_err(tool_error),
            }
        })
        .await
    }
}

async fn link(
    context: &AgentToolContext,
    mut numbers: Vec<u32>,
) -> anyhow::Result<serde_json::Value> {
    numbers.sort_unstable();
    numbers.dedup();
    anyhow::ensure!(!numbers.is_empty(), "Pass at least one PR number.");
    anyhow::ensure!(
        numbers.len() <= MAX_LINKED_PRS,
        "A thread can link at most {MAX_LINKED_PRS} PRs."
    );
    anyhow::ensure!(numbers[0] > 0, "PR numbers must be positive integers.");

    let repository_key = resolve_git_repository_identity(&context.workspace_root).repository_key;
    anyhow::ensure!(
        is_github_repository(&repository_key),
        "This thread's project ({repository_key}) does not have a GitHub origin remote."
    );
    let refs: Vec<_> = numbers
        .iter()
        .map(|&number| PullRequestRef {
            repository_key: repository_key.clone(),
            number,
        })
        .collect();
    let fetched = fetch_states(&refs).await;
    if let Some((host, error)) = fetched.failures.into_iter().next() {
        anyhow::bail!("Reading pull requests from {host} failed: {error}");
    }
    let mut pull_requests = Vec::with_capacity(numbers.len());
    for number in numbers {
        let status = fetched
            .states
            .iter()
            .find(|status| status.number == number)
            .with_context(|| {
                format!("Pull request #{number} was not found in {repository_key}.")
            })?;
        pull_requests.push(json!({
            "repositoryKey": repository_key,
            "number": number,
            "state": status.state,
        }));
    }

    let args = BTreeMap::from([
        ("runId".to_string(), Value::from(context.run_id.clone())),
        ("claimId".to_string(), Value::from(context.claim_id.clone())),
        (
            "pullRequests".to_string(),
            Value::try_from(serde_json::Value::Array(pull_requests))?,
        ),
    ]);
    let linked: serde_json::Value = context
        .runtime
        .mutation_json("pullRequests:link", args)
        .await?;
    Ok(json!({ "repository": repository_key, "pullRequests": linked }))
}
