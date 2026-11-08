mod artifacts;
mod async_tools;
mod commands;
mod context;
mod convert;
mod cwd;
mod github_url;
mod hosted_parse;
mod image_urls;
mod job;
mod markdown_url;
mod parse_file;
mod parts;
mod patch;
mod payments;
mod pdf_pages;
mod pull_requests;
mod questions;
mod scrape_files;
mod skills;
mod subagents;
mod url_fetch;
mod web;
mod web_request;

use std::path::PathBuf;
use std::sync::Arc;

use sprocket_workspace::{CommandSessionManager, WorkspaceSkill};

use self::artifacts::{BindArtifactTool, DeleteArtifactTool, ListArtifactsTool, SaveArtifactTool};
pub(crate) use self::async_tools::max_yield_ms;
pub(crate) use self::commands::CommandCursors;
use self::commands::{ControlCmdTool, ExecCmdTool, PollCmdTool};
use self::context::{AgentToolContext, WorkingDirectory};
use self::cwd::SetCwdTool;
pub(crate) use self::image_urls::ConvexImageUrls;
use self::image_urls::ImageUrlMap;
use self::parse_file::ParseFileTool;
use self::parts::LookupPartsTool;
use self::patch::ApplyPatchTool;
use self::payments::{CardCheckoutTool, PollCheckoutTool, ReportOrderTool};
use self::pull_requests::{LinkPrsTool, PollPrTool};
use self::questions::{AskQuestionTool, PollQuestionTool};
use self::skills::ReadSkillTool;
use self::subagents::{
    ControlSubagentTool, ListSubagentsTool, PollSubagentTool, SpawnSubagentTool,
};
use self::web::{ScrapeUrlTool, WebSearchTool};
use crate::convex::RuntimeClient;
use crate::hooks::ToolCallTracker;

pub(crate) struct AgentToolSet {
    pub(crate) apply_patch: ApplyPatchTool,
    pub(crate) ask_question: AskQuestionTool,
    pub(crate) poll_question: PollQuestionTool,
    pub(crate) control_cmd: ControlCmdTool,
    pub(crate) exec_cmd: ExecCmdTool,
    pub(crate) control_subagent: ControlSubagentTool,
    pub(crate) list_subagents: ListSubagentsTool,
    pub(crate) lookup_parts: LookupPartsTool,
    pub(crate) parse_file: ParseFileTool,
    pub(crate) poll_cmd: PollCmdTool,
    pub(crate) read_skill: ReadSkillTool,
    pub(crate) scrape_url: ScrapeUrlTool,
    pub(crate) spawn_subagent: SpawnSubagentTool,
    pub(crate) poll_subagent: PollSubagentTool,
    pub(crate) web_search: WebSearchTool,
    pub(crate) bind_artifact: BindArtifactTool,
    pub(crate) list_artifacts: ListArtifactsTool,
    pub(crate) save_artifact: SaveArtifactTool,
    pub(crate) delete_artifact: DeleteArtifactTool,
    pub(crate) set_cwd: SetCwdTool,
    pub(crate) link_prs: LinkPrsTool,
    pub(crate) poll_pr: PollPrTool,
    pub(crate) cwd: WorkingDirectory,
    pub(crate) card_checkout: CardCheckoutTool,
    pub(crate) poll_checkout: PollCheckoutTool,
    pub(crate) report_order: ReportOrderTool,
}

pub(crate) async fn hydrate_tool_history(
    history: &mut [crate::types::AgentHistoryMessage],
    parts: &[sprocket_transcript::TranscriptPart],
    supports_images: bool,
    image_urls: Option<&ConvexImageUrls<'_>>,
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
    let mut replays = Vec::new();
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
            replays.push((
                items,
                output,
                convert::replay_local_tool_output(output).await,
            ));
        }
    }
    let images: Vec<_> = replays
        .iter()
        .filter_map(|(_, _, replayed)| replayed.as_ref().ok()?.image())
        .collect();
    let urls = match image_urls {
        Some(source) => source.urls(&images).await,
        None => ImageUrlMap::new(),
    };
    let text_item = |text| vec![AgentHistoryToolResultItem::Text { text }];
    for (items, output, replayed) in replays {
        *items = match replayed.map(|replayed| replayed.into_history_items(&urls)) {
            Ok(Ok(items)) => items,
            Ok(Err(error)) => text_item(format!(
                "Previous tool output could not be sent to the model: {error:#}. Original result: {output}"
            )),
            Err(error) => text_item(format!(
                "Previous tool output is not available in the local cache: {error}. Original result: {output}"
            )),
        };
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
    transcript_store: Option<Arc<sprocket_transcript::TranscriptStore>>,
    artifact_bindings: sprocket_workspace::artifact_bindings::ArtifactBindings,
    supports_images: bool,
    tool_call_tracker: ToolCallTracker,
    skills: Arc<[WorkspaceSkill]>,
    command_sessions: CommandSessionManager,
    command_cursors: CommandCursors,
    subagent_models: Arc<crate::catalog::SubagentModelChoices>,
    subagent_launcher: Option<crate::subagents::SharedSubagentLauncher>,
    max_yield_ms: u64,
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
        command_cursors,
        max_yield_ms,
        question_polls: questions::QuestionPolls::default(),
        checkouts: payments::Checkouts::default(),
        subagent_polls: subagents::SubagentPolls::default(),
        subagent_models,
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
        list_subagents: ListSubagentsTool {
            context: context.clone(),
        },
        lookup_parts: LookupPartsTool(context.clone()),
        parse_file: ParseFileTool(context.clone()),
        poll_cmd: PollCmdTool(context.clone()),
        read_skill: ReadSkillTool {
            context: context.clone(),
            skills,
        },
        scrape_url: ScrapeUrlTool(context.clone()),
        spawn_subagent: SpawnSubagentTool {
            context: context.clone(),
        },
        poll_subagent: PollSubagentTool {
            context: context.clone(),
        },
        web_search: WebSearchTool(context.clone()),
        bind_artifact: BindArtifactTool(context.clone()),
        list_artifacts: ListArtifactsTool(context.clone()),
        save_artifact: SaveArtifactTool(context.clone()),
        delete_artifact: DeleteArtifactTool(context.clone()),
        set_cwd: SetCwdTool(context.clone()),
        link_prs: LinkPrsTool(context.clone()),
        poll_pr: PollPrTool(context.clone()),
        cwd: context.cwd.clone(),
        card_checkout: CardCheckoutTool(context.clone()),
        poll_checkout: PollCheckoutTool(context.clone()),
        report_order: ReportOrderTool(context),
    }
}

#[cfg(test)]
mod tests;
