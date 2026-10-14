mod artifacts;
mod async_tools;
mod commands;
mod context;
mod cwd;
mod firecrawl;
mod github_url;
mod hosted_parse;
mod job;
mod mandates;
mod markdown_url;
mod parse_file;
mod patch;
mod questions;
mod scrape_files;
mod skills;
mod subagents;
mod web;

use std::path::PathBuf;
use std::sync::Arc;

use sprocket_workspace::{CommandSessionManager, WorkspaceSkill};

use self::artifacts::{
    AddArtifactTool, DeleteArtifactTool, EditArtifactTool, ListArtifactsTool, SaveArtifactTool,
};
use self::commands::{ControlCmdTool, ExecCmdTool, PollCmdTool};
use self::context::{AgentToolContext, WorkingDirectory};
use self::cwd::SetCwdTool;
pub(crate) use self::cwd::working_directory_message;
use self::mandates::{
    MandateChargeTool, MandateListTool, MandateReportTool, MandateSetupTool, MandateStatusTool,
};
use self::parse_file::ParseFileTool;
use self::patch::ApplyPatchTool;
use self::questions::{AskQuestionTool, PollQuestionTool};
use self::skills::ReadSkillTool;
use self::subagents::{
    ControlSubagentTool, ListSubagentModelsTool, ListSubagentsTool, PollSubagentTool,
    SpawnSubagentTool,
};
use self::web::{ScrapeUrlTool, ScreenshotUrlTool, WebSearchTool};
use crate::convex::RuntimeClient;
use crate::hooks::ToolCallTracker;

// Helpers/constants brought into this module so `tests` can reach them via `super::*`.
#[cfg(test)]
use self::context::tool_error;
#[cfg(test)]
use self::job::mutation_args_from_payload;
#[cfg(test)]
use self::questions::{
    AGENT_DECIDE_OPTION_ID, AskQuestionArgs, AskQuestionOption, MAX_QUESTION_CHARS,
    prepare_ask_question,
};
#[cfg(test)]
use self::skills::resolve_read_skill;
#[cfg(test)]
use sprocket_workspace::async_tools::DEFAULT_YIELD_MS;

pub(crate) struct AgentToolSet {
    pub(crate) apply_patch: ApplyPatchTool,
    pub(crate) ask_question: AskQuestionTool,
    pub(crate) poll_question: PollQuestionTool,
    pub(crate) control_cmd: ControlCmdTool,
    pub(crate) exec_cmd: ExecCmdTool,
    pub(crate) control_subagent: ControlSubagentTool,
    pub(crate) list_subagent_models: ListSubagentModelsTool,
    pub(crate) list_subagents: ListSubagentsTool,
    pub(crate) parse_file: ParseFileTool,
    pub(crate) poll_cmd: PollCmdTool,
    pub(crate) read_skill: ReadSkillTool,
    pub(crate) scrape_url: ScrapeUrlTool,
    pub(crate) screenshot_url: ScreenshotUrlTool,
    pub(crate) spawn_subagent: SpawnSubagentTool,
    pub(crate) poll_subagent: PollSubagentTool,
    pub(crate) web_search: WebSearchTool,
    pub(crate) add_artifact: AddArtifactTool,
    pub(crate) list_artifacts: ListArtifactsTool,
    pub(crate) edit_artifact: EditArtifactTool,
    pub(crate) save_artifact: SaveArtifactTool,
    pub(crate) delete_artifact: DeleteArtifactTool,
    pub(crate) set_cwd: SetCwdTool,
    pub(crate) cwd: WorkingDirectory,
    pub(crate) mandate_setup: MandateSetupTool,
    pub(crate) mandate_status: MandateStatusTool,
    pub(crate) mandate_list: MandateListTool,
    pub(crate) mandate_charge: MandateChargeTool,
    pub(crate) mandate_report: MandateReportTool,
}

