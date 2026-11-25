use std::collections::BTreeMap;

use convex::Value;
use futures::StreamExt;
use rig::tool::{ToolErrorKind, ToolExecutionError};
use serde::{Deserialize, Serialize};
use sprocket_workspace::WorkspaceCancellation;

use super::context::{AgentToolContext, cancelled_error, tool_error, tool_failure};
use crate::convex::{PartsMutationResponse, PersistedTranscriptPart, RuntimeClient};
use crate::hooks::ToolInvocationAssignment;
use crate::secret_redaction::{redact_json, redact_secrets};

pub(super) const GET_JOB_FUNCTION: &str = "executor:getJob";

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

pub(super) fn mutation_args_from_payload(
    run_id: &str,
    claim_id: &str,
    payload: &serde_json::Value,
) -> Result<BTreeMap<String, Value>, ToolExecutionError> {
    let mut args = BTreeMap::new();
    args.insert("runId".to_string(), run_id.to_string().into());
    args.insert("claimId".to_string(), claim_id.to_string().into());
    let fields = payload
        .as_object()
        .ok_or_else(|| tool_failure("tool payload must be an object"))?;
    for (key, value) in fields {
        args.insert(
            key.clone(),
            Value::try_from(value.clone()).map_err(tool_error)?,
        );
    }
    Ok(args)
}

