use anyhow::{Context, anyhow};
use futures::StreamExt;
use rig::completion::Message;
use rig::message::UserContent;
use sprocket_workspace::{
    BUILTIN_SKILLS, WorkspaceInstruction, WorkspaceInstructionSource, WorkspaceSkill,
    default_user_skills_dirs, load_workspace_instructions, load_workspace_skills,
    resolve_directory, resolve_workspace_root, simplified_path,
};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::time::{Instant, sleep, sleep_until, timeout};
use uuid::Uuid;

use crate::catalog::catalog_models_for_run;
use crate::convex::{FailedStartCleanup, RuntimeClient};
use crate::history::{
    agent_history_from_parts, current_run_has_finished_turns, pending_prompt_part,
};
use crate::provider::{AgentProvider, AgentProviderRequest, AgentProviderResult};
use crate::submission::{SUBMISSION_ATTEMPT_TIMEOUT, submission_is_waiting, wait_until_ready};
use crate::types::{
    CompletionProvider, RunAgentRequest, RunContextResponse, deserialize_agent_history,
};
use sprocket_transcript::{
    DownloadOrder, LiveCompletionHub, TranscriptPart, TranscriptState, TranscriptStore,
    apply_remote_state, cache_prompt_attachments, parse_remote_parts,
};

// Keep RUN_CLAIM_LEASE_DURATION synchronized with
// apps/web/convex/lib/runLease.ts (RUN_CLAIM_LEASE_DURATION_MS).
const RUN_CLAIM_LEASE_DURATION: Duration = Duration::from_secs(120);
const RUN_CLAIM_RENEW_INTERVAL: Duration = Duration::from_secs(40);
const RUN_CLAIM_RENEW_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(8);
const RUN_CLAIM_EXPIRY_SAFETY_MARGIN: Duration = Duration::from_secs(5);
const RUN_CLAIM_RENEW_RETRY_DELAY: Duration = Duration::from_millis(250);
const RUN_CLAIM_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(8);
const FAILURE_CLEANUP_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(5);
const START_FAILURE_CLEANUP_ATTEMPT_TIMEOUT: Duration = Duration::from_millis(2_500);
const START_FAILURE_RECONCILE_TIMEOUT: Duration = Duration::from_secs(10);
const FAILURE_CLEANUP_RETRY_DELAY: Duration = Duration::from_millis(250);

/// Must match the createGatewayRun conflict ConvexErrors in
/// apps/web/convex/agentRuntime.ts ("Submission belongs to a different ...").
const SUBMISSION_OWNED_BY_ANOTHER_EXECUTOR: &str = "Submission belongs to a different";
const CONTINUE_PROMPT: &str = "continue";
const SYSTEM_PROMPT_TEMPLATE: &str = include_str!("system_prompt.md");
const MODEL_IDENTITY_PLACEHOLDER: &str = "{{MODEL_IDENTITY}}";
const THREAD_ID_PLACEHOLDER: &str = "{{THREAD_ID}}";
const TRANSCRIPT_DIR_PLACEHOLDER: &str = "{{TRANSCRIPT_DIR}}";

fn submission_owned_by_another_executor(error: &str) -> bool {
    error.contains(SUBMISSION_OWNED_BY_ANOTHER_EXECUTOR)
}

pub struct AgentRun {
    request: RunAgentRequest,
    chatgpt_client: Option<crate::chatgpt::ChatGptClient>,
    runtime: RuntimeClient,
    run_id: String,
    user_id: String,
    prompt_part: Option<TranscriptPart>,
    claim_id: String,
    workspace_root: std::path::PathBuf,
    gateway_url: String,
}

impl AgentRun {
    pub async fn observe_output(
        &mut self,
        output: Arc<crate::RunOutput>,
        store: Arc<TranscriptStore>,
    ) {
        output.initialize(
            store,
            self.user_id.clone(),
            self.request.thread_id.clone(),
            self.run_id.clone(),
        );
        if let Some(part) = &self.prompt_part {
            output.record_part(part.clone()).await;
        }
        self.runtime.output = Some(output);
    }

    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    pub fn user_id(&self) -> &str {
        &self.user_id
    }

    pub fn thread_id(&self) -> &str {
        &self.request.thread_id
    }

    pub fn prompt_part(&self) -> Option<&TranscriptPart> {
        self.prompt_part.as_ref()
    }
}

#[derive(Clone, Copy)]
enum RunFinalStatus {
    Completed,
    Cancelled,
    Failed,
}

impl RunFinalStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Cancelled => "cancelled",
            Self::Failed => "failed",
        }
    }
}

struct WorkspacePromptContext {
    base_instructions: String,
    initial_context: Message,
}

