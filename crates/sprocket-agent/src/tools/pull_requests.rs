use std::collections::BTreeMap;

use convex::Value;
use rig::tool::ToolExecutionError;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sprocket_workspace::WorkspaceOperationCancelled;
use sprocket_workspace::github::pull_requests::{PullRequestRef, fetch_states};

use super::context::{AgentToolContext, tool_error};
use super::job::execute_tool_job;

#[derive(Clone)]
pub(crate) struct LinkPrsTool(pub(super) AgentToolContext);

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

    // GitHub matches repositories case-insensitively, so one spelling keeps
    // relinks from adding a duplicate.
    let refs: Vec<_> = pull_requests
        .into_iter()
        .map(|pr| PullRequestRef {
            repository: pr.repository.trim().to_ascii_lowercase(),
            number: pr.number,
        })
        .collect();
    let mut fetched = fetch_states(&context.user_id, &refs).await;
    if let Some((host, error)) = fetched.failures.into_iter().next() {
        anyhow::bail!("Reading pull requests from {host} failed: {error}");
    }
    if let Some(missing) = refs.iter().find(|pr| {
        !fetched
            .states
            .iter()
            .any(|status| status.repository == pr.repository && status.number == pr.number)
    }) {
        anyhow::bail!(
            "{}#{} was not found on GitHub. Repositories look like `github.com/owner/name`.",
            missing.repository,
            missing.number
        );
    }
    fetched.states.sort_by_key(|status| {
        refs.iter()
            .position(|pr| pr.repository == status.repository && pr.number == status.number)
    });

    let args = BTreeMap::from([
        ("runId".to_string(), Value::from(context.run_id.clone())),
        ("claimId".to_string(), Value::from(context.claim_id.clone())),
        (
            "pullRequests".to_string(),
            Value::try_from(serde_json::to_value(&fetched.states)?)?,
        ),
    ]);
    context
        .runtime
        .mutation_unit("pullRequests:link", args)
        .await?;
    Ok(json!("Linked."))
}
