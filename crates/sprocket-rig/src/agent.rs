use anyhow::anyhow;
use rig::client::CompletionClient;
use rig::completion::Prompt;
use sprocket_core::{
    WorkspaceInstruction, WorkspaceOverview, build_workspace_overview, load_workspace_instructions,
    resolve_workspace_root,
};

use crate::runtime::RuntimeClient;
use crate::tools::workspace_tools;
use crate::types::{RunAgentRequest, ThreadMessageSnapshot};

const AGENT_MAX_TURNS: usize = 75;

fn build_workspace_preamble(
    workspace_path: &str,
    workspace_overview: &WorkspaceOverview,
    workspace_instructions: &[WorkspaceInstruction],
) -> String {
    let top_level_entries = if workspace_overview.top_level_entries.is_empty() {
        "none".to_string()
    } else {
        workspace_overview
            .top_level_entries
            .iter()
            .map(|entry| format!("{} ({})", entry.name, entry.kind))
            .collect::<Vec<_>>()
            .join(", ")
    };
    let recent_files = if workspace_overview.recent_files.is_empty() {
        "none".to_string()
    } else {
        workspace_overview.recent_files.join(", ")
    };
    let instruction_block = if workspace_instructions.is_empty() {
        "No AGENTS.md instructions were preloaded for the current workspace.".to_string()
    } else {
        format!(
            "# AGENTS.md instructions: \n\n<INSTRUCTIONS>\n{}\n</INSTRUCTIONS>",
            workspace_instructions
                .iter()
                .map(|instruction| instruction.contents.as_str())
                .collect::<Vec<_>>()
                .join("\n\n")
        )
    };

    [
        "You are a coding agent operating in the user’s real local workspace.",
        "Behave like a careful senior software engineer: inspect before editing, prefer root-cause fixes, and keep changes tightly scoped to the user request.",
        "When feasible, persist until the task is handled end-to-end. Do not stop at analysis if the user is asking for implementation.",
        "Do not guess about repository state or file contents.",
        "Fix the underlying problem when practical instead of applying surface-level patches.",
        "Do not try to fix unrelated bugs, broken tests, or unrelated files unless the user asked for that work.",
        "If the workspace is already dirty, protect user changes and work around them rather than reverting them.",
        "Validate your work when the repo has relevant tests or build checks. Start with the most targeted checks for the code you changed.",
        "",
        &format!("Workspace root: {}", workspace_path),
        "Workspace summary:",
        &format!("- Name: {}", workspace_overview.name),
        &format!(
            "- Git branch: {}",
            workspace_overview.git_branch.as_deref().unwrap_or("unknown")
        ),
        &format!(
            "- Git dirty: {}",
            if workspace_overview.git_dirty {
                "yes"
            } else {
                "no"
            }
        ),
        &format!("- Top level entries: {}", top_level_entries),
        &format!("- Recent files: {}", recent_files),
        "",
        &instruction_block,
    ]
    .join("\n")
}

fn build_prompt(messages: &[ThreadMessageSnapshot]) -> anyhow::Result<String> {
    let latest_user_index = messages
        .iter()
        .rposition(|message| message.role == "user" && !message.text.trim().is_empty())
        .ok_or_else(|| anyhow!("run does not contain a user prompt"))?;

    let history = messages[..latest_user_index]
        .iter()
        .filter(|message| !message.text.trim().is_empty())
        .map(|message| {
            let role = if message.role == "assistant" {
                "Assistant"
            } else {
                "User"
            };
            format!("{role}:\n{}", message.text.trim())
        })
        .collect::<Vec<_>>()
        .join("\n\n");

    let current_prompt = messages[latest_user_index].text.trim();

    if history.is_empty() {
        Ok(current_prompt.to_string())
    } else {
        Ok(format!(
            "Conversation so far:\n{history}\n\nCurrent user request:\n{current_prompt}"
        ))
    }
}

pub async fn run_agent(request: RunAgentRequest) -> anyhow::Result<()> {
    eprintln!("sprocket-rig: starting run {}", request.run_id);
    let runtime = RuntimeClient::from_request(&request).await?;
    let context = runtime.run_context(&request.run_id).await?;
    eprintln!("sprocket-rig: loaded run context {}", request.run_id);
    let workspace_root = resolve_workspace_root(&context.workspace_session.workspace_path)?;

    runtime.start_run(&request.run_id).await?;
    eprintln!("sprocket-rig: marked run running {}", request.run_id);

    let assistant_message_id = runtime.begin_assistant_message(&request.run_id).await?;
    eprintln!(
        "sprocket-rig: created assistant message {}",
        assistant_message_id
    );

    let workspace_overview = build_workspace_overview(&workspace_root)?;
    let workspace_instructions = load_workspace_instructions(&workspace_root)?;
    let prompt = build_prompt(&context.messages)?;
    let preamble = build_workspace_preamble(
        &context.workspace_session.workspace_path,
        &workspace_overview,
        &workspace_instructions,
    );

    let completion_client = runtime
        .client
        .clone()
        .with_reasoning_effort(context.run.reasoning_effort.clone());

    let tools = workspace_tools(
        runtime.clone(),
        request.run_id.clone(),
        workspace_root.clone(),
    );
    let agent = completion_client
        .agent(context.run.selected_model.clone())
        .preamble(&preamble)
        .tool(tools.read_file)
        .tool(tools.create_file)
        .tool(tools.replace_in_file)
        .build();
    eprintln!("sprocket-rig: built rig agent {}", request.run_id);

    if runtime.run_finished(&request.run_id).await? {
        return Ok(());
    }

    eprintln!("sprocket-rig: prompting model {}", request.run_id);
    match agent.prompt(prompt).max_turns(AGENT_MAX_TURNS).await {
        Ok(response) => {
            eprintln!("sprocket-rig: model completed {}", request.run_id);
            runtime
                .finish_assistant_message(&assistant_message_id, &response, "success")
                .await?;
            runtime
                .finish_run(&request.run_id, "completed", None)
                .await?;
            Ok(())
        }
        Err(error) => {
            let error_text = error.to_string();
            eprintln!(
                "sprocket-rig: model failed {}: {}",
                request.run_id, error_text
            );
            runtime
                .finish_assistant_message(&assistant_message_id, "", "failed")
                .await?;
            runtime
                .finish_run(&request.run_id, "failed", Some(&error_text))
                .await?;
            Err(anyhow!(error))
        }
    }
}