pub(super) fn action_args_from_payload(
    run_id: &str,
    claim_id: &str,
    payload: &serde_json::Value,
) -> Result<BTreeMap<String, Value>, ToolExecutionError> {
    mutation_args_from_payload(run_id, claim_id, payload)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ExecutorJobSnapshot {
    status: String,
    result: Option<serde_json::Value>,
    error: Option<String>,
    part: Option<PersistedTranscriptPart>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BeginJobResponse {
    job_id: String,
    parts: Vec<PersistedTranscriptPart>,
}

pub(super) async fn begin_executor_job(
    context: &AgentToolContext,
    kind: &str,
    assignment: ToolInvocationAssignment,
    mut payload: serde_json::Value,
) -> Result<String, ToolExecutionError> {
    let mut begin_args = BTreeMap::new();
    begin_args.insert("runId".to_string(), context.run_id.clone().into());
    begin_args.insert("claimId".to_string(), context.claim_id.clone().into());
    begin_args.insert("kind".to_string(), kind.to_string().into());
    begin_args.insert("callId".to_string(), assignment.call_id.into());
    begin_args.insert(
        "toolInvocationId".to_string(),
        assignment.tool_invocation_id.into(),
    );
    begin_args.insert(
        "attemptSeq".to_string(),
        Value::Float64(assignment.attempt_seq as f64),
    );
    begin_args.insert("streamId".to_string(), assignment.stream_id.into());
    if matches!(kind, "bind_artifact" | "save_artifact")
        && let Some(fields) = payload.as_object_mut()
    {
        fields.remove("path");
    }
    begin_args.insert(
        "payload".to_string(),
        Value::try_from(payload).map_err(tool_error)?,
    );
    let BeginJobResponse { job_id, parts } = context
        .runtime
        .mutation_json("agentRuntime:beginToolJob", begin_args)
        .await
        .map_err(tool_error)?;
    context.runtime.record_parts(parts).await;
    Ok(job_id)
}

pub(super) async fn execute_cloud_tool_job(
    context: &AgentToolContext,
    kind: &str,
    payload: serde_json::Value,
) -> Result<serde_json::Value, ToolExecutionError> {
    let assignment = context
        .tool_call_tracker
        .claim_dispatch(kind, &payload)
        .ok_or_else(|| tool_failure("tool dispatch is missing its invocation assignment"))?;
    tracing::info!("starting cloud tool {} for run {}", kind, context.run_id);
    let mut run_updates = context
        .runtime
        .run_finished_subscription(&context.run_id)
        .await
        .map_err(tool_error)?;
    let initial_update = run_updates
        .next()
        .await
        .ok_or_else(|| tool_failure("run status subscription closed"))?;
    if RuntimeClient::decode_run_finished_update(initial_update).map_err(tool_error)? {
        return Err(cancelled_error());
    }

    // Convex runs cloud jobs from the stored payload, so it gets the real values.
    let job_id = begin_executor_job(context, kind, assignment, payload).await?;
    let mut job_args = BTreeMap::new();
    job_args.insert("runId".to_string(), context.run_id.clone().into());
    job_args.insert("jobId".to_string(), job_id.clone().into());
    let mut job_updates = context
        .runtime
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
                        tracing::info!("cancelled cloud tool {} for run {}", kind, context.run_id);
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
                context.runtime.record_parts(snapshot.part).await;
                match snapshot.status.as_str() {
                    "completed" => {
                        tracing::info!("completed cloud tool {} for run {}", kind, context.run_id);
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

pub(super) async fn execute_serialized_tool_job<A, O, F, Fut>(
    context: &AgentToolContext,
    kind: &str,
    args: &A,
    operation: F,
) -> Result<serde_json::Value, ToolExecutionError>
where
    A: Serialize,
    O: Serialize,
    F: FnOnce(WorkspaceCancellation) -> Fut,
    Fut: std::future::Future<Output = Result<O, ToolExecutionError>>,
{
    let payload = serde_json::to_value(args).map_err(|error| tool_error(error.into()))?;
    execute_tool_job(context, kind, payload, |cancellation| async move {
        let output = operation(cancellation).await?;
        serde_json::to_value(output).map_err(|error| tool_error(error.into()))
    })
    .await
}

pub(super) async fn execute_tool_job<F, Fut>(
    context: &AgentToolContext,
    kind: &str,
    payload: serde_json::Value,
    operation: F,
) -> Result<serde_json::Value, ToolExecutionError>
where
    F: FnOnce(WorkspaceCancellation) -> Fut,
    Fut: std::future::Future<Output = Result<serde_json::Value, ToolExecutionError>>,
{
    let assignment = context
        .tool_call_tracker
        .claim_dispatch(kind, &payload)
        .ok_or_else(|| tool_failure("tool dispatch is missing its invocation assignment"))?;
    execute_tool_job_with_assignment(
        context,
        assignment,
        kind,
        payload,
        |cancellation, _job_id| operation(cancellation),
    )
    .await
}

pub(super) async fn execute_tool_job_with_id<F, Fut>(
    context: &AgentToolContext,
    kind: &str,
    payload: serde_json::Value,
    operation: F,
) -> Result<serde_json::Value, ToolExecutionError>
where
    F: FnOnce(WorkspaceCancellation, String) -> Fut,
    Fut: std::future::Future<Output = Result<serde_json::Value, ToolExecutionError>>,
{
    let assignment = context
        .tool_call_tracker
        .claim_dispatch(kind, &payload)
        .ok_or_else(|| tool_failure("tool dispatch is missing its invocation assignment"))?;
    execute_tool_job_with_assignment(context, assignment, kind, payload, operation).await
}

async fn execute_tool_job_with_assignment<F, Fut>(
    context: &AgentToolContext,
    assignment: ToolInvocationAssignment,
    kind: &str,
    mut payload: serde_json::Value,
    operation: F,
) -> Result<serde_json::Value, ToolExecutionError>
where
    F: FnOnce(WorkspaceCancellation, String) -> Fut,
    Fut: std::future::Future<Output = Result<serde_json::Value, ToolExecutionError>>,
{
    tracing::info!("starting tool {} for run {}", kind, context.run_id);
    let mut run_updates = context
        .runtime
        .run_finished_subscription(&context.run_id)
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

    // Convex's hosted scraper fetches the URL stored in the job, as cloud jobs do.
    if kind != "scrape_url" {
        redact_json(&mut payload);
    }
    let job_id = begin_executor_job(context, kind, assignment, payload).await?;

    let cancellation = WorkspaceCancellation::new();
    let operation = operation(cancellation.clone(), job_id.clone());
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
                        break Err(cancelled_error());
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

    finish_job(context, kind, job_id, operation_result).await
}

async fn finish_job(
    context: &AgentToolContext,
    kind: &str,
    job_id: String,
    outcome: Result<serde_json::Value, ToolExecutionError>,
) -> Result<serde_json::Value, ToolExecutionError> {
    let outcome = outcome.and_then(|output| {
        let mut stored = output.clone();
        redact_json(&mut stored);
        let result = Value::try_from(stored).map_err(tool_error)?;
        Ok((output, result))
    });
    let mut args = BTreeMap::new();
    args.insert("jobId".to_string(), job_id.into());
    args.insert("runId".to_string(), context.run_id.clone().into());
    args.insert("claimId".to_string(), context.claim_id.clone().into());
    args.insert("returnParts".to_string(), true.into());
    let (function, outcome) = match outcome {
        Ok((output, result)) => {
            tracing::info!("completed tool {} for run {}", kind, context.run_id);
            args.insert("result".to_string(), result);
            ("executor:complete", Ok(output))
        }
        Err(error) if error.kind() == ToolErrorKind::Cancelled => {
            tracing::info!("cancelled tool {} for run {}", kind, context.run_id);
            return Err(error);
        }
        Err(error) => {
            tracing::info!("failed tool {} for run {}: {}", kind, context.run_id, error);
            args.insert(
                "error".to_string(),
                redact_secrets(&error.to_string()).into(),
            );
            ("executor:fail", Err(error))
        }
    };
    let PartsMutationResponse { accepted, parts } = context
        .runtime
        .idempotent_mutation(function, args)
        .await
        .map_err(tool_error)?;
    context.runtime.record_parts(parts).await;
    if accepted {
        outcome
    } else {
        Err(cancelled_error())
    }
}

#[cfg(test)]
mod tests;
