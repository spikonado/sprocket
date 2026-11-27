mod artifacts;
mod async_tools;
mod cloud;
mod commands;
mod context;
mod convert;
mod cwd;
mod github_url;
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
mod services;
mod skills;
mod subagents;
mod threads;
mod url_fetch;
mod web;
mod wiring;

use self::artifacts::{BindArtifactTool, DeleteArtifactTool, ListArtifactsTool, SaveArtifactTool};
pub(crate) use self::async_tools::max_yield_ms;
pub(crate) use self::commands::CommandCursors;
use self::commands::{ControlCmdTool, ExecCmdTool, PollCmdTool};
use self::context::{AgentToolContext, WorkingDirectory};
use self::cwd::SetCwdTool;
use self::parse_file::ParseFileTool;
use self::parts::LookupPartsTool;
use self::patch::ApplyPatchTool;
use self::payments::{CardCheckoutTool, PollCheckoutTool, ReportOrderTool};
use self::pull_requests::{LinkPrsTool, PollPrTool};
use self::questions::{AskQuestionTool, PollQuestionTool};
use self::services::{
    RequestConnectorTool, ServiceCallTool, ServiceDescribeTool, ServiceSearchTool,
};
use self::skills::ReadSkillTool;
use self::subagents::{ControlSubagentTool, PollSubagentTool, SpawnSubagentTool};
use self::threads::{DownloadThreadsTool, ListThreadsTool};
use self::web::{ScrapeUrlTool, WebSearchTool};
use crate::convex::RuntimeClient;
use crate::hooks::ToolCallTracker;
use crate::provider::AgentProviderRequest;

pub(crate) type NormalizeToolArgs = fn(&serde_json::Value) -> Option<serde_json::Value>;

pub(crate) const AGENT_TOOLS: &[(&str, NormalizeToolArgs)] = &[
    agent_tool::<ApplyPatchTool>(),
    agent_tool::<AskQuestionTool>(),
    agent_tool::<BindArtifactTool>(),
    agent_tool::<CardCheckoutTool>(),
    agent_tool::<ControlCmdTool>(),
    agent_tool::<ControlSubagentTool>(),
    agent_tool::<DeleteArtifactTool>(),
    agent_tool::<DownloadThreadsTool>(),
    agent_tool::<ExecCmdTool>(),
    agent_tool::<LinkPrsTool>(),
    agent_tool::<ListArtifactsTool>(),
    agent_tool::<ListThreadsTool>(),
    agent_tool::<LookupPartsTool>(),
    agent_tool::<ParseFileTool>(),
    agent_tool::<PollCheckoutTool>(),
    agent_tool::<PollCmdTool>(),
    agent_tool::<PollPrTool>(),
    agent_tool::<PollQuestionTool>(),
    agent_tool::<PollSubagentTool>(),
    agent_tool::<ReadSkillTool>(),
    agent_tool::<ReportOrderTool>(),
    agent_tool::<RequestConnectorTool>(),
    agent_tool::<SaveArtifactTool>(),
    agent_tool::<ScrapeUrlTool>(),
    agent_tool::<ServiceCallTool>(),
    agent_tool::<ServiceDescribeTool>(),
    agent_tool::<ServiceSearchTool>(),
    agent_tool::<SetCwdTool>(),
    agent_tool::<SpawnSubagentTool>(),
    agent_tool::<WebSearchTool>(),
];

