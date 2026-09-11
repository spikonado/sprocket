mod artifacts;
mod browser;
mod commands;
mod context;
mod firecrawl;
mod hosted_parse;
mod job;
mod mandates;
mod markdown_url;
mod parse_file;
mod patch;
mod questions;
mod scrape_files;
mod skills;
mod web;

use std::path::PathBuf;
use std::sync::Arc;

use sprocket_workspace::{CommandSessionManager, WorkspaceSkill};

use self::artifacts::{AddArtifactTool, EditArtifactTool, ListArtifactsTool, SaveArtifactTool};
use self::browser::{BrowserInteractTool, BrowserScreenshotTool};
use self::commands::{ExecCommandTool, WriteStdinTool};
use self::context::AgentToolContext;
use self::mandates::{
    MandateChargeTool, MandateListTool, MandateReportTool, MandateSetupTool, MandateStatusTool,
};
use self::parse_file::ParseFileTool;
use self::patch::ApplyPatchTool;
use self::questions::{AskQuestionTool, AwaitQuestionTool};
use self::skills::ReadSkillTool;
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
    AGENT_DECIDE_OPTION_ID, AskQuestionArgs, AskQuestionOption, DEFAULT_ASK_QUESTION_TIMEOUT_MS,
    DEFAULT_ASK_QUESTION_YIELD_MS, MAX_QUESTION_CHARS, prepare_ask_question,
};
#[cfg(test)]
use self::skills::resolve_read_skill;

pub(crate) struct AgentToolSet {
    pub(crate) apply_patch: ApplyPatchTool,
    pub(crate) ask_question: AskQuestionTool,
    pub(crate) await_question: AwaitQuestionTool,
    pub(crate) command_sessions: CommandSessionManager,
    pub(crate) exec_command: ExecCommandTool,
    pub(crate) parse_file: ParseFileTool,
    pub(crate) read_skill: ReadSkillTool,
    pub(crate) scrape_url: ScrapeUrlTool,
    pub(crate) screenshot_url: ScreenshotUrlTool,
    pub(crate) web_search: WebSearchTool,
    pub(crate) write_stdin: WriteStdinTool,
    pub(crate) add_artifact: AddArtifactTool,
    pub(crate) list_artifacts: ListArtifactsTool,
    pub(crate) edit_artifact: EditArtifactTool,
    pub(crate) save_artifact: SaveArtifactTool,
    pub(crate) browser_interact: BrowserInteractTool,
    pub(crate) browser_screenshot: BrowserScreenshotTool,
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
            || matches!(
                tool.name.as_str(),
                "scrape_url" | "screenshot_url" | "browser_screenshot"
            ))
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
    workspace_root: PathBuf,
    transcript_dir: PathBuf,
    artifact_bindings: crate::artifact_bindings::ArtifactBindings,
    thread_id: String,
    supports_images: bool,
    tool_call_tracker: ToolCallTracker,
    skills: Arc<[WorkspaceSkill]>,
) -> AgentToolSet {
    let command_sessions = CommandSessionManager::new(workspace_root.clone());
    let context = AgentToolContext::new(
        runtime,
        run_id,
        claim_id,
        workspace_root,
        transcript_dir,
        artifact_bindings,
        thread_id,
        supports_images,
        tool_call_tracker,
        command_sessions.clone(),
    );
    AgentToolSet {
        apply_patch: ApplyPatchTool(context.clone()),
        ask_question: AskQuestionTool(context.clone()),
        await_question: AwaitQuestionTool(context.clone()),
        command_sessions,
        exec_command: ExecCommandTool(context.clone()),
        parse_file: ParseFileTool(context.clone()),
        read_skill: ReadSkillTool {
            context: context.clone(),
            skills,
        },
        scrape_url: ScrapeUrlTool(context.clone()),
        screenshot_url: ScreenshotUrlTool(context.clone()),
        web_search: WebSearchTool(context.clone()),
        write_stdin: WriteStdinTool(context.clone()),
        add_artifact: AddArtifactTool(context.clone()),
        list_artifacts: ListArtifactsTool(context.clone()),
        edit_artifact: EditArtifactTool(context.clone()),
        save_artifact: SaveArtifactTool(context.clone()),
        browser_interact: BrowserInteractTool(context.clone()),
        browser_screenshot: BrowserScreenshotTool(context.clone()),
        mandate_setup: MandateSetupTool(context.clone()),
        mandate_status: MandateStatusTool(context.clone()),
        mandate_list: MandateListTool(context.clone()),
        mandate_charge: MandateChargeTool(context.clone()),
        mandate_report: MandateReportTool(context),
    }
}

