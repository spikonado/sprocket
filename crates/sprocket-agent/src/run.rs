use anyhow::anyhow;
use rig::OneOrMany;
use rig::completion::Message;
use rig::message::{ImageMediaType, UserContent};
use sprocket_workspace::{
    BUILTIN_SKILLS, WorkspaceInstruction, WorkspaceSkill, default_user_skills_dirs,
    load_workspace_instructions, load_workspace_skills, resolve_workspace_root,
};
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;
use tokio::time::{Instant, sleep, sleep_until, timeout};
use uuid::Uuid;

use crate::RunContextResponse;
use crate::convex::RuntimeClient;
use crate::provider::{AgentProvider, AgentProviderRequest, AgentProviderResult};
use crate::types::{RunAgentRequest, deserialize_agent_history};

// Keep RUN_CLAIM_LEASE_DURATION synchronized with
// apps/web/src/convex/lib/runLease.ts (RUN_CLAIM_LEASE_DURATION_MS).
const RUN_CLAIM_LEASE_DURATION: Duration = Duration::from_secs(60);
const RUN_CLAIM_RENEW_INTERVAL: Duration = Duration::from_secs(20);
const RUN_CLAIM_RENEW_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(8);
const RUN_CLAIM_EXPIRY_SAFETY_MARGIN: Duration = Duration::from_secs(5);
const RUN_CLAIM_RENEW_RETRY_DELAY: Duration = Duration::from_millis(250);
const RUN_CLAIM_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(8);
const FAILURE_CLEANUP_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(5);
const START_FAILURE_CLEANUP_ATTEMPT_TIMEOUT: Duration = Duration::from_millis(2_500);
const START_FAILURE_RECONCILE_TIMEOUT: Duration = Duration::from_secs(10);
const FAILURE_CLEANUP_RETRY_DELAY: Duration = Duration::from_millis(250);

pub struct AgentRun {
    request: RunAgentRequest,
    runtime: RuntimeClient,
    run_id: String,
    claim_id: String,
    workspace_root: std::path::PathBuf,
}