/// Restores the thread's saved cwd, falling back to the workspace root when it
/// is gone, e.g. a deleted worktree or a thread resumed on another machine.
fn restore_cwd(workspace_root: &Path, saved: Option<&str>) -> PathBuf {
    saved
        .and_then(|saved| {
            resolve_directory(workspace_root, saved)
                .map(simplified_path)
                .inspect_err(|error| {
                    eprintln!("sprocket-agent: resetting cwd to the workspace root: {error:#}")
                })
                .ok()
        })
        .unwrap_or_else(|| workspace_root.to_path_buf())
}

fn build_workspace_prompt_context(
    workspace_path: &str,
    workspace_instructions: &[WorkspaceInstruction],
    skills: &[WorkspaceSkill],
    model_label: &str,
    model_id: &str,
    thread_id: &str,
    transcript_dir: &Path,
) -> WorkspacePromptContext {
    let user_instructions = workspace_instructions
        .iter()
        .filter(|instruction| instruction.source == WorkspaceInstructionSource::User)
        .map(|instruction| instruction.contents.as_str())
        .collect::<Vec<_>>()
        .join("\n\n");
    let project_instructions = workspace_instructions
        .iter()
        .filter(|instruction| instruction.source == WorkspaceInstructionSource::Workspace)
        .map(|instruction| instruction.contents.as_str())
        .collect::<Vec<_>>()
        .join("\n\n");
    let instruction_block = if user_instructions.is_empty() && project_instructions.is_empty() {
        "No AGENTS.md instructions were preloaded for the current workspace.".to_string()
    } else {
        let mut blocks = Vec::new();
        if !user_instructions.is_empty() {
            blocks.push(format!(
                "### The user's AGENTS.md\n<INSTRUCTIONS>\n{user_instructions}\n</INSTRUCTIONS>"
            ));
        }
        if !project_instructions.is_empty() {
            blocks.push(format!(
                "### AGENTS.md instructions for {workspace_path}\n<INSTRUCTIONS>\n{project_instructions}\n</INSTRUCTIONS>"
            ));
        }
        blocks.join("\n\n")
    };

    let entries = skills
        .iter()
        .filter(|skill| !skill.disable_model_invocation)
        .map(|skill| {
            let description = collapse_whitespace(&skill.description);
            format!("- name: {}\n  description: {description}", skill.name)
        })
        .collect::<Vec<_>>()
        .join("\n");
    let skills_block = if entries.is_empty() {
        "No skills are installed.".to_string()
    } else {
        format!("<SKILLS>\n{entries}\n</SKILLS>")
    };

    let model_identity = format!("Your model is {model_label} ({model_id}).");
    let base_instructions = SYSTEM_PROMPT_TEMPLATE
        .trim_end()
        .replace(MODEL_IDENTITY_PLACEHOLDER, &model_identity)
        .replace(THREAD_ID_PLACEHOLDER, thread_id)
        .replace(
            TRANSCRIPT_DIR_PLACEHOLDER,
            &transcript_dir.display().to_string(),
        );
    let initial_context = Message::user(
        [
            "# Thread-Scoped Workspace Context",
            "",
            "The following workspace context was loaded when this conversation began.",
            "",
            "## Available Skills",
            "",
            &skills_block,
            "",
            "## Preloaded AGENTS.md Instructions",
            "",
            &instruction_block,
        ]
        .join("\n"),
    );

    WorkspacePromptContext {
        base_instructions,
        initial_context,
    }
}

async fn cleanup_twice<T, F, Fut>(
    what: &str,
    attempt_timeout: Duration,
    mut attempt: F,
) -> anyhow::Result<T>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = anyhow::Result<T>>,
{
    let timed = |fut: Fut| async move {
        timeout(attempt_timeout, fut)
            .await
            .map_err(|_| anyhow!("{what} timed out"))?
    };
    match timed(attempt()).await {
        Ok(value) => Ok(value),
        Err(first_error) => {
            eprintln!("sprocket-agent: {what} failed; retrying: {first_error}");
            sleep(FAILURE_CLEANUP_RETRY_DELAY).await;
            timed(attempt()).await.map_err(|retry_error| {
                anyhow!("{what} failed after retry: {retry_error}; initial cleanup failed: {first_error}")
            })
        }
    }
}

async fn fail_run_before_start(
    runtime: &RuntimeClient,
    run_id: &str,
    error: &anyhow::Error,
) -> anyhow::Result<bool> {
    let message = format!("Run failed before the model started: {error}");
    let last_error = error.to_string();
    cleanup_twice(
        &format!("queued run cleanup for run {run_id}"),
        FAILURE_CLEANUP_ATTEMPT_TIMEOUT,
        || {
            runtime.finalize_queued_run(
                run_id,
                &message,
                RunFinalStatus::Failed.as_str(),
                Some(&last_error),
            )
        },
    )
    .await
}