pub(crate) async fn hydrate_tool_history(
    history: &mut [crate::types::AgentHistoryMessage],
    parts: &[crate::transcript::TranscriptPart],
    supports_images: bool,
) {
    use crate::types::{AgentHistoryContent, AgentHistoryToolResultItem};
    let mut results = std::collections::HashMap::new();
    for tool in parts.iter().filter_map(|part| part.tool.as_ref()) {
        if (parse_file::is_parse_file_tool(&tool.name)
            || matches!(tool.name.as_str(), "scrape_url" | "screenshot_url"))
            && tool.status != "started"
        {
            results.entry(tool.call_id.as_str()).or_insert(tool);
        }
    }
    for message in history {
        for content in &mut message.contents {
            let AgentHistoryContent::ToolResult { id, items, .. } = content else {
                continue;
            };
            let Some(tool) = results.get(id.as_str()) else {
                continue;
            };
            if tool.status != "completed" {
                continue;
            }
            let Some(output) = &tool.output else { continue };
            let is_image =
                output.get("outputType").and_then(serde_json::Value::as_str) == Some("image");
            if !is_image && !parse_file::is_parse_file_tool(&tool.name) {
                continue;
            }
            if !supports_images && is_image {
                *items = vec![AgentHistoryToolResultItem::Text {
                    text: format!(
                        "Image omitted because the selected model does not support images. Original result: {output}"
                    ),
                }];
                continue;
            }
            *items = match parse_file::replay_local_tool_history_items(output).await {
                Ok(items) => items,
                Err(error) => vec![AgentHistoryToolResultItem::Text {
                    text: format!(
                        "Previous tool output is not available in the local cache: {error}. Original result: {output}"
                    ),
                }],
            };
        }
    }
}

pub(crate) fn agent_tools(
    runtime: RuntimeClient,
    run_id: String,
    claim_id: String,
    user_id: String,
    workspace_root: PathBuf,
    cwd: PathBuf,
    transcript_dir: PathBuf,
    gateway_url: String,
    transcript_store: Option<Arc<crate::TranscriptStore>>,
    artifact_bindings: crate::artifact_bindings::ArtifactBindings,
    supports_images: bool,
    tool_call_tracker: ToolCallTracker,
    skills: Arc<[WorkspaceSkill]>,
    command_sessions: CommandSessionManager,
    subagent_launcher: Option<crate::subagents::SharedSubagentLauncher>,
) -> AgentToolSet {
    let context = AgentToolContext {
        runtime,
        run_id,
        claim_id,
        user_id,
        workspace_root,
        cwd: WorkingDirectory::new(cwd),
        transcript_dir,
        gateway_url,
        transcript_store,
        artifact_bindings,
        supports_images,
        tool_call_tracker,
        command_sessions,
        question_polls: questions::QuestionPolls::default(),
        subagent_polls: subagents::SubagentPolls::default(),
        subagent_launcher,
    };
    AgentToolSet {
        apply_patch: ApplyPatchTool(context.clone()),
        ask_question: AskQuestionTool(context.clone()),
        poll_question: PollQuestionTool(context.clone()),
        control_cmd: ControlCmdTool(context.clone()),
        exec_cmd: ExecCmdTool(context.clone()),
        control_subagent: ControlSubagentTool {
            context: context.clone(),
        },
        list_subagent_models: ListSubagentModelsTool(context.clone()),
        list_subagents: ListSubagentsTool {
            context: context.clone(),
        },
        parse_file: ParseFileTool(context.clone()),
        poll_cmd: PollCmdTool(context.clone()),
        read_skill: ReadSkillTool {
            context: context.clone(),
            skills,
        },
        scrape_url: ScrapeUrlTool(context.clone()),
        screenshot_url: ScreenshotUrlTool(context.clone()),
        spawn_subagent: SpawnSubagentTool {
            context: context.clone(),
        },
        poll_subagent: PollSubagentTool {
            context: context.clone(),
        },
        web_search: WebSearchTool(context.clone()),
        add_artifact: AddArtifactTool(context.clone()),
        list_artifacts: ListArtifactsTool(context.clone()),
        edit_artifact: EditArtifactTool(context.clone()),
        save_artifact: SaveArtifactTool(context.clone()),
        delete_artifact: DeleteArtifactTool(context.clone()),
        set_cwd: SetCwdTool(context.clone()),
        cwd: context.cwd.clone(),
        mandate_setup: MandateSetupTool(context.clone()),
        mandate_status: MandateStatusTool(context.clone()),
        mandate_list: MandateListTool(context.clone()),
        mandate_charge: MandateChargeTool(context.clone()),
        mandate_report: MandateReportTool(context),
    }
}

#[cfg(test)]
mod tests;