#[cfg(test)]
mod tests {
    use convex::Value;
    use rig::tool::ToolErrorKind;
    use sprocket_workspace::{SkillSource, WorkspaceOperationCancelled, WorkspaceSkill};

    use super::*;

    #[tokio::test]
    async fn text_only_models_do_not_replay_cached_image_results() {
        use crate::types::{
            AgentHistoryContent, AgentHistoryMessage, AgentHistoryRole, AgentHistoryToolResultItem,
        };
        let output = serde_json::json!({
            "outputType": "image", "path": "/missing-image.png", "mediaType": "image/png",
            "source": {"type": "path", "path": "photo.png"}, "byteSize": 1.0, "width": 1.0, "height": 1.0
        });
        let part = serde_json::from_value(serde_json::json!({
            "number": 1, "sourceKey": "tool:1", "kind": "tool", "runId": "run",
            "tool": {"callId": "call", "name": "parse_file", "status": "completed", "output": output}
        })).unwrap();
        let mut history = vec![AgentHistoryMessage {
            role: AgentHistoryRole::User,
            assistant_id: None,
            contents: vec![AgentHistoryContent::ToolResult {
                id: "call".into(),
                call_id: Some("call".into()),
                items: vec![AgentHistoryToolResultItem::Text {
                    text: "old output".into(),
                }],
            }],
        }];
        hydrate_tool_history(&mut history, &[part], false).await;
        let serialized = serde_json::to_string(&history).unwrap();
        assert!(serialized.contains("Image omitted"));
        assert!(!serialized.contains("not available"));
        assert!(!serialized.contains("imageJson"));
    }

    #[test]
    fn tool_error_includes_anyhow_context_chain() {
        let error =
            anyhow::anyhow!("invalid add-file line").context("failed to parse Begin Patch input");
        let mapped = tool_error(error);
        let message = mapped.model_feedback().expect("model feedback");
        assert!(
            message.contains("failed to parse Begin Patch input"),
            "missing outer context: {message}"
        );
        assert!(
            message.contains("invalid add-file line"),
            "missing root cause: {message}"
        );
    }

    #[test]
    fn tool_error_maps_workspace_cancellation_to_cancelled_kind() {
        let mapped = tool_error(anyhow::Error::new(WorkspaceOperationCancelled));
        assert_eq!(mapped.kind(), ToolErrorKind::Cancelled);
    }