async fn abort_before_start(
    runtime: &RuntimeClient,
    run_id: &str,
    error: anyhow::Error,
) -> anyhow::Result<()> {
    if fail_run_before_start(runtime, run_id, &error).await? {
        Err(error)
    } else {
        Ok(())
    }
}

async fn finalize_claim_failure(
    runtime: &RuntimeClient,
    run_id: &str,
    claim_id: &str,
    error: &anyhow::Error,
    text: &str,
) -> anyhow::Result<()> {
    let last_error = error.to_string();
    let accepted = cleanup_twice(
        &format!("claim failure cleanup for run {run_id}"),
        FAILURE_CLEANUP_ATTEMPT_TIMEOUT,
        || runtime.finalize_claim_failure(run_id, claim_id, text, &last_error),
    )
    .await?;
    if !accepted {
        eprintln!(
            "sprocket-agent: claim failure cleanup skipped for run {run_id}; run no longer belongs to this active claim"
        );
    }
    Ok(())
}

async fn abort_after_claim(
    runtime: &RuntimeClient,
    run_id: &str,
    claim_id: &str,
    error: anyhow::Error,
) -> anyhow::Result<()> {
    // After claim (including mid-run lease loss); not the pre-start phrasing.
    let text = format!("Run aborted: {error:#}");
    match finalize_claim_failure(runtime, run_id, claim_id, &error, &text).await {
        Ok(()) => Err(error),
        Err(cleanup_error) => Err(anyhow!(
            "{error}; additionally failed to durably terminalize the run: {cleanup_error}"
        )),
    }
}

async fn start_run_once(
    runtime: &RuntimeClient,
    run_id: &str,
    claim_id: &str,
) -> anyhow::Result<crate::types::StartRunResponse> {
    timeout(
        RUN_CLAIM_ATTEMPT_TIMEOUT,
        runtime.start_run(run_id, claim_id),
    )
    .await
    .map_err(|_| anyhow!("claim attempt timed out"))?
}

async fn finalize_run(
    runtime: &RuntimeClient,
    run_id: &str,
    claim_id: &str,
    assistant_text: &str,
    status: RunFinalStatus,
    error_message: Option<&str>,
) -> anyhow::Result<()> {
    let status_text = status.as_str();
    let accepted = runtime
        .finalize_run(run_id, claim_id, assistant_text, status_text, error_message)
        .await
        .map_err(|error| anyhow!("failed to finalize {status_text} run: {error}"))?;
    if !accepted {
        return Err(anyhow!(
            "failed to finalize {status_text} run because claim ownership was lost"
        ));
    }
    Ok(())
}

async fn finalize_provider_result(
    runtime: &RuntimeClient,
    run_id: &str,
    claim_id: &str,
    provider_result: AgentProviderResult,
) -> anyhow::Result<()> {
    match provider_result {
        AgentProviderResult::Completed { text } => {
            eprintln!("sprocket-agent: model completed {}", run_id);
            finalize_run(
                runtime,
                run_id,
                claim_id,
                &text,
                RunFinalStatus::Completed,
                None,
            )
            .await
        }
        AgentProviderResult::Cancelled { text } => {
            eprintln!("sprocket-agent: run cancelled {}", run_id);
            finalize_run(
                runtime,
                run_id,
                claim_id,
                &text,
                RunFinalStatus::Cancelled,
                None,
            )
            .await
        }
        AgentProviderResult::Superseded { error } => {
            eprintln!(
                "sprocket-agent: provider attempt superseded {}: {error}",
                run_id
            );
            abort_after_claim(
                runtime,
                run_id,
                claim_id,
                anyhow!("the model connection could not be recovered"),
            )
            .await
        }
        AgentProviderResult::Failed { text, error } => {
            let error_text = error.to_string();
            eprintln!("sprocket-agent: model failed {}: {}", run_id, error_text);

            match finalize_run(
                runtime,
                run_id,
                claim_id,
                &text,
                RunFinalStatus::Failed,
                Some(&error_text),
            )
            .await
            {
                Ok(()) => Err(error),
                Err(finalization_error) => Err(anyhow!(
                    "model failed: {error}; additionally failed to finalize run: {finalization_error}"
                )),
            }
        }
    }
}

async fn acknowledge_stop(
    runtime: &RuntimeClient,
    run_id: &str,
    claim_id: &str,
) -> anyhow::Result<()> {
    match finalize_run(
        runtime,
        run_id,
        claim_id,
        "",
        RunFinalStatus::Cancelled,
        None,
    )
    .await
    {
        Ok(()) => Ok(()),
        Err(error) => {
            eprintln!("sprocket-agent: stop acknowledgement for run {run_id}: {error}");
            Ok(())
        }
    }
}

