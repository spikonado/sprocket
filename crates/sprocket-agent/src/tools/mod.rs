mod artifacts;
mod browser;
mod commands;
mod context;
mod job;
mod mandates;
mod parse_file;
mod patch;
mod questions;
mod skills;
mod web;

use std::path::PathBuf;
use std::sync::Arc;

use sprocket_workspace::{CommandSessionManager, WorkspaceSkill};

use self::artifacts::{CreateArtifactTool, UpdateArtifactTool};
use self::browser::{BrowserActTool, BrowserExtractTool, BrowserObserveTool};
use self::commands::{ExecCommandTool, WriteStdinTool};
use self::context::AgentToolContext;
use self::mandates::{
    MandateChargeTool, MandateListTool, MandateReportTool, MandateSetupTool, MandateStatusTool,
};
use self::parse_file::ParseFileTool;
use self::patch::ApplyPatchTool;
use self::questions::{AskQuestionTool, AwaitQuestionTool};
use self::skills::ReadSkillTool;
use self::web::{ScrapeUrlTool, WebSearchTool};
use crate::convex::RuntimeClient;
use crate::hooks::ToolCallTracker;

// Helpers/constants brought into this module so `tests` can reach them via `super::*`.
#[cfg(test)]
use self::artifacts::{ArtifactContentType, CreateArtifactArgs, UpdateArtifactArgs};
#[cfg(test)]
use self::commands::{
    DEFAULT_COMMAND_MAX_OUTPUT_CHARS, DEFAULT_COMMAND_TIMEOUT_MS, DEFAULT_COMMAND_YIELD_MS,
    DEFAULT_STDIN_YIELD_MS, ExecCommandArgs, WriteStdinArgs, exec_command_parameters,
};
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
#[cfg(test)]
use self::web::{DEFAULT_WEB_SEARCH_RESULTS, WebSearchArgs, web_search_parameters};

pub(crate) struct AgentToolSet {
    pub(crate) apply_patch: ApplyPatchTool,
    pub(crate) ask_question: AskQuestionTool,
    pub(crate) await_question: AwaitQuestionTool,
    pub(crate) command_sessions: CommandSessionManager,
    pub(crate) exec_command: ExecCommandTool,
    pub(crate) parse_file: ParseFileTool,
    pub(crate) read_skill: ReadSkillTool,
    pub(crate) scrape_url: ScrapeUrlTool,
    pub(crate) web_search: WebSearchTool,
    pub(crate) write_stdin: WriteStdinTool,
    pub(crate) create_artifact: CreateArtifactTool,
    pub(crate) update_artifact: UpdateArtifactTool,
    pub(crate) browser_observe: BrowserObserveTool,
    pub(crate) browser_act: BrowserActTool,
    pub(crate) browser_extract: BrowserExtractTool,
    pub(crate) mandate_setup: MandateSetupTool,
    pub(crate) mandate_status: MandateStatusTool,
    pub(crate) mandate_list: MandateListTool,
    pub(crate) mandate_charge: MandateChargeTool,
    pub(crate) mandate_report: MandateReportTool,
}

pub(crate) async fn hydrate_parse_file_history(
    history: &mut [crate::types::AgentHistoryMessage],
    parts: &[crate::transcript::TranscriptPart],
    supports_images: bool,
) {
    use crate::types::{AgentHistoryContent, AgentHistoryToolResultItem};
    let mut results = std::collections::HashMap::new();
    for tool in parts.iter().filter_map(|part| part.tool.as_ref()) {
        if parse_file::is_parse_file_tool(&tool.name) && tool.status != "started" {
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
            if !supports_images
                && output.get("outputType").and_then(serde_json::Value::as_str) == Some("image")
            {
                *items = vec![AgentHistoryToolResultItem::Text {
                    text: format!(
                        "Image omitted because the selected model does not support images. Original parse_file result: {output}"
                    ),
                }];
                continue;
            }
            *items = match parse_file::replay_parse_file_history_items(output).await {
                Ok(items) => items,
                Err(error) => vec![AgentHistoryToolResultItem::Text {
                    text: format!(
                        "Previously parsed file is not available in the local cache: {error}. Use parse_file again if needed. Original result: {output}"
                    ),
                }],
            };
            if !supports_images {
                for item in items {
                    if matches!(item, AgentHistoryToolResultItem::Image { .. }) {
                        *item = AgentHistoryToolResultItem::Text {
                            text: format!(
                                "Image omitted because the selected model does not support images. Original parse_file result: {output}"
                            ),
                        };
                    }
                }
            }
        }
    }
}

pub(crate) use parse_file::parse_file_cache_dir;

