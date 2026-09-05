use std::collections::BTreeMap;

use convex::Value;
use futures::StreamExt;
use rig::tool::{ToolErrorKind, ToolExecutionError};
use serde::Deserialize;
use sprocket_workspace::WorkspaceCancellation;

use super::context::{cancelled_error, tool_error, tool_failure};
use crate::convex::RuntimeClient;
use crate::hooks::ToolCallTracker;

pub(super) const GET_JOB_FUNCTION: &str = "executor:getJob";

/// Runs a tool's work as a Convex action, aborting the wait when the run is
/// cancelled. The action itself keeps running server-side; its job record is
/// reconciled by the normal completion flow.
pub(super) async fn run_convex_tool_action(
    runtime: &RuntimeClient,
    cancellation: WorkspaceCancellation,
    function: &str,
    args: BTreeMap<String, Value>,
) -> Result<serde_json::Value, ToolExecutionError> {
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err(cancelled_error()),
        result = runtime.action_json::<serde_json::Value>(function, args) => {
            result.map_err(tool_error)
        }
    }
}

/// Runs a tool's work as a Convex mutation. Cancellation only aborts the wait;
/// the mutation still commits server-side if it already started.
pub(super) async fn run_convex_tool_mutation(
    runtime: &RuntimeClient,
    cancellation: WorkspaceCancellation,
    function: &str,
    args: BTreeMap<String, Value>,
) -> Result<serde_json::Value, ToolExecutionError> {
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err(cancelled_error()),
        result = runtime.mutation_json::<serde_json::Value>(function, args) => {
            result.map_err(tool_error)
        }
    }
}

/// Merge run claim fields with a serialized tool-args object for a Convex mutation.
pub(super) fn mutation_args_from_payload(
    run_id: &str,
    claim_id: &str,
    payload: &serde_json::Value,
) -> Result<BTreeMap<String, Value>, ToolExecutionError> {
    tool_args_from_payload(
        run_id,
        claim_id,
        payload,
        "artifact tool payload must be an object",
    )
}

pub(super) fn action_args_from_payload(
    run_id: &str,
    claim_id: &str,
    payload: &serde_json::Value,
) -> Result<BTreeMap<String, Value>, ToolExecutionError> {
    tool_args_from_payload(run_id, claim_id, payload, "tool payload must be an object")
}

fn tool_args_from_payload(
    run_id: &str,
    claim_id: &str,
    payload: &serde_json::Value,
    non_object_message: &str,
) -> Result<BTreeMap<String, Value>, ToolExecutionError> {
    let mut args = BTreeMap::new();
    args.insert("runId".to_string(), run_id.to_string().into());
    args.insert("claimId".to_string(), claim_id.to_string().into());
    let fields = payload
        .as_object()
        .ok_or_else(|| tool_failure(non_object_message))?;
    for (key, value) in fields {
        args.insert(
            key.clone(),
            Value::try_from(value.clone()).map_err(tool_error)?,
        );
    }
    Ok(args)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ExecutorJobSnapshot {
    status: String,
    result: Option<serde_json::Value>,
    error: Option<String>,
}

pub(super) async fn begin_executor_job(
    runtime: &RuntimeClient,
    run_id: &str,
    claim_id: &str,
    kind: &str,
    tool_call_tracker: &ToolCallTracker,
    payload: &serde_json::Value,
) -> Result<String, ToolExecutionError> {
    let mut begin_args = BTreeMap::new();
    begin_args.insert("runId".to_string(), run_id.to_string().into());
    begin_args.insert("claimId".to_string(), claim_id.to_string().into());
    begin_args.insert("kind".to_string(), kind.to_string().into());
    if let Some(call_id) = tool_call_tracker.claim(kind, payload) {
        begin_args.insert("callId".to_string(), call_id.into());
    }
    begin_args.insert(
        "payload".to_string(),
        Value::try_from(payload.clone()).map_err(tool_error)?,
    );
    let begin_result: serde_json::Value = runtime
        .mutation_json("agentRuntime:beginToolJob", begin_args)
        .await
        .map_err(tool_error)?;
    begin_result
        .get("jobId")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| tool_failure("beginToolJob did not return a jobId"))
        .map(str::to_string)
}

