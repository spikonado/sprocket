use std::collections::BTreeMap;
use std::time::Duration;

use anyhow::Context;
use convex::Value;
use futures::StreamExt;
use rig::tool::ToolExecutionError;
use serde::Deserialize;
use sprocket_workspace::WorkspaceCancellation;

use super::context::{cancelled_error, tool_error, tool_failure};
use crate::convex::RuntimeClient;

#[derive(Deserialize)]
#[serde(tag = "status", rename_all = "lowercase")]
enum ResultStatus {
    Pending,
    Completed { url: String },
    Failed { error: String },
}

pub(super) async fn run(
    runtime: &RuntimeClient,
    cancellation: WorkspaceCancellation,
    mut args: BTreeMap<String, Value>,
    kind: &str,
) -> Result<serde_json::Value, ToolExecutionError> {
    if cancellation.is_cancelled() {
        return Err(cancelled_error());
    }
    let run_id = args
        .get("runId")
        .cloned()
        .context("missing run ID")
        .map_err(tool_error)?;
    args.insert("kind".into(), kind.into());
    // A lost acknowledgement can still mean the mutation committed. Never resubmit it.
    let id: String = tokio::select! {
        biased;
        _ = cancellation.cancelled() => return Err(cancelled_error()),
        result = tokio::time::timeout(Duration::from_secs(30), runtime.mutation_json("webRequests:start", args)) => {
            result.map_err(|_| tool_failure("Web request submission timed out. Its outcome is unknown; check before repeating the request."))?.map_err(tool_error)?
        }
    };
    let result_args = BTreeMap::from([("id".into(), id.into()), ("runId".into(), run_id)]);
    let result = tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err(cancelled_error()),
        result = tokio::time::timeout(Duration::from_secs(510), wait(runtime, result_args.clone())) => {
            result.unwrap_or_else(|_| Err(tool_failure("Web request timed out. Check the outcome before repeating the request.")))
        }
    };
    let _ = tokio::time::timeout(
        Duration::from_secs(5),
        runtime.mutation_json::<serde_json::Value>("webRequests:dispose", result_args),
    )
    .await;
    result
}

async fn wait(
    runtime: &RuntimeClient,
    args: BTreeMap<String, Value>,
) -> Result<serde_json::Value, ToolExecutionError> {
    let mut updates = runtime
        .subscribe("webRequests:getResult", args)
        .await
        .map_err(tool_error)?;
    while let Some(update) = updates.next().await {
        let result: ResultStatus =
            RuntimeClient::decode_subscription_update(update, "webRequests:getResult")
                .map_err(tool_error)?;
        match result {
            ResultStatus::Pending => {}
            ResultStatus::Failed { error } => return Err(tool_failure(error)),
            ResultStatus::Completed { url } => return download(&url).await.map_err(tool_error),
        }
    }
    Err(tool_failure(
        "Web request subscription closed. Check the outcome before repeating the request.",
    ))
}

async fn download(url: &str) -> anyhow::Result<serde_json::Value> {
    const MAX_BYTES: usize = 2_000_000;
    let mut response = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(30))
        .build()?
        .get(url)
        .send()
        .await
        .map_err(reqwest::Error::without_url)?
        .error_for_status()
        .map_err(reqwest::Error::without_url)?;
    anyhow::ensure!(
        response
            .content_length()
            .is_none_or(|size| size <= MAX_BYTES as u64),
        "web request result exceeds its size limit"
    );
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(reqwest::Error::without_url)?
    {
        anyhow::ensure!(
            chunk.len() <= MAX_BYTES.saturating_sub(bytes.len()),
            "web request result exceeds its size limit"
        );
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).context("web request result was not valid JSON")
}

#[cfg(test)]
mod tests;
