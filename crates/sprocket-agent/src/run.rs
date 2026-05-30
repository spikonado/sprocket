use anyhow::anyhow;
use sprocket_workspace::{
    WorkspaceInstruction, WorkspaceOverview, build_workspace_overview, load_workspace_instructions,
    resolve_workspace_root,
};

use crate::RunContextResponse;
use crate::convex::RuntimeClient;
use crate::provider::{AgentProvider, AgentProviderRequest, AgentProviderResult};
use crate::types::{RunAgentRequest, deserialize_agent_history};

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

async fn fail_run_early(
    runtime: &RuntimeClient,
    run_id: &str,
    error: &anyhow::Error,
) -> anyhow::Result<()> {
    runtime
        .finish_run(run_id, "failed", Some(&error.to_string()))
        .await?;
    Ok(())
}

async fn fail_run_setup(
    runtime: &RuntimeClient,
    run_id: &str,
    error: &anyhow::Error,
) -> anyhow::Result<()> {
    let message = format!("Run failed before the model started: {error}");
    let assistant_error = runtime.finish_assistant_message(run_id, &message).await;
    let finish_error = runtime
        .finish_run(run_id, "failed", Some(&error.to_string()))
        .await;

    match (assistant_error, finish_error) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(assistant_error), Ok(())) => Err(assistant_error),
        (Ok(()), Err(finish_error)) => Err(finish_error),
        (Err(assistant_error), Err(finish_error)) => Err(anyhow!(
            "failed to finish assistant message: {assistant_error}; failed to mark run failed: {finish_error}"
        )),
    }
}

pub async fn run_agent(request: RunAgentRequest) -> anyhow::Result<()> {
    eprintln!("sprocket-agent: starting thread {}", request.thread_id);
    let runtime: RuntimeClient = RuntimeClient::from_request(&request).await?;
    let workspace_root = resolve_workspace_root(&request.workspace_path)?;

    let created_run = runtime.create_run(&request).await?;
    let run_id = created_run.run_id;
    eprintln!("sprocket-agent: created run {}", run_id);

    let context: RunContextResponse = match runtime.run_context(&run_id).await {
        Ok(context) => context,
        Err(error) => {
            fail_run_early(&runtime, &run_id, &error).await?;
            return Err(error);
        }
    };
    eprintln!("sprocket-agent: loaded run context {}", run_id);

    if let Err(error) = runtime.start_run(&run_id).await {
        fail_run_early(&runtime, &run_id, &error).await?;
        return Err(error);
    }
    eprintln!("sprocket-agent: marked run running {}", run_id);

    if let Err(error) = runtime.begin_assistant_message(&run_id).await {
        fail_run_setup(&runtime, &run_id, &error).await?;
        return Err(error);
    }
    eprintln!("sprocket-agent: prepared assistant response {}", run_id);

    let prepared = (|| {
        let workspace_overview = build_workspace_overview(&workspace_root)?;
        let workspace_instructions = load_workspace_instructions(&workspace_root)?;
        let prompt = context.prompt.trim().to_string();
        if prompt.is_empty() {
            return Err(anyhow!("run does not contain a user prompt"));
        }
        let provider = AgentProvider::default_for_run(&runtime, &request, &context, &run_id);
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
        Err(error) => {
            fail_run_setup(&runtime, &run_id, &error).await?;
            return Err(error);
        }
    };

    eprintln!(
        "sprocket-agent: selected provider {} for run {}",
        provider.kind().as_str(),
        run_id
    );

    if runtime.run_finished(&run_id).await? {
        return Ok(());
    }

    let provider_result = provider
        .run(
            runtime.clone(),
            AgentProviderRequest {
                run_id: run_id.clone(),
                prompt,
                preamble,
                prior_history,
                workspace_root,
            },
        )
        .await;

    let final_text = match provider_result {
        AgentProviderResult::Completed { text } => text,
        AgentProviderResult::Cancelled { text } => {
            if runtime.run_finished(&run_id).await? {
                return Ok(());
            }
            eprintln!("sprocket-agent: run cancelled {}", run_id);
            runtime.finish_assistant_message(&run_id, &text).await?;
            runtime.finish_run(&run_id, "cancelled", None).await?;
            return Ok(());
        }
        AgentProviderResult::Failed { text, error } => {
            if runtime.run_finished(&run_id).await? {
                return Ok(());
            }
            let error_text = error.to_string();
            eprintln!("sprocket-agent: model failed {}: {}", run_id, error_text);
            runtime.finish_assistant_message(&run_id, &text).await?;
            runtime
                .finish_run(&run_id, "failed", Some(&error_text))
                .await?;
            return Err(error);
        }
    };

    if runtime.run_finished(&run_id).await? {
        eprintln!(
            "sprocket-agent: run finished before completion finalization {}",
            run_id
        );
        runtime
            .finish_assistant_message(&run_id, &final_text)
            .await?;
        return Ok(());
    }

    eprintln!("sprocket-agent: model completed {}", run_id);
    runtime
        .finish_assistant_message(&run_id, &final_text)
        .await?;
    runtime.finish_run(&run_id, "completed", None).await?;
    Ok(())
}