async fn claim_run(
    runtime: &RuntimeClient,
    run_id: &str,
    claim_id: &str,
) -> anyhow::Result<Option<Instant>> {
    let mut request_started_at = Instant::now();
    let start = match start_run_once(runtime, run_id, claim_id).await {
        Ok(start) => start,
        Err(first_error) => {
            eprintln!(
                "sprocket-agent: claim attempt failed for run {}; retrying with the same claim: {}",
                run_id, first_error
            );
            request_started_at = Instant::now();
            match start_run_once(runtime, run_id, claim_id).await {
                Ok(start) => start,
                Err(retry_error) => {
                    let claim_error = anyhow!(
                        "failed to claim run {run_id} after retry: {retry_error}; initial attempt failed: {first_error}"
                    );
                    let text = format!("Run failed before the model started: {claim_error}");
                    if let Err(cleanup_error) =
                        finalize_claim_failure(runtime, run_id, claim_id, &claim_error, &text).await
                    {
                        return Err(anyhow!(
                            "{claim_error}; additionally failed to durably terminalize the run: {cleanup_error}"
                        ));
                    }
                    return Err(claim_error);
                }
            }
        }
    };
    if !start.claimed {
        eprintln!("sprocket-agent: run {} already claimed or finished", run_id);
        return Ok(None);
    }

    eprintln!("sprocket-agent: marked run running {}", run_id);
    Ok(Some(request_started_at))
}

async fn renew_claim_once(
    runtime: &RuntimeClient,
    run_id: &str,
    claim_id: &str,
) -> anyhow::Result<(bool, Instant)> {
    let request_started_at = Instant::now();
    let renewed = tokio::time::timeout(
        RUN_CLAIM_RENEW_ATTEMPT_TIMEOUT,
        runtime.renew_claim(run_id, claim_id),
    )
    .await
    .map_err(|_| anyhow!("claim renewal timed out"))?
    .map(|response| response.renewed)?;
    Ok((renewed, request_started_at))
}

/// Retries transient renewal failures while the lease window can still fit
/// another attempt.
async fn renew_claim_with<F, Fut>(
    run_id: &str,
    lease_deadline: Instant,
    mut attempt: F,
) -> anyhow::Result<(bool, Instant)>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = anyhow::Result<(bool, Instant)>>,
{
    let mut first_error: Option<String> = None;
    loop {
        match attempt().await {
            Ok(outcome) => return Ok(outcome),
            Err(error) => {
                let retry_window_fits = Instant::now()
                    + RUN_CLAIM_RENEW_ATTEMPT_TIMEOUT
                    + RUN_CLAIM_EXPIRY_SAFETY_MARGIN
                    < lease_deadline;
                if !retry_window_fits {
                    return Err(match &first_error {
                        Some(first) => anyhow!(
                            "failed to renew claim for run {run_id} before the lease window closed: {error}; initial attempt failed: {first}"
                        ),
                        None => anyhow!("failed to renew claim for run {run_id}: {error}"),
                    });
                }
                first_error.get_or_insert_with(|| error.to_string());
                eprintln!(
                    "sprocket-agent: claim renewal failed for run {run_id}; retrying: {error}"
                );
                sleep(RUN_CLAIM_RENEW_RETRY_DELAY).await;
            }
        }
    }
}

/// Runs `operation` while renewing the claim lease.
///
/// Renewals are anchored to the last successful renewal request start, so a
/// slow renewal (reconnect, CPU starvation) cannot push the next one past
/// the lease deadline. The server is the authority on lease ownership, so
/// renewals are attempted even past the conservative local deadline estimate.
///
/// Only claim/lease failures are returned as `Err`; the operation's value
/// (including its own errors) is wrapped in `Ok`.
async fn drive_claim_lease<R, RFut, F, T>(
    run_id: &str,
    lease_started_at: Instant,
    mut renew: R,
    operation: F,
) -> anyhow::Result<T>
where
    R: FnMut(Instant) -> RFut,
    RFut: Future<Output = anyhow::Result<(bool, Instant)>>,
    F: Future<Output = T>,
{
    let mut lease_deadline = lease_started_at + RUN_CLAIM_LEASE_DURATION;
    let mut next_renewal_at = lease_started_at + RUN_CLAIM_RENEW_INTERVAL;
    tokio::pin!(operation);

    loop {
        tokio::select! {
            biased;
            _ = sleep_until(next_renewal_at) => {
                match renew(lease_deadline).await? {
                    (true, renewal_started_at) => {
                        lease_deadline = renewal_started_at + RUN_CLAIM_LEASE_DURATION;
                        next_renewal_at = renewal_started_at + RUN_CLAIM_RENEW_INTERVAL;
                    }
                    (false, _) => return Err(anyhow!("claim lease for run {run_id} was lost")),
                }
            }
            result = &mut operation => return Ok(result),
        }
    }
}