const fn agent_tool<T>() -> (&'static str, NormalizeToolArgs)
where
    T: rig::tool::Tool,
    T::Args: serde::Serialize,
{
    (T::NAME, normalize_tool_args::<T> as NormalizeToolArgs)
}

fn normalize_tool_args<T>(args: &serde_json::Value) -> Option<serde_json::Value>
where
    T: rig::tool::Tool,
    T::Args: serde::Serialize,
{
    let args = <T::Args as serde::Deserialize>::deserialize(args).ok()?;
    serde_json::to_value(args).ok()
}

pub(crate) struct AgentToolSet {
    pub(crate) apply_patch: ApplyPatchTool,
    pub(crate) ask_question: AskQuestionTool,
    pub(crate) poll_question: PollQuestionTool,
    pub(crate) control_cmd: ControlCmdTool,
    pub(crate) exec_cmd: ExecCmdTool,
    pub(crate) control_subagent: ControlSubagentTool,
    pub(crate) list_threads: ListThreadsTool,
    pub(crate) download_threads: DownloadThreadsTool,
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
    pub(crate) service_search: ServiceSearchTool,
    pub(crate) service_describe: ServiceDescribeTool,
    pub(crate) service_call: ServiceCallTool,
    pub(crate) request_connector: RequestConnectorTool,
}

pub(crate) async fn hydrate_tool_history(
    history: &mut [crate::types::AgentHistoryMessage],
    parts: &[sprocket_transcript::TranscriptPart],
    supports_images: bool,
) {
    use crate::types::{AgentHistoryContent, AgentHistoryToolResultItem};
    let calls = crate::history::ToolCallIndex::new(parts);
    let mut results = std::collections::HashMap::new();
    for part in parts {
        let Some(tool) = &part.tool else { continue };
        let Some((name, _)) = calls.tool_details(part) else {
            continue;
        };
        if tool.status != "started"
            && (parse_file::is_parse_file_tool(name)
                || matches!(name, "scrape_url" | "screenshot_url"))
        {
            let id = calls
                .for_result(part)
                .map(|call| call.history_id())
                .unwrap_or_else(|| tool.call_id.clone());
            results.entry(id).or_insert((tool, name));
        }
    }
    for message in history {
        for content in &mut message.contents {
            let AgentHistoryContent::ToolResult { id, items, .. } = content else {
                continue;
            };
            let Some(&(tool, name)) = results.get(id.as_str()) else {
                continue;
            };
            if tool.status != "completed" {
                continue;
            }
            let Some(output) = &tool.output else { continue };
            let is_image =
                output.get("outputType").and_then(serde_json::Value::as_str) == Some("image");
            if !is_image && !parse_file::is_parse_file_tool(name) {
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
            *items = match convert::replay_local_tool_output(output)
                .await
                .and_then(convert::ReplayedOutput::into_history_items)
            {
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
    request: &AgentProviderRequest,
    tool_call_tracker: ToolCallTracker,
    max_yield_ms: u64,
) -> AgentToolSet {
    let context = AgentToolContext {
        runtime,
        run_id: request.run_id.clone(),
        claim_id: request.claim_id.clone(),
        user_id: request.user_id.clone(),
        workspace_root: request.workspace_root.clone(),
        cwd: WorkingDirectory::new(request.cwd.clone()),
        transcript_dir: request.transcript_dir.clone(),
        gateway_url: request.gateway_url.clone(),
        transcript_store: request.transcript_store.clone(),
        artifact_bindings: request.artifact_bindings.clone(),
        supports_images: request.supports_images,
        tool_call_tracker,
        command_sessions: request.command_sessions.clone(),
        command_cursors: request.command_cursors.clone(),
        max_yield_ms,
        question_polls: questions::QuestionPolls::default(),
        checkouts: payments::Checkouts::default(),
        subagent_polls: subagents::SubagentPolls::default(),
        subagent_models: request.subagent_models.clone(),
        subagent_launcher: request.subagent_launcher.clone(),
        service_hub: request.service_hub.clone(),
        can_ask_user: request.allow_interaction,
        posthog_session_id: request.posthog_session_id.clone(),
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
        list_threads: ListThreadsTool {
            context: context.clone(),
            repository_key: request.repository_key.clone(),
        },
        download_threads: DownloadThreadsTool {
            context: context.clone(),
        },
        parse_file: ParseFileTool(context.clone()),
        lookup_parts: LookupPartsTool(context.clone()),
        poll_cmd: PollCmdTool(context.clone()),
        read_skill: ReadSkillTool {
            context: context.clone(),
            skills: request.skills.clone(),
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
        service_search: ServiceSearchTool(context.clone()),
        service_describe: ServiceDescribeTool(context.clone()),
        service_call: ServiceCallTool(context.clone()),
        request_connector: RequestConnectorTool(context.clone()),
        report_order: ReportOrderTool(context),
    }
}

#[cfg(test)]
mod tests;
