use std::collections::BTreeMap;
use std::time::Duration;

use anyhow::Context;
use convex::Value;
use futures::StreamExt;
use serde::Deserialize;
use serde_json::json;
use sprocket_convex::decode_labeled_function_result;
use sprocket_workspace::{
    BUILTIN_SKILLS, browse_filesystem, default_user_skills_dirs, load_workspace_skills,
};
use tokio::time::{Instant, MissedTickBehavior, interval, sleep, timeout};

use crate::AppState;
use crate::project_attachments::{AttachProjectRequest, resolve_workspace_path};
use crate::routes::agent::{RunAgentApiRequest, launch_agent_run};
use crate::transcript_client::UserConvexClient;

const RPC_TIMEOUT: Duration = Duration::from_secs(15);
const LAUNCH_WINDOW: Duration = Duration::from_secs(45);
const RETRY_DELAY: Duration = Duration::from_secs(5);
const MAX_RESULT_BYTES: usize = 64 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingRequest {
    #[serde(rename = "_id")]
    id: String,
    user_id: String,
    command: MachineCommand,
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum MachineCommand {
    RunAgent {
        submission_id: String,
        thread_id: Option<String>,
        repository_key: Option<String>,
        prompt: String,
        image_upload_ids: Vec<String>,
        selected_model: String,
        reasoning_effort: String,
        service_tier: String,
        workspace_path: String,
        continuation_of_run_id: Option<String>,
    },
    ListProjects {},
    AttachProject {
        workspace_path: String,
        replace_workspace_path: Option<String>,
    },
    ResolveWorkspacePath {
        workspace_path: String,
        #[serde(default)]
        create_if_missing: bool,
    },
    BrowseFilesystem {
        partial_path: String,
        cwd: Option<String>,
    },
    ListWorkspaceSkills {
        workspace_path: String,
    },
}

pub(crate) async fn run(state: AppState) {
    let mut active_user: Option<String> = None;
    loop {
        let session = state.native_auth.browser_session(false).await;
        match session {
            Ok(session) => {
                let user_id = session.map(|session| session.user.id);
                if user_id != active_user {
                    if let Some(previous) = active_user.take() {
                        if let Err(error) = state.machines.end(&previous).await {
                            tracing::warn!("could not end previous machine account: {error:#}");
                        }
                    }
                    active_user = user_id;
                }
                if let Some(user_id) = &active_user {
                    if let Err(error) = serve_account(&state, user_id).await {
                        tracing::warn!("remote machine connection interrupted: {error:#}");
                    }
                }
            }
            Err(error) => {
                tracing::warn!("remote machine authentication unavailable: {error:#}")
            }
        }
        sleep(RETRY_DELAY).await;
    }
}

async fn serve_account(state: &AppState, user_id: &str) -> anyhow::Result<()> {
    state.machines.register(user_id).await?;
    let client = timeout(
        RPC_TIMEOUT,
        UserConvexClient::connect_with_fetcher(
            &state.convex_deployment_url,
            state
                .native_auth
                .auth_token_fetcher_for_user(user_id.to_string()),
        ),
    )
    .await??;
    let mut requests = timeout(
        RPC_TIMEOUT,
        client.subscribe("machineRequests:next", machine_args(state)),
    )
    .await??;
    let mut auth_check = interval(Duration::from_secs(3));
    auth_check.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut registration = interval(Duration::from_secs(30));
    registration.set_missed_tick_behavior(MissedTickBehavior::Skip);
    registration.tick().await;

    loop {
        tokio::select! {
            _ = auth_check.tick() => {
                state.native_auth.require_user(user_id).await?;
            }
            _ = registration.tick() => {
                state.machines.register(user_id).await?;
            }
            event = requests.next() => {
                let event = event.context("machine request subscription ended")?;
                let request: Option<PendingRequest> =
                    decode_labeled_function_result(event, "machineRequests:next")?;
                if let Some(request) = request {
                    process_request(state, &client, user_id, request).await?;
                }
            }
        }
    }
}

fn machine_args(state: &AppState) -> BTreeMap<String, Value> {
    BTreeMap::from([
        (
            "machineId".into(),
            state.machine_identity.installation_id.clone().into(),
        ),
        (
            "credential".into(),
            state.machine_identity.credential.clone().into(),
        ),
    ])
}

async fn process_request(
    state: &AppState,
    client: &UserConvexClient,
    user_id: &str,
    request: PendingRequest,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        request.user_id == user_id,
        "machine request account mismatch"
    );
    state.native_auth.require_user(user_id).await?;
    let launch_deadline = Instant::now() + LAUNCH_WINDOW;
    let mut args = machine_args(state);
    args.insert("id".into(), request.id.clone().into());
    // A lost claim acknowledgement must not result in speculative execution.
    let claimed: Option<PendingRequest> = timeout(
        RPC_TIMEOUT,
        client.mutate("machineRequests:claim", args.clone()),
    )
    .await??;
    let Some(claimed) = claimed else {
        return Ok(());
    };
    anyhow::ensure!(
        claimed.id == request.id && claimed.user_id == user_id,
        "machine claim identity mismatch"
    );
    // Filesystem calls cannot be cancelled. Wait for this command before accepting another
    // so a stalled mount cannot accumulate detached blocking tasks after cloud expiry.
    let result = execute(state, client, user_id, claimed.command, launch_deadline)
        .await
        .and_then(encode_result);
    match result {
        Ok(result) => {
            args.insert("result".into(), result.into());
        }
        Err(error) => {
            let error: String = format!("{error:#}").chars().take(2000).collect();
            args.insert("error".into(), error.into());
        }
    }
    // Only acknowledgement is retried. Re-running a claimed command could repeat side effects.
    let mut last_error = None;
    for _ in 0..3 {
        match timeout(
            RPC_TIMEOUT,
            client.mutate::<serde_json::Value>("machineRequests:complete", args.clone()),
        )
        .await
        {
            Ok(Ok(_)) => return Ok(()),
            Ok(Err(error)) => last_error = Some(error),
            Err(error) => last_error = Some(error.into()),
        }
        sleep(Duration::from_secs(1)).await;
    }
    Err(last_error.expect("completion attempted"))
}

