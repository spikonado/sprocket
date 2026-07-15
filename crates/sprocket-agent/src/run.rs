use anyhow::anyhow;
use sprocket_workspace::{
    WorkspaceInstruction, WorkspaceOverview, build_workspace_overview, load_workspace_instructions,
    resolve_workspace_root,
};
use std::future::Future;
use std::time::Duration;
use tokio::time::{Instant, MissedTickBehavior, sleep, timeout};
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
const RUN_CLAIM_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(8);
const FAILURE_CLEANUP_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(5);
const START_FAILURE_CLEANUP_ATTEMPT_TIMEOUT: Duration = Duration::from_millis(2_500);
const FAILURE_CLEANUP_RETRY_DELAY: Duration = Duration::from_millis(250);

pub struct AgentRun {
    request: RunAgentRequest,
    runtime: RuntimeClient,
    run_id: String,
    user_id: String,
    claim_id: String,
    workspace_root: std::path::PathBuf,
}

impl AgentRun {
    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    pub fn user_id(&self) -> &str {
        &self.user_id
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
    workspace_overview: &WorkspaceOverview,
    workspace_instructions: &[WorkspaceInstruction],
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

    [
        "You are a coding agent operating in the user’s real local workspace.",
        "Persist until the task is handled end-to-end. Do not stop at analysis if the user is asking for implementation.",
        "Behave like a careful senior software engineer.",
        "Do not guess about repo state or file contents. Always inspect before editing.",
        "Fix the root-cause of problems.",
        "Keep changes minimal, consistent with the existing codebase, and completely focused on the requested task.",
        "If the workspace is already dirty, protect user changes and work around them rather than reverting them.",
        "Use commands for inspection, builds, tests, and formatting, but do not mutate files through shell redirection or destructive git commands.",
        "Validate your work when the repo has relevant tests or build checks. Start with the most targeted checks for the code you changed.",
        "When you finish, respond with a concise summary of what changed and which checks you ran.",
        "AGENTS.md spec:",
        "- AGENTS.md files can appear anywhere in the repository tree.",
        "- Each AGENTS.md file applies to the directory tree rooted at the folder that contains it.",
        "- For every file you change, follow all applicable AGENTS.md instructions, with deeper files taking precedence.",
        "- System and user instructions override AGENTS.md instructions.",
        "- The AGENTS.md instructions for the current workspace path are already included below and do not need to be re-read.",
        "- If you move into a deeper subdirectory before editing, check for additional nested AGENTS.md files there.",
        "",
        "Workspace root:",
        workspace_path,
        "Workspace summary:",
        &format!("- Name: {}", workspace_overview.name),
        &format!(
            "- Git branch: {}",
            workspace_overview.git_branch.as_deref().unwrap_or("unknown")
        ),
        &format!("- Git dirty: {}", workspace_overview.git_dirty),
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
    cleanup_twice(
        &format!("claim failure cleanup for run {run_id}"),
        FAILURE_CLEANUP_ATTEMPT_TIMEOUT,
        || runtime.finalize_claim_failure(run_id, claim_id, text, &last_error),
    )
    .await
    .map(|_| ())
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
        AgentProviderResult::Superseded => {
            eprintln!("sprocket-agent: provider attempt superseded {}", run_id);
            Ok(())
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

async fn renew_claim(
    runtime: &RuntimeClient,
    run_id: &str,
    claim_id: &str,
) -> anyhow::Result<(bool, Instant)> {
    match renew_claim_once(runtime, run_id, claim_id).await {
        Ok(outcome) => Ok(outcome),
        Err(first_error) => {
            eprintln!(
                "sprocket-agent: claim renewal failed for run {}; retrying: {}",
                run_id, first_error
            );
            renew_claim_once(runtime, run_id, claim_id)
                .await
                .map_err(|retry_error| {
                    anyhow!(
                        "failed to renew claim for run {run_id} after retry: {retry_error}; initial attempt failed: {first_error}"
                    )
                })
        }
    }
}

/// Runs `operation` while renewing the claim lease.
///
/// Only claim/lease failures are returned as `Err`; the operation's value
/// (including its own errors) is wrapped in `Ok`.
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
    let mut lease_deadline = lease_started_at + RUN_CLAIM_LEASE_DURATION;
    let mut renewals = tokio::time::interval_at(
        Instant::now() + RUN_CLAIM_RENEW_INTERVAL,
        RUN_CLAIM_RENEW_INTERVAL,
    );
    renewals.set_missed_tick_behavior(MissedTickBehavior::Delay);
    tokio::pin!(operation);

    loop {
        tokio::select! {
            biased;
            _ = renewals.tick() => {
                let renewal_budget = RUN_CLAIM_RENEW_ATTEMPT_TIMEOUT * 2
                    + RUN_CLAIM_EXPIRY_SAFETY_MARGIN;
                if Instant::now() + renewal_budget >= lease_deadline {
                    return Err(anyhow!("claim lease for run {run_id} cannot be renewed safely before expiry"));
                }
                match renew_claim(runtime, run_id, claim_id).await {
                    Ok((true, renewal_started_at)) => {
                        if Instant::now() + RUN_CLAIM_EXPIRY_SAFETY_MARGIN >= lease_deadline {
                            return Err(anyhow!("claim renewal for run {run_id} was not confirmed safely before expiry"));
                        }
                        lease_deadline = renewal_started_at + RUN_CLAIM_LEASE_DURATION;
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

pub async fn start_agent_run(request: RunAgentRequest) -> anyhow::Result<AgentRun> {
    eprintln!("sprocket-agent: starting thread {}", request.thread_id);
    let claim_id = Uuid::new_v4().to_string();
    let runtime: RuntimeClient = RuntimeClient::from_request(&request).await?;
    let workspace_root = resolve_workspace_root(&request.workspace_path)?;

    let created_run = runtime.create_run(&request).await?;
    if created_run.created {
        eprintln!("sprocket-agent: created run {}", created_run.run_id);
    } else {
        eprintln!(
            "sprocket-agent: resuming submission {} as run {}",
            request.submission_id, created_run.run_id
        );
    }
    let run_id = created_run.run_id;
    let user_id = created_run.user_id;

    Ok(AgentRun {
        request,
        runtime,
        run_id,
        user_id,
        claim_id,
        workspace_root,
    })
}

pub async fn finalize_failed_start(
    request: RunAgentRequest,
    startup_error: String,
) -> anyhow::Result<()> {
    let runtime = RuntimeClient::from_request(&request).await?;
    let text = format!("Run failed before the model started: {startup_error}");
    cleanup_twice(
        &format!(
            "startup failure cleanup for submission {}",
            request.submission_id
        ),
        START_FAILURE_CLEANUP_ATTEMPT_TIMEOUT,
        || runtime.finalize_failed_start(&request, &text, &startup_error),
    )
    .await
    .map(|_| ())
}

pub async fn run_agent(run: AgentRun) -> anyhow::Result<()> {
    let AgentRun {
        request,
        runtime,
        run_id,
        user_id: _,
        claim_id,
        workspace_root,
    } = run;

    let context: RunContextResponse = match runtime.run_context(&run_id).await {
        Ok(context) => context,
        Err(error) => return abort_before_start(&runtime, &run_id, error).await,
    };
    eprintln!("sprocket-agent: loaded run context {}", run_id);

    let prepared = (|| {
        let workspace_overview = build_workspace_overview(&workspace_root)?;
        let workspace_instructions = load_workspace_instructions(&workspace_root)?;
        let prompt = context.prompt.trim().to_string();
        if prompt.is_empty() {
            return Err(anyhow!("run does not contain a user prompt"));
        }
        let provider = AgentProvider::default_for_run(&runtime, &context, &run_id);
        let prior_history = deserialize_agent_history(context.agent_history)?;
        let preamble = build_workspace_preamble(
            &request.workspace_path,
            &workspace_overview,
            &workspace_instructions,
        );
        Ok((
            workspace_overview,
            workspace_instructions,
            prompt,
            provider,
            prior_history,
            preamble,
        ))
    })();

    let (_, _, prompt, provider, prior_history, preamble) = match prepared {
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
                },
            )
            .await;

        finalize_provider_result(&runtime, &run_id, &claim_id, provider_result).await
    })
    .await
    {
        Ok(result) => result,
        Err(error) => abort_after_claim(&runtime, &run_id, &claim_id, error).await,
    }
}
