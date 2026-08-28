use anyhow::anyhow;
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

use crate::catalog::context_budget_for_model;
use crate::convex::{FailedStartCleanup, RuntimeClient};
use crate::live::LiveCompletionHub;
use crate::provider::{AgentProvider, AgentProviderRequest, AgentProviderResult};
use crate::transcript::{
    TranscriptStore, agent_history_from_parts, apply_remote_state, current_run_has_finished_turns,
    fetch_missing_parts, fetch_parts_by_numbers,
};
use crate::types::{RunAgentRequest, RunContextResponse, deserialize_agent_history};

// Keep RUN_CLAIM_LEASE_DURATION synchronized with
// apps/web/src/convex/lib/runLease.ts (RUN_CLAIM_LEASE_DURATION_MS).
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
/// apps/web/src/convex/agentRuntime.ts ("Submission belongs to a different ...").
const SUBMISSION_OWNED_BY_ANOTHER_EXECUTOR: &str = "Submission belongs to a different";
const CONTINUE_FROM_FINISHED_TURNS: &str = "Continue from the last finished turn.";

fn submission_owned_by_another_executor(error: &str) -> bool {
    error.contains(SUBMISSION_OWNED_BY_ANOTHER_EXECUTOR)
}

pub struct AgentRun {
    request: RunAgentRequest,
    runtime: RuntimeClient,
    run_id: String,
    claim_id: String,
    workspace_root: std::path::PathBuf,
    gateway_url: String,
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
        "#### Writing Comments",
        "",
        "Comments are never absolutely necessary.",
        "Be extremely judicious with writing comments, prefer less in both amount and size.",
        "Don't write comments that just narrate what the code does. Comments should only explain non-obvious intent, constraints, or trade-offs.",
        "Instead of writing comments, prefer having clear naming and structure in the code.",
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
        "Prefer `web_search` and `scrape_url` over the browser tools (`browser_act`, `browser_observe`, `browser_extract`) whenever the information you need is publicly accessible — they are far cheaper and faster. Reserve the browser tools for interactive or session-bound pages such as merchant checkouts.",
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

/// Re-claims the run with the same claim after a lease lapse; the server
/// accepts only if nobody else took over.
async fn reclaim_run_once(
    runtime: &RuntimeClient,
    run_id: &str,
    claim_id: &str,
) -> anyhow::Result<(bool, Instant)> {
    let request_started_at = Instant::now();
    timeout(
        RUN_CLAIM_ATTEMPT_TIMEOUT,
        runtime.start_run(run_id, claim_id),
    )
    .await
    .map_err(|_| anyhow!("reclaim attempt timed out"))?
    .map(|start| (start.claimed, request_started_at))
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
/// renewals are attempted even past the conservative local deadline estimate,
/// and a reported loss is retried once via re-claim before giving up.
///
/// Only claim/lease failures are returned as `Err`; the operation's value
/// (including its own errors) is wrapped in `Ok`.
async fn drive_claim_lease<R, RFut, C, CFut, F, T>(
    run_id: &str,
    lease_started_at: Instant,
    mut renew: R,
    mut reclaim: C,
    operation: F,
) -> anyhow::Result<T>
where
    R: FnMut(Instant) -> RFut,
    RFut: Future<Output = anyhow::Result<(bool, Instant)>>,
    C: FnMut() -> CFut,
    CFut: Future<Output = anyhow::Result<(bool, Instant)>>,
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
                        match reclaim().await {
                            Ok((true, reclaim_started_at)) => {
                                eprintln!(
                                    "sprocket-agent: re-claimed run {run_id} after the claim lease lapsed"
                                );
                                lease_deadline = reclaim_started_at + RUN_CLAIM_LEASE_DURATION;
                                next_renewal_at = reclaim_started_at + RUN_CLAIM_RENEW_INTERVAL;
                            }
                            Ok((false, _)) => {
                                return Err(anyhow!("claim lease for run {run_id} was lost"));
                            }
                            Err(error) => return Err(error),
                        }
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
        || reclaim_run_once(runtime, run_id, claim_id),
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
    runtime.client.clear_auth().await;
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
}

async fn load_prior_history(
    runtime: &RuntimeClient,
    store: &TranscriptStore,
    context: &RunContextResponse,
    run_id: &str,
) -> anyhow::Result<PriorHistory> {
    let user_id = &context.run.user_id;
    let thread_id = &context.run.thread_id;
    let remote = runtime.transcript_state_for_run(run_id).await?;
    apply_remote_state(store, user_id, thread_id, &remote, false).await?;
    fetch_missing_parts(
        store,
        user_id,
        thread_id,
        remote.history_from_number,
        remote.total_parts,
        |numbers| {
            let runtime = runtime.clone();
            let run_id = run_id.to_string();
            async move { runtime.transcript_parts_for_run(&run_id, &numbers).await }
        },
    )
    .await?;
    let state = store.load_state(user_id, thread_id).await?;
    let numbers: Vec<u32> = (state.history_from_number..state.remote_total_parts).collect();
    let local_parts = store.read_parts(user_id, thread_id, &numbers).await?;
    let missing = numbers
        .iter()
        .filter(|number| !local_parts.iter().any(|part| part.number == **number))
        .copied()
        .collect::<Vec<_>>();
    if !missing.is_empty() {
        anyhow::bail!(
            "required transcript parts {:?} are missing locally after sync",
            missing
        );
    }
    let parts = match fetch_parts_by_numbers(&numbers, |batch| {
        let runtime = runtime.clone();
        let run_id = run_id.to_string();
        async move { runtime.transcript_parts_for_run(&run_id, &batch).await }
    })
    .await
    {
        Ok(hydrated)
            if numbers
                .iter()
                .all(|number| hydrated.iter().any(|part| part.number == *number)) =>
        {
            hydrated
        }
        Ok(_) | Err(_) => local_parts,
    };
    Ok(PriorHistory {
        messages: deserialize_agent_history(agent_history_from_parts(
            &state,
            &parts,
            Some(run_id),
        ))?,
        continue_from_finished_turns: current_run_has_finished_turns(&parts, run_id),
    })
}

pub async fn run_agent(run: AgentRun, live: Arc<LiveCompletionHub>) -> anyhow::Result<()> {
    let AgentRun {
        request,
        runtime,
        run_id,
        claim_id,
        workspace_root,
        gateway_url,
    } = run;

    let context: RunContextResponse = match runtime.run_context(&run_id).await {
        Ok(context) => context,
        Err(error) => return abort_before_start(&runtime, &run_id, error).await,
    };
    eprintln!("sprocket-agent: loaded run context {}", run_id);

    let model = context.run.selected_model.clone();
    let reasoning_effort = context.run.reasoning_effort.clone();
    let service_tier = context.run.service_tier.clone();
    let context_budget = match context_budget_for_model(&gateway_url, &model).await {
        Ok(budget) => budget,
        Err(error) => return abort_before_start(&runtime, &run_id, error).await,
    };

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
            content: prompt_contents,
        };
        let provider = AgentProvider::default_for_run(&context, &gateway_url);
        let preamble =
            build_workspace_preamble(&request.workspace_path, &workspace_instructions, &skills);
        Ok((prompt, provider, preamble, skills))
    })();

    let (prompt, provider, preamble, skills) = match prepared {
        Ok(values) => values,
        Err(error) => return abort_before_start(&runtime, &run_id, error).await,
    };
    let store = TranscriptStore::new(request.transcript_root.clone());
    let prior_history = match load_prior_history(&runtime, &store, &context, &run_id).await {
        Ok(history) => history,
        Err(error) => return abort_before_start(&runtime, &run_id, error).await,
    };
    let prompt = if prior_history.continue_from_finished_turns {
        Message::User {
            content: vec![UserContent::text(CONTINUE_FROM_FINISHED_TURNS)],
        }
    } else {
        prompt
    };

    if let Err(error) = runtime.begin_assistant_message(&run_id).await {
        return abort_before_start(&runtime, &run_id, error).await;
    }
    eprintln!("sprocket-agent: prepared assistant response {}", run_id);

    let Some(lease_started_at) = claim_run(&runtime, &run_id, &claim_id).await? else {
        return Ok(());
    };

    eprintln!("sprocket-agent: selected provider gateway for run {run_id}");

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
                    thread_id: request.thread_id.clone(),
                    run_started_at: context.run.started_at,
                    live: live.clone(),
                    prompt,
                    preamble,
                    prior_history: prior_history.messages,
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
            // A renewal tick can race the operation's own finalization; a run
            // that already finished server-side must not be reported as failed.
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

    use super::{build_workspace_preamble, submission_owned_by_another_executor};

    #[test]
    fn submission_conflict_errors_match_the_convex_sentinel() {
        assert!(submission_owned_by_another_executor(
            "agentRuntime:createGatewayRun failed: Submission belongs to a different active executor."
        ));
        assert!(submission_owned_by_another_executor(
            "Submission belongs to a different or incomplete run."
        ));
        assert!(!submission_owned_by_another_executor(
            "timed out starting agent run"
        ));
        assert!(!submission_owned_by_another_executor(
            "Submission prompt does not match the existing run."
        ));
    }

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

    async fn reclaim_refused() -> anyhow::Result<(bool, Instant)> {
        Ok((false, Instant::now()))
    }

    /// Regression: a starved renewal tick (CPU saturation, slow reconnect)
    /// must not fail an otherwise healthy run.
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
            reclaim_refused,
            async {
                sleep(Duration::from_secs(50)).await;
                "done"
            },
        )
        .await;
        assert_eq!(result.ok(), Some("done"));
        assert!(renewals.load(Ordering::SeqCst) >= 2);
    }

    /// The local deadline is only an estimate; a renewal tick pushed past it
    /// must still be attempted.
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
            reclaim_refused,
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
        // lease deadline, then stops.
        assert!(attempts.load(Ordering::SeqCst) >= 3);
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
            reclaim_refused,
            std::future::pending(),
        )
        .await;
        let error = result.unwrap_err().to_string();
        assert!(error.contains("was lost"), "{error}");
    }

    /// After a lease lapse with no takeover, the same claim re-`start`s and
    /// the run continues.
    #[tokio::test(start_paused = true)]
    async fn reclaimed_lease_resumes_renewals() {
        let renewals = AtomicUsize::new(0);
        let reclaims = AtomicUsize::new(0);
        let result = drive_claim_lease(
            "run-reclaim",
            Instant::now(),
            |_lease_deadline| {
                let attempt = renewals.fetch_add(1, Ordering::SeqCst);
                let request_started_at = Instant::now();
                async move {
                    if attempt == 0 {
                        return Ok((false, request_started_at));
                    }
                    Ok((true, request_started_at))
                }
            },
            || {
                reclaims.fetch_add(1, Ordering::SeqCst);
                async { Ok((true, Instant::now())) }
            },
            async {
                // Outlasts two renewal intervals so a post-reclaim renewal happens first.
                sleep(Duration::from_secs(100)).await;
                "done"
            },
        )
        .await;
        assert_eq!(result.ok(), Some("done"));
        assert_eq!(reclaims.load(Ordering::SeqCst), 1);
        assert!(renewals.load(Ordering::SeqCst) >= 2);
    }

    #[tokio::test(start_paused = true)]
    async fn drive_fails_the_run_when_the_reclaim_fails() {
        let result: anyhow::Result<()> = drive_claim_lease(
            "run-reclaim-unreachable",
            Instant::now(),
            |_lease_deadline| async { Ok((false, Instant::now())) },
            || async { Err(anyhow!("reclaim attempt timed out")) },
            std::future::pending(),
        )
        .await;
        let error = result.unwrap_err().to_string();
        assert!(error.contains("reclaim attempt timed out"), "{error}");
    }
}