fn encode_result(result: serde_json::Value) -> anyhow::Result<String> {
    let encoded = serde_json::to_string(&result)?;
    anyhow::ensure!(
        encoded.len() <= MAX_RESULT_BYTES,
        "Machine response is too large; choose a more specific folder."
    );
    Ok(encoded)
}

async fn execute(
    state: &AppState,
    client: &UserConvexClient,
    user_id: &str,
    command: MachineCommand,
    launch_deadline: Instant,
) -> anyhow::Result<serde_json::Value> {
    state.native_auth.require_user(user_id).await?;
    match command {
        MachineCommand::RunAgent {
            submission_id,
            thread_id,
            repository_key,
            prompt,
            image_upload_ids,
            selected_model,
            reasoning_effort,
            service_tier,
            workspace_path,
            continuation_of_run_id,
        } => {
            verify_run_workspace(
                state,
                client,
                &workspace_path,
                thread_id.as_deref(),
                repository_key.as_deref(),
            )
            .await?;
            let result = launch_agent_run(
                state.clone(),
                RunAgentApiRequest {
                    user_id: user_id.to_string(),
                    submission_id,
                    thread_id,
                    repository_key,
                    prompt,
                    image_upload_ids,
                    selected_model,
                    reasoning_effort,
                    service_tier,
                    workspace_path,
                    continuation_of_run_id,
                },
                Some(launch_deadline),
            )
            .await?;
            Ok(serde_json::to_value(result)?)
        }
        MachineCommand::ListProjects {} => Ok(serde_json::to_value(
            state.project_attachments.list().await?,
        )?),
        MachineCommand::AttachProject {
            workspace_path,
            replace_workspace_path,
        } => Ok(serde_json::to_value(
            state
                .project_attachments
                .attach(AttachProjectRequest {
                    workspace_path,
                    replace_workspace_path,
                })
                .await?,
        )?),
        command => tokio::task::spawn_blocking(move || execute_filesystem(command)).await?,
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadWorkspace {
    repository_key: Option<String>,
}

async fn verify_run_workspace(
    state: &AppState,
    client: &UserConvexClient,
    workspace_path: &str,
    thread_id: Option<&str>,
    repository_key: Option<&str>,
) -> anyhow::Result<()> {
    let expected = if let Some(thread_id) = thread_id {
        let thread: ThreadWorkspace = timeout(
            RPC_TIMEOUT,
            client.query(
                "threads:getByThreadId",
                BTreeMap::from([("threadId".into(), thread_id.to_string().into())]),
            ),
        )
        .await??;
        thread.repository_key
    } else {
        repository_key.map(str::to_string)
    };
    let workspace_path = state
        .project_attachments
        .workspace_path(workspace_path)
        .await?;
    let resolved =
        tokio::task::spawn_blocking(move || resolve_workspace_path(&workspace_path, false))
            .await??;
    require_matching_repository(expected.as_deref(), &resolved.repository_key)
}

fn require_matching_repository(expected: Option<&str>, actual: &str) -> anyhow::Result<()> {
    anyhow::ensure!(
        expected.is_some_and(|expected| !expected.is_empty() && expected == actual),
        "The selected folder does not match this thread's repository. Choose the matching workspace on this machine."
    );
    Ok(())
}

fn execute_filesystem(command: MachineCommand) -> anyhow::Result<serde_json::Value> {
    match command {
        MachineCommand::ResolveWorkspacePath {
            workspace_path,
            create_if_missing,
        } => Ok(serde_json::to_value(resolve_workspace_path(
            &workspace_path,
            create_if_missing,
        )?)?),
        MachineCommand::BrowseFilesystem { partial_path, cwd } => Ok(serde_json::to_value(
            browse_filesystem(&partial_path, cwd.as_deref())?,
        )?),
        MachineCommand::ListWorkspaceSkills { workspace_path } => {
            let resolution = resolve_workspace_path(&workspace_path, false)?;
            let loaded = load_workspace_skills(
                std::path::Path::new(&resolution.workspace_path),
                &default_user_skills_dirs(),
                BUILTIN_SKILLS,
            );
            let skills: Vec<_> = loaded
                .skills
                .into_iter()
                .map(|skill| json!({ "name": skill.name, "description": skill.description }))
                .collect();
            Ok(json!({ "skills": skills, "warnings": loaded.warnings }))
        }
        _ => anyhow::bail!("Not a filesystem command"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_commands_cannot_supply_cloud_credentials_or_user_identity() {
        for field in ["userId", "accessToken", "executionSecret"] {
            let mut value = json!({"kind": "listProjects"});
            value[field] = "injected".into();
            assert!(serde_json::from_value::<MachineCommand>(value).is_err());
        }
        assert!(
            serde_json::from_value::<MachineCommand>(json!({"kind": "shell", "command": "id"}))
                .is_err()
        );
    }

    #[test]
    fn response_limit_counts_utf8_bytes() {
        assert!(encode_result(json!("a".repeat(MAX_RESULT_BYTES - 2))).is_ok());
        assert!(encode_result(json!("é".repeat(MAX_RESULT_BYTES / 2))).is_err());
    }

    #[test]
    fn remote_run_rejects_missing_or_changed_workspace_identity() {
        assert!(require_matching_repository(Some("repo-a"), "repo-a").is_ok());
        assert!(require_matching_repository(Some("repo-a"), "repo-b").is_err());
        assert!(require_matching_repository(None, "repo-a").is_err());
        assert!(require_matching_repository(Some(""), "").is_err());
    }

    #[test]
    fn remote_run_uses_the_local_agent_request_contract() {
        let request: MachineCommand = serde_json::from_value(json!({
            "kind": "runAgent", "submissionId": "submission", "prompt": "hello",
            "imageUploadIds": [], "selectedModel": "model", "reasoningEffort": "high",
            "serviceTier": "standard", "workspacePath": "/work"
        }))
        .expect("remote command");
        assert!(matches!(
            request,
            MachineCommand::RunAgent {
                thread_id: None,
                ..
            }
        ));
    }
}
