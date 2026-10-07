use std::collections::BTreeMap;
use std::time::Duration;

use convex::Value;
use futures::{StreamExt, stream};
use serde::Deserialize;
use tokio::task::JoinHandle;
use uuid::Uuid;

use crate::AppState;
use crate::routes::agent::{RunAgentApiRequest, WorkspaceAccess, launch_agent};
use crate::transcript_client::UserConvexClient;

const RPC_TIMEOUT: Duration = Duration::from_secs(15);
const START_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Deserialize)]
struct ClaimedMessage {
    #[serde(rename = "_id")]
    id: String,
    #[serde(flatten)]
    request: QueueRunRequest,
}

// Convex documents also contain queue bookkeeping. Keep it outside the strict
// HTTP request decoder, and copy only executor inputs into the launch request.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct QueueRunRequest {
    user_id: String,
    submission_id: String,
    execution_secret: String,
    thread_id: String,
    prompt: String,
    storage_ids: Vec<String>,
    selected_model: String,
    completion_provider: sprocket_agent::CompletionProvider,
    reasoning_effort: String,
    fast_mode: bool,
    workspace_path: String,
}

impl From<QueueRunRequest> for RunAgentApiRequest {
    fn from(request: QueueRunRequest) -> Self {
        Self {
            user_id: request.user_id,
            submission_id: request.submission_id,
            execution_secret: Some(request.execution_secret),
            thread_id: Some(request.thread_id),
            repository_key: None,
            prompt: request.prompt,
            storage_ids: request.storage_ids,
            selected_model: request.selected_model,
            completion_provider: request.completion_provider,
            reasoning_effort: request.reasoning_effort,
            fast_mode: request.fast_mode,
            workspace_path: request.workspace_path,
            continuation_of_run_id: None,
        }
    }
}

pub(crate) fn spawn(state: AppState) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(5));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                _ = state.lifetime.shutdown.cancelled() => break,
                _ = interval.tick() => {},
            }
            if let Err(error) = drain(&state).await {
                tracing::debug!("queued messages remain pending: {error:#}");
            }
        }
    })
}

async fn drain(state: &AppState) -> anyhow::Result<()> {
    let Some(session) = state.native_auth.browser_session(false).await? else {
        return Ok(());
    };
    let client = state.convex_client_for(&session.user.id).await?;
    let candidates: Vec<String> = tokio::time::timeout(
        RPC_TIMEOUT,
        client.query(
            "messageQueue:candidates",
            BTreeMap::from([(
                "machineId".into(),
                state.machine_identity.installation_id.clone().into(),
            )]),
        ),
    )
    .await??;
    if candidates.is_empty() {
        return Ok(());
    }
    // Re-registration fences an old process and terminalizes runs abandoned
    // during a crash. Queue entries themselves are unaffected by presence loss.
    state.machines.register(&session.user.id).await?;
    stream::iter(candidates)
        .for_each_concurrent(4, |message_id| async {
            if let Err(error) = send(state, &client, message_id).await {
                tracing::warn!("queued message recovery remains pending: {error:#}");
            }
        })
        .await;
    Ok(())
}

async fn send(
    state: &AppState,
    client: &UserConvexClient,
    message_id: String,
) -> anyhow::Result<()> {
    let claim_id = Uuid::new_v4().to_string();
    let message: Option<ClaimedMessage> = tokio::time::timeout(
        RPC_TIMEOUT,
        client.mutate(
            "messageQueue:claim",
            BTreeMap::from([
                ("messageId".into(), message_id.into()),
                ("claimId".into(), claim_id.clone().into()),
                (
                    "machineId".into(),
                    state.machine_identity.installation_id.clone().into(),
                ),
                (
                    "credential".into(),
                    state.machine_identity.credential.clone().into(),
                ),
            ]),
        ),
    )
    .await??;
    let Some(message) = message else {
        return Ok(());
    };
    let user_id = message.request.user_id.clone();
    let result = tokio::time::timeout(
        START_TIMEOUT,
        launch_agent(
            state.clone(),
            message.request.into(),
            WorkspaceAccess::Attached,
            true,
            Default::default(),
            None,
        ),
    )
    .await;
    let mut args = BTreeMap::from([
        ("messageId".into(), message.id.into()),
        ("claimId".into(), claim_id.into()),
    ]);
    // A timeout leaves a detached launch running. Retain the durable lease;
    // treating it as a definitive failure could race that launch on Retry.
    if let Ok(Err(error)) = result {
        // Shutdown and sign-out pause the queue. Leave the lease intact so
        // the next process or authenticated session can resume this message.
        if state.lifetime.shutdown.is_cancelled()
            || state.native_auth.require_user(&user_id).await.is_err()
        {
            return Ok(());
        }
        args.insert("error".into(), error.to_string().into());
    }
    let _: serde_json::Value = tokio::time::timeout(
        RPC_TIMEOUT,
        client.mutate("messageQueue:finishAttempt", args),
    )
    .await??;
    Ok(())
}

pub(crate) fn enqueue_args(
    payload: RunAgentApiRequest,
    machine_id: String,
    credential: String,
) -> anyhow::Result<BTreeMap<String, Value>> {
    if payload.repository_key.is_some() || payload.continuation_of_run_id.is_some() {
        anyhow::bail!("A queued message requires an existing thread and cannot be a continuation.");
    }
    let thread_id = payload
        .thread_id
        .ok_or_else(|| anyhow::anyhow!("A queued message requires a thread."))?;
    let secret = payload
        .execution_secret
        .ok_or_else(|| anyhow::anyhow!("A queued message requires an execution secret."))?;
    Ok(BTreeMap::from([
        ("machineId".into(), machine_id.into()),
        ("credential".into(), credential.into()),
        ("threadId".into(), thread_id.into()),
        ("submissionId".into(), payload.submission_id.into()),
        ("executionSecret".into(), secret.into()),
        ("workspacePath".into(), payload.workspace_path.into()),
        ("prompt".into(), payload.prompt.into()),
        (
            "storageIds".into(),
            Value::Array(payload.storage_ids.into_iter().map(Value::String).collect()),
        ),
        ("selectedModel".into(), payload.selected_model.into()),
        (
            "completionProvider".into(),
            payload.completion_provider.as_str().to_string().into(),
        ),
        ("reasoningEffort".into(), payload.reasoning_effort.into()),
        ("fastMode".into(), Value::Boolean(payload.fast_mode)),
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_queue_bookkeeping_without_relaxing_the_http_decoder() {
        let message: ClaimedMessage = serde_json::from_value(serde_json::json!({
            "_id": "queue-a", "_creationTime": 1.0, "machineId": "machine-a",
            "claimId": "worker-a", "status": "sending", "attachmentNames": ["board.png"],
            "userId": "user-a", "submissionId": "submission-a", "executionSecret": "secret-a",
            "threadId": "thread-a", "prompt": "Build it", "storageIds": ["file-a"],
            "selectedModel": "model-a", "completionProvider": "openai",
            "reasoningEffort": "high", "fastMode": true, "workspacePath": "/project"
        }))
        .unwrap();
        let request: RunAgentApiRequest = message.request.into();
        assert_eq!(request.execution_secret.as_deref(), Some("secret-a"));
        assert_eq!(request.thread_id.as_deref(), Some("thread-a"));
        assert_eq!(request.storage_ids, vec!["file-a"]);
        assert_eq!(
            request.completion_provider,
            sprocket_agent::CompletionProvider::Openai
        );
        assert!(request.fast_mode);
        assert!(enqueue_args(request, "machine-a".into(), "credential-a".into()).is_ok());
    }
}