pub(super) async fn execute_cloud_tool_job(
    runtime: &RuntimeClient,
    run_id: &str,
    claim_id: &str,
    kind: &str,
    tool_call_tracker: &ToolCallTracker,
    payload: serde_json::Value,
) -> Result<serde_json::Value, ToolExecutionError> {
    eprintln!(
        "sprocket-agent: starting cloud tool {} for run {}",
        kind, run_id
    );
    let mut run_updates = runtime
        .run_finished_subscription(run_id)
        .await
        .map_err(tool_error)?;
    let initial_update = run_updates
        .next()
        .await
        .ok_or_else(|| tool_failure("run status subscription closed"))?;
    if RuntimeClient::decode_run_finished_update(initial_update).map_err(tool_error)? {
        return Err(cancelled_error());
    }

    let job_id =
        begin_executor_job(runtime, run_id, claim_id, kind, tool_call_tracker, &payload).await?;
    let mut job_args = BTreeMap::new();
    job_args.insert("runId".to_string(), run_id.to_string().into());
    job_args.insert("jobId".to_string(), job_id.clone().into());
    let mut job_updates = runtime
        .subscribe(GET_JOB_FUNCTION, job_args)
        .await
        .map_err(tool_error)?;

    loop {
        tokio::select! {
            biased;
            update = run_updates.next() => {
                let Some(update) = update else {
                    return Err(tool_failure("run status subscription closed"));
                };
                match RuntimeClient::decode_run_finished_update(update) {
                    Ok(false) => {}
                    Ok(true) => {
                        eprintln!("sprocket-agent: cancelled cloud tool {} for run {}", kind, run_id);
                        return Err(cancelled_error());
                    }
                    Err(error) => {
                        return Err(tool_error(anyhow::anyhow!("run status subscription failed: {error}")));
                    }
                }
            }
            update = job_updates.next() => {
                let Some(update) = update else {
                    return Err(tool_failure("executor job subscription closed"));
                };
                let snapshot: Option<ExecutorJobSnapshot> =
                    RuntimeClient::decode_subscription_update(update, GET_JOB_FUNCTION)
                        .map_err(tool_error)?;
                let Some(snapshot) = snapshot else {
                    return Err(tool_failure("executor job not found"));
                };
                match snapshot.status.as_str() {
                    "completed" => {
                        eprintln!("sprocket-agent: completed cloud tool {} for run {}", kind, run_id);
                        return snapshot.result.ok_or_else(|| {
                            tool_failure("completed executor job did not include a result")
                        });
                    }
                    "failed" => {
                        return Err(tool_failure(
                            snapshot.error.unwrap_or_else(|| "Executor job failed.".to_string()),
                        ));
                    }
                    "cancelled" => return Err(cancelled_error()),
                    _ => {}
                }
            }
        }
    }
}

pub(super) async fn execute_tool_job<F, Fut>(
    runtime: &RuntimeClient,
    run_id: &str,
    claim_id: &str,
    kind: &str,
    tool_call_tracker: &ToolCallTracker,
    payload: serde_json::Value,
    operation: F,
) -> Result<serde_json::Value, ToolExecutionError>
where
    F: FnOnce(WorkspaceCancellation) -> Fut,
    Fut: std::future::Future<Output = Result<serde_json::Value, ToolExecutionError>>,
{
    eprintln!("sprocket-agent: starting tool {} for run {}", kind, run_id);
    let mut run_updates = runtime
        .run_finished_subscription(run_id)
        .await
        .map_err(tool_error)?;
    let initial_update = run_updates
        .next()
        .await
        .ok_or_else(|| tool_failure("run status subscription closed"))?;
    let initial_run_finished =
        RuntimeClient::decode_run_finished_update(initial_update).map_err(tool_error)?;
    if initial_run_finished {
        return Err(cancelled_error());
    }

    let job_id =
        begin_executor_job(runtime, run_id, claim_id, kind, tool_call_tracker, &payload).await?;

    let cancellation = WorkspaceCancellation::new();
    let operation = operation(cancellation.clone());
    tokio::pin!(operation);
    let operation_result = loop {
        tokio::select! {
            biased;
            update = run_updates.next() => {
                let Some(update) = update else {
                    cancellation.cancel();
                    let _ = operation.await;
                    break Err(tool_failure("run status subscription closed"));
                };
                match RuntimeClient::decode_run_finished_update(update) {
                    Ok(false) => {}
                    Ok(true) => {
                        cancellation.cancel();
                        let _ = operation.await;
                        eprintln!("sprocket-agent: cancelled tool {} for run {}", kind, run_id);
                        return Err(cancelled_error());
                    }
                    Err(error) => {
                        cancellation.cancel();
                        let _ = operation.await;
                        break Err(tool_error(anyhow::anyhow!("run status subscription failed: {error}")));
                    }
                }
            },
            result = &mut operation => break result,
        }
    };

    match operation_result {
        Ok(output) => {
            eprintln!("sprocket-agent: completed tool {} for run {}", kind, run_id);
            let mut complete_args = BTreeMap::new();
            complete_args.insert("jobId".to_string(), job_id.into());
            complete_args.insert("runId".to_string(), run_id.to_string().into());
            complete_args.insert("claimId".to_string(), claim_id.to_string().into());
            complete_args.insert(
                "result".to_string(),
                Value::try_from(output.clone()).map_err(tool_error)?,
            );
            let accepted: bool = runtime
                .mutation_json("executor:complete", complete_args)
                .await
                .map_err(tool_error)?;
            if accepted {
                Ok(output)
            } else {
                Err(cancelled_error())
            }
        }
        Err(error) => {
            eprintln!(
                "sprocket-agent: failed tool {} for run {}: {}",
                kind, run_id, error
            );
            // Terminal runs already cancel claimed jobs via
            // cancelExecutorJobsForTerminalRun and Workpool cancel in
            // finalizeRunRecord.
            if error.kind() == ToolErrorKind::Cancelled {
                return Err(error);
            }
            let mut fail_args = BTreeMap::new();
            fail_args.insert("jobId".to_string(), job_id.into());
            fail_args.insert("runId".to_string(), run_id.to_string().into());
            fail_args.insert("claimId".to_string(), claim_id.to_string().into());
            fail_args.insert("error".to_string(), error.to_string().into());
            let accepted: bool = runtime
                .mutation_json("executor:fail", fail_args)
                .await
                .map_err(tool_error)?;
            if accepted {
                Err(error)
            } else {
                Err(cancelled_error())
            }
        }
    }
}
