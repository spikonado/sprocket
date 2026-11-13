use std::time::Duration;

use anyhow::anyhow;
use serde_json::{Value, json};
use sprocket_workspace::{WorkspaceCancellation, read_artifact_file};
use tokio::time::timeout;

use super::context::AgentToolContext;
use super::job::mutation_args_from_payload;

const WIRING_CHECK_TIMEOUT: Duration = Duration::from_secs(15);

pub(super) async fn add_wiring_issues(
    context: &AgentToolContext,
    cancellation: &WorkspaceCancellation,
    path: &str,
    output: &mut Value,
) {
    if !path.ends_with(".wiring.json") {
        return;
    }
    let check = async {
        let file = read_artifact_file(&context.workspace_root, path).await?;
        let args = mutation_args_from_payload(
            &context.run_id,
            &context.claim_id,
            &json!({ "content": file.content }),
        )
        .map_err(|error| anyhow!(error.to_string()))?;
        context
            .runtime
            .query_json::<Value>("artifacts:checkWiringForRun", args)
            .await
    };
    let result = tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err(anyhow!("Wiring check was cancelled.")),
        result = timeout(WIRING_CHECK_TIMEOUT, check) => {
            result.unwrap_or_else(|_| Err(anyhow!("Wiring check timed out.")))
        }
    };
    match result {
        Ok(issues) => output["wiringIssues"] = issues,
        Err(error) => output["wiringCheckError"] = json!(format!("{error:#}")),
    }
}