async fn run_with_claim_lease<F, T>(
    runtime: &RuntimeClient,
    run_id: &str,
    claim_id: &str,
    lease_started_at: Instant,
    operation: F,
) -> anyhow::Result<T>
where
    F: Future<Output = T>,
{
    drive_claim_lease(
        run_id,
        lease_started_at,
        move |lease_deadline| {
            renew_claim_with(run_id, lease_deadline, move || {
                renew_claim_once(runtime, run_id, claim_id)
            })
        },
        operation,
    )
    .await
}

pub async fn start_agent_run(request: RunAgentRequest) -> anyhow::Result<AgentRun> {
    eprintln!("sprocket-agent: starting thread {}", request.thread_id);
    // Pin the ChatGPT account active at submission. When it is unavailable the
    // run starts anyway and falls back to the user's next provider.
    let chatgpt_client = if request.completion_provider == crate::types::CompletionProvider::Chatgpt
    {
        request
            .chatgpt_credentials
            .clone()
            .and_then(|credentials| crate::chatgpt::ChatGptClient::new(credentials).ok())
    } else {
        None
    };
    let claim_id = Uuid::new_v4().to_string();
    let runtime = timeout(
        SUBMISSION_ATTEMPT_TIMEOUT,
        RuntimeClient::from_request(&request),
    )
    .await
    .context("timed out initializing agent submission")??;
    let workspace_root = resolve_workspace_root(&request.workspace_path)?;

    let created_run = loop {
        if request.cancellation.is_cancelled() {
            return Err(sprocket_workspace::WorkspaceOperationCancelled.into());
        }
        match timeout(SUBMISSION_ATTEMPT_TIMEOUT, runtime.create_run(&request))
            .await
            .context("timed out submitting agent run")?
        {
            Ok(created) => break created,
            Err(error) if submission_is_waiting(&error) && !request.thread_id.is_empty() => {
                wait_until_ready(&request.cancellation, || async {
                    let result = runtime
                        .client
                        .mutation(
                            "agentRuntime:prepareSubmission",
                            std::collections::BTreeMap::from([(
                                "threadId".to_string(),
                                request.thread_id.clone().into(),
                            )]),
                        )
                        .await?;
                    sprocket_convex::decode_function_result(
                        result,
                        "agentRuntime:prepareSubmission",
                    )
                })
                .await?;
            }
            Err(error) => return Err(error),
        }
    };
    let mut request = request;
    request.thread_id = created_run.thread_id.clone();
    // The browser token is only needed to create and bind the run. Every later
    // operation uses the run-scoped capability, so browser lifetime and token
    // refresh can no longer interrupt an active local executor.
    runtime.client.clear_auth().await;
    if created_run.created {
        eprintln!("sprocket-agent: created run {}", created_run.run_id);
    } else {
        eprintln!(
            "sprocket-agent: resuming submission {} as run {}",
            request.submission_id, created_run.run_id
        );
    }
    let prompt_part =
        match created_run.prompt_part {
            Some(part) => {
                let mut prompt_parts = parse_remote_parts(serde_json::json!({
                    "parts": [part]
                }))?;
                Some(prompt_parts.pop().ok_or_else(|| {
                    anyhow!("create run response omitted the prompt transcript part")
                })?)
            }
            None => None,
        };
    let run_id = created_run.run_id;
    Ok(AgentRun {
        request,
        chatgpt_client,
        runtime,
        run_id,
        user_id: created_run.user_id,
        prompt_part,
        claim_id,
        workspace_root,
        gateway_url: created_run.gateway_url,
    })
}

pub async fn finalize_failed_start(
    request: RunAgentRequest,
    startup_error: String,
) -> anyhow::Result<()> {
    // createGatewayRun rejected the duplicate submission: a racing launch owns
    // the run, so this executor's cleanup has nothing to terminalize.
    if submission_owned_by_another_executor(&startup_error) {
        eprintln!(
            "sprocket-agent: submission {} already belongs to an active run; standing down",
            request.submission_id
        );
        return Ok(());
    }
    let runtime = RuntimeClient::from_request(&request).await?;
    runtime.client.clear_auth().await;
    let text = format!("Run failed before the model started: {startup_error}");
    let deadline = Instant::now() + START_FAILURE_RECONCILE_TIMEOUT;
    loop {
        let result = timeout(
            START_FAILURE_CLEANUP_ATTEMPT_TIMEOUT,
            runtime.finalize_failed_start(&request, &text, &startup_error),
        )
        .await;
        match result {
            Ok(Ok(FailedStartCleanup::Finalized)) => return Ok(()),
            Ok(Ok(FailedStartCleanup::Pending)) => {
                eprintln!(
                    "sprocket-agent: startup failure cleanup has not observed submission {}; retrying",
                    request.submission_id
                );
            }
            Ok(Ok(FailedStartCleanup::StandDown)) => {
                eprintln!(
                    "sprocket-agent: submission {} already belongs to an active run; standing down",
                    request.submission_id
                );
                return Ok(());
            }
            Ok(Err(error)) => {
                eprintln!(
                    "sprocket-agent: startup failure cleanup for submission {} failed; retrying: {error}",
                    request.submission_id
                );
            }
            Err(_) => {
                eprintln!(
                    "sprocket-agent: startup failure cleanup for submission {} timed out; retrying",
                    request.submission_id
                );
            }
        }
        if Instant::now() + FAILURE_CLEANUP_RETRY_DELAY >= deadline {
            return Err(anyhow!(
                "startup failure cleanup did not reconcile submission {} before its deadline",
                request.submission_id
            ));
        }
        sleep(FAILURE_CLEANUP_RETRY_DELAY).await;
    }
}