impl AgentRun {
    pub fn run_id(&self) -> &str {
        &self.run_id
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

fn build_workspace_preamble(
    workspace_path: &str,
    workspace_instructions: &[WorkspaceInstruction],
    skills: &[WorkspaceSkill],
) -> String {
    let instruction_block = if workspace_instructions.is_empty() {
        "No AGENTS.md instructions were preloaded for the current workspace.".to_string()
    } else {
        format!(
            "# AGENTS.md instructions for {workspace_path}:\n<INSTRUCTIONS>\n{}\n</INSTRUCTIONS>",
            workspace_instructions
                .iter()
                .map(|instruction| instruction.contents.as_str())
                .collect::<Vec<_>>()
                .join("\n\n")
        )
    };

    let skills_block = if skills.is_empty() {
        "No skills are installed.".to_string()
    } else {
        let entries = skills
            .iter()
            .map(|skill| {
                let description = collapse_whitespace(&skill.description);
                format!("- name: {}\n  description: {description}", skill.name)
            })
            .collect::<Vec<_>>()
            .join("\n");
        format!("<SKILLS>\n{entries}\n</SKILLS>")
    };

    [
        "# System Instructions",
        "",
        "## Identity",
        "",
        "Your name is Sprocket.",
        "You are an engineering agent operating in the user's real local workspace.",
        "You are a careful senior engineer.",
        "You like debating with the user when you feel there is a better way to achieve an end goal.",
        "",
        "## Working on Tasks",
        "",
        "Fix the root cause of problems.",
        "Do not guess about the project's state; always inspect before editing.",
        "If the workspace is already dirty, do not revert the changes. Try to work around them. If they conflict with the changes you need to make, ask the user what to do with them.",
        "Don't hesitate to ask the user questions before, after, or while working. Don't assume what the user wants. This is to avoid cases similar to the following happening:",
        "  - The user asked you to delete some virtual machines, you couldn't find the exact ones and assumed that the ones you were seeing are the ones that need to be deleted and deleted them.",
        "  - You had to make some breaking changes to the schema of a project's dev database and assumed by yourself that the current data in the database was important and had to be migrated instead of just being deleted.",
        "",
        "### Working on Software",
        "",
        "Validate your work when the repo has relevant tests or build checks. Start with the most targeted checks for the code you changed.",
        "When you finish, respond with a concise summary of what changed and which checks you ran.",
        "",
        "#### Writing Tests",
        "",
        "It's a good practice to write tests.",
        "This doesn't mean that you should write a test for every change.",
        "Tests shouldn't be written as a necessity; they should truly verify some behaviour or edge case that isn't directly obvious looking at the code.",
        "",
        "## Your Training Data May Be Stale",
        "",
        "Your training data is many months out of date and may no longer be relevant for the tasks you work on.",
        "By \"may no longer be relevant\", we mean that newer best practices for the work you do, versions of a particular hardware product or software library, etc. may have come out.",
        "You should use the tools given to you to fetch the latest documentation/information in relation to your work.",
        "",
        "## Tool Usage",
        "",
        "Always use apply_patch to create, edit, delete, or rename files. Do not use the shell for those operations. `git` is an exception to this rule.",
        "Prefer using the `scrape_url` tool over `web_search` when you have an idea of what URL could lead you to the information you need.",
        "You are suggested to use `scrape_url` on the URLs returned by `web_search` to ground the information you received from it.",
        "",
        "",
        "## Skills",
        "",
        "Skills are reusable instruction packages.",
        "The available skills are listed below.",
        "When a task matches a skill's description, call the read_skill tool with its name before proceeding, and follow the returned instructions as needed.",
        "If the user writes $skill-name in their message (for example $code-review), they are explicitly invoking that skill: read it with read_skill and apply it, even if you would not have selected it yourself.",
        "Skills may reference bundled files; for on-disk skills, the read_skill result includes a dir path for reading those with exec_command when needed.",
        "",
        &skills_block,
        "",
        "## AGENTS.md Spec",
        "",
        "AGENTS.md files can appear anywhere in the repository tree.",
        "Each AGENTS.md file applies to the directory tree rooted at the folder that contains it.",
        "Follow all applicable AGENTS.md instructions, with deeper files taking precedence.",
        "The AGENTS.md instructions for the current workspace path are already included below and do not need to be re-read.",
        "If you move into a deeper subdirectory before editing, check for additional nested AGENTS.md files there.",
        "",
        &instruction_block,
    ]
    .join("\n")
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
    let text = format!("Run aborted: {error}");
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
    tokio::time::timeout(
        RUN_CLAIM_RENEW_ATTEMPT_TIMEOUT,
        runtime.renew_claim(run_id, claim_id),
    )
    .await
    .map_err(|_| anyhow!("claim renewal timed out"))?
    .map(|response| (response.renewed, request_started_at))
}

/// Renews the claim lease via `attempt`, retrying transient failures for as
/// long as the remaining lease window can still fit another attempt. A
/// renewed lease moves the deadline forward, so temporary backend
/// unavailability must not fail the run while there is still time to renew.
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
/// Renewals are anchored to when the last successful renewal request started
/// rather than to a free-running interval: a renewal that completes slowly
/// (e.g. while reconnecting to the backend) must not push the next renewal
/// past the lease deadline. A renewal anchor that is already in the past
/// fires immediately.
///
/// The local lease deadline is a conservative estimate (request start + lease
/// duration); the server is the authority on lease ownership. Renewals are
/// therefore attempted even when a scheduling stall (CPU saturation, slow
/// reconnect) pushed the tick past that estimate: the server answers whether
/// the lease is still owned, and must not be preemptively declared lost.
///
/// Renewing runs inside the select arm, so `operation` is not polled while
/// renewal attempts are in flight. That pause is bounded by the lease window
/// (retries stop once another attempt could not land before the deadline) and
/// is accepted in exchange for surviving backend unavailability.
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
                match renew(lease_deadline).await {
                    Ok((true, renewal_started_at)) => {
                        lease_deadline = renewal_started_at + RUN_CLAIM_LEASE_DURATION;
                        next_renewal_at = renewal_started_at + RUN_CLAIM_RENEW_INTERVAL;
                    }
                    Ok((false, _)) => {
                        return Err(anyhow!("claim lease for run {run_id} was lost"));
                    }
                    Err(error) => return Err(error),
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
    let claim_id = Uuid::new_v4().to_string();
    let runtime: RuntimeClient = RuntimeClient::from_request(&request).await?;
    let workspace_root = resolve_workspace_root(&request.workspace_path)?;

    let created_run = runtime.create_run(&request).await?;
    // The browser token is only needed to create and bind the run. Every later
    // operation uses the run-scoped capability, so browser lifetime and token
    // refresh can no longer interrupt an active local executor.
    runtime.completion_client().clear_auth().await;
    if created_run.created {
        eprintln!("sprocket-agent: created run {}", created_run.run_id);
    } else {
        eprintln!(
            "sprocket-agent: resuming submission {} as run {}",
            request.submission_id, created_run.run_id
        );
    }
    let run_id = created_run.run_id;
    Ok(AgentRun {
        request,
        runtime,
        run_id,
        claim_id,
        workspace_root,
    })
}

pub async fn finalize_failed_start(
    request: RunAgentRequest,
    startup_error: String,
) -> anyhow::Result<()> {
    let runtime = RuntimeClient::from_request(&request).await?;
    runtime.completion_client().clear_auth().await;
    let text = format!("Run failed before the model started: {startup_error}");
    let deadline = Instant::now() + START_FAILURE_RECONCILE_TIMEOUT;
    loop {
        let result = timeout(
            START_FAILURE_CLEANUP_ATTEMPT_TIMEOUT,
            runtime.finalize_failed_start(&request, &text, &startup_error),
        )
        .await;
        match result {
            Ok(Ok(true)) => return Ok(()),
            Ok(Ok(false)) => {
                eprintln!(
                    "sprocket-agent: startup failure cleanup has not observed submission {}; retrying",
                    request.submission_id
                );
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

pub async fn run_agent(run: AgentRun) -> anyhow::Result<()> {
    let AgentRun {
        request,
        runtime,
        run_id,
        claim_id,
        workspace_root,
    } = run;

    let context: RunContextResponse = match runtime.run_context(&run_id).await {
        Ok(context) => context,
        Err(error) => return abort_before_start(&runtime, &run_id, error).await,
    };
    eprintln!("sprocket-agent: loaded run context {}", run_id);

    let model = context.run.selected_model.clone();
    let reasoning_effort = context.run.reasoning_effort.clone();
    let service_tier = context.run.service_tier.clone();
    let context_budget = context.context_budget.clone();

    let prepared = (|| {
        let workspace_instructions = load_workspace_instructions(&workspace_root)?;
        let workspace_skills =
            load_workspace_skills(&workspace_root, &default_user_skills_dirs(), BUILTIN_SKILLS);
        for warning in &workspace_skills.warnings {
            eprintln!("sprocket-agent: {warning}");
        }
        let skills: Arc<[WorkspaceSkill]> = workspace_skills.skills.into();
        let prompt_text = context.prompt.trim();
        if prompt_text.is_empty() && context.prompt_attachments.is_empty() {
            return Err(anyhow!("run does not contain a user prompt"));
        }
        let mut prompt_contents = Vec::new();
        if !prompt_text.is_empty() {
            prompt_contents.push(UserContent::text(prompt_text));
        }
        for attachment in &context.prompt_attachments {
            prompt_contents.push(UserContent::image_url(
                attachment.url.clone(),
                Some(image_media_type(&attachment.media_type)?),
                None,
            ));
        }
        let prompt = Message::User {
            content: OneOrMany::many(prompt_contents)
                .map_err(|_| anyhow!("run prompt content cannot be empty"))?,
        };
        let provider = AgentProvider::default_for_run(&runtime, &context, &run_id, &claim_id);
        let prior_history = deserialize_agent_history(context.agent_history)?;
        let preamble =
            build_workspace_preamble(&request.workspace_path, &workspace_instructions, &skills);
        Ok((prompt, provider, prior_history, preamble, skills))
    })();

    let (prompt, provider, prior_history, preamble, skills) = match prepared {
        Ok(values) => values,
        Err(error) => return abort_before_start(&runtime, &run_id, error).await,
    };

    if let Err(error) = runtime.begin_assistant_message(&run_id).await {
        return abort_before_start(&runtime, &run_id, error).await;
    }
    eprintln!("sprocket-agent: prepared assistant response {}", run_id);

    let Some(lease_started_at) = claim_run(&runtime, &run_id, &claim_id).await? else {
        return Ok(());
    };

    eprintln!(
        "sprocket-agent: selected provider {} for run {}",
        provider.kind().as_str(),
        run_id
    );

    match timeout(RUN_CLAIM_ATTEMPT_TIMEOUT, runtime.run_finished(&run_id)).await {
        Ok(Ok(false)) => {}
        Ok(Ok(true)) => return Ok(()),
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
                    run_id: run_id.clone(),
                    claim_id: claim_id.clone(),
                    prompt,
                    preamble,
                    prior_history,
                    workspace_root,
                    skills,
                    model,
                    reasoning_effort,
                    service_tier,
                    context_budget,
                },
            )
            .await;

        finalize_provider_result(&runtime, &run_id, &claim_id, provider_result).await
    })
    .await
    {
        Ok(result) => result,
        Err(error) => {
            // A renewal tick can race the operation's own finalization: if the
            // run already reached a terminal state server-side, there is
            // nothing to abort and the lease error must not be reported as a
            // failure.
            match runtime.run_finished(&run_id).await {
                Ok(true) => Ok(()),
                _ => abort_after_claim(&runtime, &run_id, &claim_id, error).await,
            }
        }
    }
}

fn collapse_whitespace(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn image_media_type(media_type: &str) -> anyhow::Result<ImageMediaType> {
    match media_type {
        "image/jpeg" => Ok(ImageMediaType::JPEG),
        "image/png" => Ok(ImageMediaType::PNG),
        "image/gif" => Ok(ImageMediaType::GIF),
        "image/webp" => Ok(ImageMediaType::WEBP),
        _ => Err(anyhow!("unsupported image media type: {media_type}")),
    }
}

#[cfg(test)]
mod tests {
    use sprocket_workspace::{SkillSource, WorkspaceSkill};

    use super::build_workspace_preamble;

    #[test]
    fn preamble_renders_skills_block() {
        let skills = [WorkspaceSkill {
            name: "pdf-processing".to_string(),
            description: "Handle PDFs".to_string(),
            source: SkillSource::BuiltIn {
                contents: "---\nname: pdf-processing\ndescription: Handle PDFs\n---\n",
            },
        }];
        let preamble = build_workspace_preamble("/tmp/project", &[], &skills);
        assert!(preamble.contains("## Skills"));
        assert!(preamble.contains("<SKILLS>"));
        assert!(preamble.contains("- name: pdf-processing"));
        assert!(preamble.contains("description: Handle PDFs"));
        assert!(!preamble.contains("No skills are installed."));
    }

    #[test]
    fn preamble_renders_empty_skills_line() {
        let preamble = build_workspace_preamble("/tmp/project", &[], &[]);
        assert!(preamble.contains("## Skills"));
        assert!(preamble.contains("No skills are installed."));
        assert!(!preamble.contains("<SKILLS>"));
    }

    #[test]
    fn preamble_collapses_multiline_skill_descriptions() {
        let skills = [WorkspaceSkill {
            name: "demo".to_string(),
            description: "Line one\nline two".to_string(),
            source: SkillSource::BuiltIn {
                contents: "---\nname: demo\ndescription: Line one\n---\n",
            },
        }];
        let preamble = build_workspace_preamble("/tmp/project", &[], &skills);
        assert!(preamble.contains("description: Line one line two"));
        assert!(!preamble.contains("description: Line one\n"));
    }
}

#[cfg(test)]
mod claim_lease_tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    use anyhow::anyhow;
    use tokio::time::{Instant, sleep};

    use super::{
        RUN_CLAIM_EXPIRY_SAFETY_MARGIN, RUN_CLAIM_LEASE_DURATION, RUN_CLAIM_RENEW_ATTEMPT_TIMEOUT,
        RUN_CLAIM_RENEW_INTERVAL, drive_claim_lease, renew_claim_with,
    };

    /// Regression: a renewal tick that fires late because the task was
    /// starved (CPU saturation, slow reconnect) must not fail an otherwise
    /// healthy run. The first renewal below takes longer than the renew
    /// interval, pushing the next tick past the point where a conservative
    /// local pre-check would refuse to renew.
    #[tokio::test(start_paused = true)]
    async fn scheduling_stall_after_a_successful_renewal_does_not_fail_the_run() {
        let renewals = AtomicUsize::new(0);
        let result = drive_claim_lease(
            "run-stalled-tick",
            Instant::now(),
            |_lease_deadline| {
                let attempt = renewals.fetch_add(1, Ordering::SeqCst);
                let request_started_at = Instant::now();
                async move {
                    if attempt == 0 {
                        sleep(RUN_CLAIM_RENEW_INTERVAL + Duration::from_secs(25)).await;
                    }
                    Ok((true, request_started_at))
                }
            },
            async {
                sleep(Duration::from_secs(50)).await;
                "done"
            },
        )
        .await;
        assert_eq!(result.ok(), Some("done"));
        assert!(renewals.load(Ordering::SeqCst) >= 2);
    }

    /// The local lease deadline is only an estimate; when a stall pushes a
    /// renewal tick past it, the renewal must still be attempted and the
    /// server decides whether the lease is still owned.
    #[tokio::test(start_paused = true)]
    async fn renewal_is_attempted_after_the_estimated_lease_deadline() {
        let renewals = AtomicUsize::new(0);
        let result = drive_claim_lease(
            "run-past-estimated-deadline",
            Instant::now(),
            |_lease_deadline| {
                let attempt = renewals.fetch_add(1, Ordering::SeqCst);
                let request_started_at = Instant::now();
                async move {
                    if attempt == 0 {
                        sleep(RUN_CLAIM_LEASE_DURATION + Duration::from_secs(10)).await;
                    }
                    Ok((true, request_started_at))
                }
            },
            async {
                sleep(Duration::from_secs(100)).await;
                "done"
            },
        )
        .await;
        assert_eq!(result.ok(), Some("done"));
        assert!(renewals.load(Ordering::SeqCst) >= 2);
    }

    #[tokio::test(start_paused = true)]
    async fn renewal_failures_retry_until_the_lease_window_closes() {
        let attempts = AtomicUsize::new(0);
        let started_at = Instant::now();
        let result = renew_claim_with("run-flaky", started_at + RUN_CLAIM_LEASE_DURATION, || {
            attempts.fetch_add(1, Ordering::SeqCst);
            async {
                sleep(RUN_CLAIM_RENEW_ATTEMPT_TIMEOUT).await;
                Err(anyhow!("claim renewal timed out"))
            }
        })
        .await;
        let error = result.unwrap_err().to_string();
        assert!(error.contains("initial attempt failed"), "{error}");
        // Keeps renewing while another attempt can still land before the
        // lease deadline.
        assert!(attempts.load(Ordering::SeqCst) >= 3);
        // ...but not past the point where another attempt could not land
        // before it.
        assert!(
            Instant::now()
                >= started_at + RUN_CLAIM_LEASE_DURATION
                    - RUN_CLAIM_RENEW_ATTEMPT_TIMEOUT
                    - RUN_CLAIM_EXPIRY_SAFETY_MARGIN
        );
        assert!(Instant::now() <= started_at + RUN_CLAIM_LEASE_DURATION);
    }

    #[tokio::test(start_paused = true)]
    async fn lost_lease_is_not_retried() {
        let attempts = AtomicUsize::new(0);
        let result = renew_claim_with(
            "run-lost",
            Instant::now() + RUN_CLAIM_LEASE_DURATION,
            || {
                attempts.fetch_add(1, Ordering::SeqCst);
                async { Ok((false, Instant::now())) }
            },
        )
        .await;
        assert_eq!(result.ok().map(|(renewed, _)| renewed), Some(false));
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn drive_fails_the_run_when_the_lease_is_lost() {
        let result: anyhow::Result<()> = drive_claim_lease(
            "run-taken-over",
            Instant::now(),
            |_lease_deadline| async { Ok((false, Instant::now())) },
            std::future::pending(),
        )
        .await;
        let error = result.unwrap_err().to_string();
        assert!(error.contains("was lost"), "{error}");
    }
}