    #[test]
    fn prepare_ask_question_normalizes_and_enforces_limits() {
        let prepared = prepare_ask_question(&AskQuestionArgs {
            question: "Which database?".to_string(),
            options: vec![
                AskQuestionOption {
                    id: "pg".to_string(),
                    label: "Postgres".to_string(),
                },
                AskQuestionOption {
                    id: "sqlite".to_string(),
                    label: "SQLite".to_string(),
                },
            ],
            yield_time_ms: DEFAULT_ASK_QUESTION_YIELD_MS,
            timeout_ms: DEFAULT_ASK_QUESTION_TIMEOUT_MS,
        })
        .expect("valid question");

        assert_eq!(prepared.options.len(), 2);
        assert_eq!(prepared.options[0].id, "pg");
        assert_eq!(prepared.options[1].id, "sqlite");

        let too_long_question = "x".repeat(MAX_QUESTION_CHARS + 1);
        let error = prepare_ask_question(&AskQuestionArgs {
            question: too_long_question,
            options: vec![AskQuestionOption {
                id: "a".to_string(),
                label: "A".to_string(),
            }],
            yield_time_ms: 0,
            timeout_ms: DEFAULT_ASK_QUESTION_TIMEOUT_MS,
        })
        .expect_err("overlong question");
        assert!(error.to_string().contains("2000"));

        // Multibyte Unicode must be counted by characters, matching Convex validation.
        let unicode_question = "é".repeat(MAX_QUESTION_CHARS);
        prepare_ask_question(&AskQuestionArgs {
            question: unicode_question,
            options: vec![AskQuestionOption {
                id: "a".to_string(),
                label: "café".to_string(),
            }],
            yield_time_ms: 0,
            timeout_ms: DEFAULT_ASK_QUESTION_TIMEOUT_MS,
        })
        .expect("unicode within character limits");

        let reserved = prepare_ask_question(&AskQuestionArgs {
            question: "Pick one".to_string(),
            options: vec![AskQuestionOption {
                id: AGENT_DECIDE_OPTION_ID.to_string(),
                label: "Nope".to_string(),
            }],
            yield_time_ms: 0,
            timeout_ms: DEFAULT_ASK_QUESTION_TIMEOUT_MS,
        })
        .expect_err("reserved id");
        assert!(reserved.to_string().contains("reserved"));
    }

    #[test]
    fn read_skill_returns_builtin_content_without_dir() {
        let skills = [WorkspaceSkill {
            name: "demo".to_string(),
            description: "Demo skill".to_string(),
            source: SkillSource::BuiltIn {
                contents: "---\nname: demo\ndescription: Demo skill\n---\n# Do it\n",
            },
        }];

        let value = resolve_read_skill(&skills, "demo").expect("should resolve");
        assert_eq!(value["name"], "demo");
        assert_eq!(value["description"], "Demo skill");
        assert_eq!(value["content"], "# Do it\n");
        assert!(value.get("dir").is_none());
        assert!(value.get("truncated").is_none());
    }

    #[test]
    fn read_skill_unknown_name_lists_available() {
        let skills = [
            WorkspaceSkill {
                name: "alpha".to_string(),
                description: "A".to_string(),
                source: SkillSource::BuiltIn { contents: "" },
            },
            WorkspaceSkill {
                name: "bravo".to_string(),
                description: "B".to_string(),
                source: SkillSource::BuiltIn { contents: "" },
            },
        ];

        let error = resolve_read_skill(&skills, "missing").expect_err("should fail");
        let message = error.to_string();
        assert!(message.contains("Unknown skill 'missing'"));
        assert!(message.contains("alpha, bravo"));
    }

    #[test]
    fn mutation_args_from_payload_merges_run_claim() {
        let job_payload = serde_json::json!({"path": "doc.md", "scope": "thread"});
        let job_args = mutation_args_from_payload("run-1", "claim-1", &job_payload).unwrap();
        assert_eq!(job_args.get("runId"), Some(&Value::from("run-1")));
        assert_eq!(job_args.get("claimId"), Some(&Value::from("claim-1")));
        assert_eq!(job_args.get("path"), Some(&Value::from("doc.md")));
        assert_eq!(job_args.get("scope"), Some(&Value::from("thread")));
        assert!(job_args.get("content").is_none());

        let mutation_payload = serde_json::json!({
            "scope": "thread",
            "localPath": "doc.md",
            "content": "function App() { return null; }",
            "title": "doc.md",
            "contentType": "react"
        });
        let mutation_args =
            mutation_args_from_payload("run-1", "claim-1", &mutation_payload).unwrap();
        assert_eq!(mutation_args.get("localPath"), Some(&Value::from("doc.md")));
        assert_eq!(
            mutation_args.get("content"),
            Some(&Value::from("function App() { return null; }"))
        );
        assert!(
            mutation_args_from_payload("run-1", "claim-1", &serde_json::json!("nope")).is_err()
        );
    }
}