struct PriorHistory {
    messages: Vec<Message>,
    continue_from_finished_turns: bool,
    current_prompt: Option<String>,
}

fn should_continue_without_prompt(
    continue_from_finished_turns: bool,
    is_continuation: bool,
    prompt_text: &str,
) -> bool {
    continue_from_finished_turns || (is_continuation && prompt_text.is_empty())
}

async fn load_prior_history(
    runtime: &RuntimeClient,
    store: &TranscriptStore,
    context: &RunContextResponse,
    run_id: &str,
    supports_images: bool,
) -> anyhow::Result<PriorHistory> {
    let user_id = &context.run.user_id;
    let thread_id = &context.run.thread_id;
    let remote = runtime.transcript_state_for_run(run_id).await?;
    let state = apply_remote_state(store, user_id, thread_id, &remote, false).await?;
    let (mut parts, current_run_had_context_handoff) = load_context_parts(
        store,
        user_id,
        thread_id,
        &state,
        run_id,
        |start, end, order| {
            runtime.transcript_parts_page_for_run(run_id, thread_id, start, end, order)
        },
    )
    .await?;
    cache_prompt_attachments(
        store,
        user_id,
        thread_id,
        &mut parts,
        |number, storage_id| async move {
            runtime
                .attachment_url_for_run(run_id, number, &storage_id)
                .await
        },
    )
    .await?;
    let current_prompt = pending_prompt_part(&state, &parts, run_id)
        .and_then(|part| part.prompt.as_ref())
        .map(|prompt| prompt.text_with_attachments());
    let mut history = agent_history_from_parts(&state, &parts, Some(run_id));
    let image_urls = crate::tools::ConvexImageUrls::new(runtime, run_id);
    crate::tools::hydrate_tool_history(&mut history, &parts, supports_images, Some(&image_urls))
        .await;
    Ok(PriorHistory {
        current_prompt,
        messages: deserialize_agent_history(history)?,
        continue_from_finished_turns: current_run_had_context_handoff
            || current_run_has_finished_turns(&parts, run_id),
    })
}

async fn load_context_parts<F, Fut>(
    store: &TranscriptStore,
    user: &str,
    thread: &str,
    state: &TranscriptState,
    run_id: &str,
    fetch: F,
) -> anyhow::Result<(Vec<TranscriptPart>, bool)>
where
    F: FnMut(u32, u32, DownloadOrder) -> Fut,
    Fut: Future<Output = anyhow::Result<Vec<TranscriptPart>>>,
{
    let check_handoff = state.context_summary.is_some() && state.history_from_number > 0;
    let start = state.history_from_number - u32::from(check_handoff);
    let end = state.remote_total_parts;
    anyhow::ensure!(
        state.history_from_number <= end,
        "invalid transcript context range"
    );
    store
        .ensure_parts(user, thread, start, end, DownloadOrder::Desc, fetch)
        .await?;
    let numbers: Vec<_> = (start..end).collect();
    let mut parts = store.read_parts(user, thread, &numbers).await?;
    anyhow::ensure!(
        parts.len() == numbers.len(),
        "required transcript parts are missing locally after sync"
    );
    let had_handoff = check_handoff && parts.first().is_some_and(|part| part.run_id == run_id);
    if check_handoff {
        parts.remove(0);
    }
    Ok((parts, had_handoff))
}