pub(crate) fn agent_tools(
    runtime: RuntimeClient,
    run_id: String,
    claim_id: String,
    workspace_root: PathBuf,
    parse_file_cache_dir: PathBuf,
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
        parse_file_cache_dir,
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
        web_search: WebSearchTool(context.clone()),
        write_stdin: WriteStdinTool(context.clone()),
        create_artifact: CreateArtifactTool(context.clone()),
        update_artifact: UpdateArtifactTool(context.clone()),
        browser_observe: BrowserObserveTool(context.clone()),
        browser_act: BrowserActTool(context.clone()),
        browser_extract: BrowserExtractTool(context.clone()),
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
    use sprocket_workspace::{
        SkillSource, WorkspaceOperationCancelled, WorkspaceSkill, default_command_shell,
    };

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
        hydrate_parse_file_history(&mut history, &[part], false).await;
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
    fn ask_question_defaults_are_omitted_from_payload() {
        let args: AskQuestionArgs = serde_json::from_value(serde_json::json!({
            "question": "Ship it?",
            "options": [{ "id": "yes", "label": "Yes" }]
        }))
        .expect("minimal ask_question args");
        assert_eq!(args.yield_time_ms, DEFAULT_ASK_QUESTION_YIELD_MS);
        assert_eq!(args.timeout_ms, DEFAULT_ASK_QUESTION_TIMEOUT_MS);
        assert_eq!(
            serde_json::to_value(&args).unwrap(),
            serde_json::json!({
                "question": "Ship it?",
                "options": [{ "id": "yes", "label": "Yes" }]
            })
        );
    }

    #[test]
    fn exec_command_defaults_are_explicit_but_omitted_from_payload() {
        let args: ExecCommandArgs = serde_json::from_value(serde_json::json!({ "cmd": "pwd" }))
            .expect("minimal command args should deserialize");

        assert_eq!(args.workdir, ".");
        assert_eq!(args.shell, default_command_shell());
        assert_eq!(args.timeout_ms, DEFAULT_COMMAND_TIMEOUT_MS);
        assert_eq!(args.yield_time_ms, DEFAULT_COMMAND_YIELD_MS);
        assert_eq!(args.max_output_chars, DEFAULT_COMMAND_MAX_OUTPUT_CHARS);
        assert_eq!(
            serde_json::to_value(&args).unwrap(),
            serde_json::json!({ "cmd": "pwd" })
        );

        let schema = exec_command_parameters();
        assert_eq!(schema["properties"]["workdir"]["default"], ".");
        assert_eq!(
            schema["properties"]["shell"]["default"],
            default_command_shell()
        );
        assert!(schema["properties"].get("login").is_none());
    }

    #[test]
    fn web_search_defaults_are_omitted_from_payload() {
        let args: WebSearchArgs = serde_json::from_value(serde_json::json!({ "query": "rust" }))
            .expect("minimal search args should deserialize");

        assert_eq!(args.num_results, DEFAULT_WEB_SEARCH_RESULTS);
        assert_eq!(
            serde_json::to_value(&args).unwrap(),
            serde_json::json!({ "query": "rust" })
        );

        let schema = web_search_parameters();
        assert_eq!(
            schema["properties"]["numResults"]["default"],
            DEFAULT_WEB_SEARCH_RESULTS
        );
    }

    #[test]
    fn write_stdin_defaults_are_omitted_from_payload() {
        let args: WriteStdinArgs = serde_json::from_value(serde_json::json!({ "sessionId": "1" }))
            .expect("minimal stdin args should deserialize");

        assert!(args.chars.is_empty());
        assert!(!args.terminate);
        assert_eq!(args.yield_time_ms, DEFAULT_STDIN_YIELD_MS);
        assert_eq!(
            serde_json::to_value(&args).unwrap(),
            serde_json::json!({ "sessionId": "1" })
        );
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
    fn create_artifact_args_round_trip() {
        let args: CreateArtifactArgs = serde_json::from_value(serde_json::json!({
            "title": "Landing mock",
            "contentType": "react",
            "content": "function App() { return null; }"
        }))
        .expect("create artifact args should deserialize");

        assert_eq!(args.title, "Landing mock");
        assert_eq!(args.content_type, ArtifactContentType::React);
        assert_eq!(args.content, "function App() { return null; }");

        let value = serde_json::to_value(&args).unwrap();
        assert_eq!(value["title"], "Landing mock");
        assert_eq!(value["contentType"], "react");
        assert_eq!(value["content"], "function App() { return null; }");
    }

    #[test]
    fn update_artifact_args_round_trip() {
        let args: UpdateArtifactArgs = serde_json::from_value(serde_json::json!({
            "artifactId": "abc123",
            "content": "updated content"
        }))
        .expect("update artifact args should deserialize");

        assert_eq!(args.artifact_id, "abc123");
        assert_eq!(args.content, "updated content");

        let value = serde_json::to_value(&args).unwrap();
        assert_eq!(value["artifactId"], "abc123");
        assert_eq!(value["content"], "updated content");
    }

    #[test]
    fn create_artifact_rejects_unknown_content_type() {
        let error = serde_json::from_value::<CreateArtifactArgs>(serde_json::json!({
            "title": "Notes",
            "contentType": "jsx",
            "content": "x"
        }))
        .expect_err("unknown content type must be rejected before reaching Convex");

        assert!(error.to_string().contains("unknown variant"));
    }

    #[test]
    fn mutation_args_from_payload_merges_run_claim() {
        let payload = serde_json::json!({
            "title": "Landing",
            "contentType": "react",
            "content": "function App() { return null; }"
        });
        let args = mutation_args_from_payload("run-1", "claim-1", &payload).unwrap();
        assert_eq!(args.get("runId"), Some(&Value::from("run-1")));
        assert_eq!(args.get("claimId"), Some(&Value::from("claim-1")));
        assert_eq!(args.get("title"), Some(&Value::from("Landing")));
        assert_eq!(args.get("contentType"), Some(&Value::from("react")));
    }
}