pub async fn run_agent(
    run: AgentRun,
    command_sessions: sprocket_workspace::CommandSessionManager,
    live: Arc<LiveCompletionHub>,
    store: Arc<TranscriptStore>,
) -> anyhow::Result<()> {
    let AgentRun {
        request,
        chatgpt_client,
        runtime,
        run_id,
        claim_id,
        workspace_root,
        gateway_url,
        ..
    } = run;

    let mut context: RunContextResponse = match runtime.run_context(&run_id).await {
        Ok(context) => context,
        Err(error) => return abort_before_start(&runtime, &run_id, error).await,
    };
    eprintln!("sprocket-agent: loaded run context {}", run_id);
    let transcript_dir = store.thread_dir(&context.run.user_id, &context.run.thread_id);
    let cwd = restore_cwd(&workspace_root, context.cwd.as_deref());

    let (capabilities, handoff_model) =
        match catalog_models_for_run(&gateway_url, &context.run, context.provider_handoff.take())
            .await
        {
            Ok(models) => models,
            Err(error) => return abort_before_start(&runtime, &run_id, error).await,
        };
    let mut omit_prior_reasoning = false;
    let mut handoff_model = match handoff_model {
        Ok(model) => model,
        Err(error) => {
            eprintln!(
                "sprocket-agent: provider switch context handoff failed ({error:#}); continuing on the selected provider without it"
            );
            omit_prior_reasoning = true;
            None
        }
    };
    context.provider_handoff = handoff_model.as_ref().map(|(handoff, _)| handoff.clone());

    let chatgpt_client = if chatgpt_client.is_none()
        && context
            .provider_handoff
            .as_ref()
            .is_some_and(|handoff| handoff.completion_provider == CompletionProvider::Chatgpt)
    {
        let previous_client = request
            .chatgpt_credentials
            .clone()
            .context(
                "The previous ChatGPT provider must remain connected to write the context handoff.",
            )
            .and_then(crate::chatgpt::ChatGptClient::new);
        match previous_client {
            Ok(client) => Some(client),
            Err(error) => {
                eprintln!(
                    "sprocket-agent: provider switch context handoff failed ({error:#}); continuing on the selected provider without it"
                );
                context.provider_handoff = None;
                handoff_model = None;
                omit_prior_reasoning = true;
                None
            }
        }
    } else {
        chatgpt_client
    };
    let provider = AgentProvider::default_for_run(
        &context,
        &capabilities.vendor,
        &gateway_url,
        chatgpt_client,
        request.chatgpt_credentials.clone(),
    );

    let reasoning_effort = context.run.reasoning_effort.clone();
    let fast_mode = context.run.fast_mode;
    let prepare_history = load_prior_history(
        &runtime,
        &store,
        &context,
        &run_id,
        handoff_model
            .as_ref()
            .map(|(_, capabilities)| capabilities)
            .unwrap_or(&capabilities)
            .supports_images,
    );
    let prior_history = {
        let mut updates = match runtime.run_finished_subscription(&run_id).await {
            Ok(updates) => updates,
            Err(error) => return abort_before_start(&runtime, &run_id, error).await,
        };
        tokio::pin!(prepare_history);
        loop {
            tokio::select! {
                biased;
                _ = request.cancellation.cancelled() => {
                    runtime.finalize_queued_run(&run_id, "", RunFinalStatus::Cancelled.as_str(), None).await?;
                    return Ok(());
                }
                update = updates.next() => {
                    match update.map(RuntimeClient::decode_run_finished_update) {
                        Some(Ok(true)) => return Ok(()),
                        Some(Ok(false)) => {},
                        Some(Err(error)) => return abort_before_start(&runtime, &run_id, error).await,
                        None => return abort_before_start(&runtime, &run_id, anyhow!("run status subscription closed during history preparation")).await,
                    }
                }
                history = &mut prepare_history => {
                    match history {
                        Ok(history) => break history,
                        Err(error) => return abort_before_start(&runtime, &run_id, error).await,
                    }
                }
            }
        }
    };
    let prepared = (|| {
        let workspace_instructions = load_workspace_instructions(&workspace_root)?;
        let workspace_skills =
            load_workspace_skills(&workspace_root, &default_user_skills_dirs(), BUILTIN_SKILLS);
        for warning in &workspace_skills.warnings {
            eprintln!("sprocket-agent: {warning}");
        }
        let skills: Arc<[WorkspaceSkill]> = workspace_skills.skills.into();
        let is_continuation = context.run.continuation_of_run_id.is_some()
            || request.continuation_of_run_id.is_some();
        let prompt_text = prior_history
            .current_prompt
            .as_deref()
            .unwrap_or(&context.prompt)
            .trim();
        if prompt_text.is_empty() && !is_continuation && !prior_history.continue_from_finished_turns
        {
            return Err(anyhow!("run does not contain a user prompt"));
        }
        let mut prompt_contents = Vec::new();
        if !prompt_text.is_empty() {
            prompt_contents.push(UserContent::text(prompt_text));
        }
        let prompt = Message::User {
            content: prompt_contents,
        };
        let prompt_context = build_workspace_prompt_context(
            &request.workspace_path,
            &workspace_instructions,
            &skills,
            &capabilities.label,
            &context.run.selected_model,
            &context.run.thread_id,
            &transcript_dir,
        );
        let handoff_base_instructions = handoff_model.as_ref().map(|(handoff, capabilities)| {
            build_workspace_prompt_context(
                &request.workspace_path,
                &workspace_instructions,
                &skills,
                &capabilities.label,
                &handoff.selected_model,
                &context.run.thread_id,
                &transcript_dir,
            )
            .base_instructions
        });
        let continue_without_prompt = should_continue_without_prompt(
            prior_history.continue_from_finished_turns,
            is_continuation,
            prompt_text,
        );
        Ok((
            prompt,
            provider,
            prompt_context,
            handoff_base_instructions,
            skills,
            continue_without_prompt,
        ))
    })();

    let (
        prompt,
        provider,
        prompt_context,
        handoff_base_instructions,
        skills,
        continue_without_prompt,
    ) = match prepared {
        Ok(values) => values,
        Err(error) => return abort_before_start(&runtime, &run_id, error).await,
    };
    let prompt = if continue_without_prompt {
        Message::user(CONTINUE_PROMPT)
    } else {
        prompt
    };

    eprintln!("sprocket-agent: prepared assistant response {}", run_id);

    let Some(lease_started_at) = claim_run(&runtime, &run_id, &claim_id).await? else {
        return Ok(());
    };

    if request.cancellation.is_cancelled() {
        acknowledge_stop(&runtime, &run_id, &claim_id).await?;
        return Ok(());
    }

    eprintln!(
        "sprocket-agent: selected completion provider {} for run {run_id}",
        context.run.completion_provider.as_str()
    );

    match timeout(RUN_CLAIM_ATTEMPT_TIMEOUT, runtime.run_finished(&run_id)).await {
        Ok(Ok(false)) => {}
        Ok(Ok(true)) => {
            acknowledge_stop(&runtime, &run_id, &claim_id).await?;
            return Ok(());
        }
        Ok(Err(error)) => return abort_after_claim(&runtime, &run_id, &claim_id, error).await,
        Err(_) => {
            return abort_after_claim(
                &runtime,
                &run_id,
                &claim_id,
                anyhow!("timed out checking whether run {run_id} was already finished"),
            )
            .await;
        }
    }

    match run_with_claim_lease(&runtime, &run_id, &claim_id, lease_started_at, async {
        let provider_result = provider
            .run(
                runtime.clone(),
                AgentProviderRequest {
                    allow_interaction: request.allow_interaction,
                    is_child: context.run.parent_thread_id.is_some(),
                    cancellation: request.cancellation,
                    run_id: run_id.clone(),
                    claim_id: claim_id.clone(),
                    user_id: context.run.user_id.clone(),
                    thread_id: request.thread_id.clone(),
                    live: live.clone(),
                    prompt,
                    base_instructions: prompt_context.base_instructions,
                    handoff_base_instructions,
                    initial_context: vec![prompt_context.initial_context],
                    prior_history: prior_history.messages,
                    artifact_bindings: sprocket_workspace::artifact_bindings::ArtifactBindings::new(
                        &store.root().with_file_name("artifact-bindings"),
                        &request.deployment_url,
                        &context.run.user_id,
                        &workspace_root,
                    ),
                    command_sessions: command_sessions.clone(),
                    workspace_root,
                    cwd,
                    skills,
                    reasoning_effort,
                    fast_mode,
                    context_budget: capabilities.context_budget,
                    supports_images: capabilities.supports_images,
                    long_context_threshold_tokens: capabilities.long_context_threshold_tokens,
                    handoff_long_context_threshold_tokens: handoff_model
                        .as_ref()
                        .and_then(|(_, capabilities)| capabilities.long_context_threshold_tokens),
                    transcript_dir,
                    context_tokens: context.context_tokens,
                    defer_prompt_for_context_handoff: !continue_without_prompt,
                    omit_prior_reasoning,
                    gateway_url: gateway_url.clone(),
                    subagent_launcher: request.subagent_launcher.clone(),
                    transcript_store: request.transcript_store.clone(),
                },
            )
            .await;

        finalize_provider_result(&runtime, &run_id, &claim_id, provider_result).await
    })
    .await
    {
        Ok(result) => result,
        Err(error) => {
            // The lease is gone, so the server's lifecycle check marks the run
            // abandoned. A renewal tick can also race the operation's own
            // finalization, which this acknowledges instead.
            match runtime.run_finished(&run_id).await {
                Ok(true) => {
                    acknowledge_stop(&runtime, &run_id, &claim_id).await?;
                    Ok(())
                }
                _ => Err(error),
            }
        }
    }
}

fn collapse_whitespace(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod claim_lease_tests;
