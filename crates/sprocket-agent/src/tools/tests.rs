use super::async_tools::DEFAULT_YIELD_MS;
use convex::Value;
use rig::tool::{ToolErrorKind, ToolExecutionError};
use sprocket_workspace::{SkillSource, WorkspaceOperationCancelled, WorkspaceSkill};

use super::context::tool_error;
use super::job::mutation_args_from_payload;
use super::questions::{
    AGENT_DECIDE_OPTION_ID, AskQuestionArgs, AskQuestionOption, MAX_QUESTION_CHARS,
    prepare_ask_question,
};
use super::skills::resolve_read_skill;
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
        "number": 1, "sourceKey": "tool:inv-1:finished", "kind": "tool", "runId": "run",
        "tool": {"toolInvocationId": "inv-1", "callId": "call", "name": "parse_file", "status": "completed", "output": output}
    })).unwrap();
    let mut history = vec![AgentHistoryMessage {
        role: AgentHistoryRole::User,
        origin: None,
        contents: vec![AgentHistoryContent::ToolResult {
            id: "call".into(),
            call_id: Some("call".into()),
            items: vec![AgentHistoryToolResultItem::Text {
                text: "old output".into(),
            }],
        }],
    }];
    hydrate_tool_history(&mut history, &[part], false, None).await;
    let serialized = serde_json::to_string(&history).unwrap();
    assert!(serialized.contains("Image omitted"));
    assert!(!serialized.contains("not available"));
    assert!(!serialized.contains("imageJson"));
}

#[test]
fn tool_error_preserves_anyhow_context_chain_through_dispatch_normalization() {
    let error =
        anyhow::anyhow!("invalid add-file line").context("failed to parse Begin Patch input");
    let mapped = ToolExecutionError::from_error(tool_error(error));
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
fn tool_error_preserves_workspace_cancellation_through_dispatch_normalization() {
    let mapped =
        ToolExecutionError::from_error(tool_error(anyhow::Error::new(WorkspaceOperationCancelled)));
    assert_eq!(mapped.kind(), ToolErrorKind::Cancelled);
    assert_eq!(mapped.retryable(), Some(false));
    assert_eq!(
        mapped.model_feedback(),
        Some("Tool execution was cancelled.")
    );
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
        yield_time_ms: DEFAULT_YIELD_MS,
        timeout_ms: None,
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
        timeout_ms: None,
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
        timeout_ms: None,
    })
    .expect("unicode within character limits");

    let reserved = prepare_ask_question(&AskQuestionArgs {
        question: "Pick one".to_string(),
        options: vec![AskQuestionOption {
            id: AGENT_DECIDE_OPTION_ID.to_string(),
            label: "Nope".to_string(),
        }],
        yield_time_ms: 0,
        timeout_ms: None,
    })
    .expect_err("reserved id");
    assert!(reserved.to_string().contains("reserved"));
}

#[test]
fn read_skill_returns_complete_large_builtin_body() {
    let body = format!("{}\nFinal instruction.\n", "λ".repeat(40 * 1024));
    let contents = Box::leak(
        format!("---\nname: demo\ndescription: Demo skill\n---\n{body}").into_boxed_str(),
    );
    let skills = [WorkspaceSkill {
        name: "demo".to_string(),
        description: "Demo skill".to_string(),
        disable_model_invocation: true,
        source: SkillSource::BuiltIn { contents },
    }];

    let value = resolve_read_skill(&skills, "demo").expect("should resolve");
    assert_eq!(value["name"], "demo");
    assert_eq!(value["description"], "Demo skill");
    assert_eq!(value["content"], body);
    assert!(value.get("dir").is_none());
}

#[test]
fn read_skill_unknown_name_lists_available() {
    let skills = [
        WorkspaceSkill {
            name: "alpha".to_string(),
            description: "A".to_string(),
            disable_model_invocation: false,
            source: SkillSource::BuiltIn { contents: "" },
        },
        WorkspaceSkill {
            name: "bravo".to_string(),
            description: "B".to_string(),
            disable_model_invocation: false,
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
    let job_payload = serde_json::json!({"path": "doc.md"});
    let job_args = mutation_args_from_payload("run-1", "claim-1", &job_payload).unwrap();
    assert_eq!(job_args.get("runId"), Some(&Value::from("run-1")));
    assert_eq!(job_args.get("claimId"), Some(&Value::from("claim-1")));
    assert_eq!(job_args.get("path"), Some(&Value::from("doc.md")));
    assert!(job_args.get("content").is_none());

    let mutation_payload = serde_json::json!({
        "localPath": "doc.md",
        "content": "function App() { return null; }",
        "title": "doc.md",
        "contentType": "react"
    });
    let mutation_args = mutation_args_from_payload("run-1", "claim-1", &mutation_payload).unwrap();
    assert_eq!(mutation_args.get("localPath"), Some(&Value::from("doc.md")));
    assert_eq!(
        mutation_args.get("content"),
        Some(&Value::from("function App() { return null; }"))
    );
    assert!(mutation_args_from_payload("run-1", "claim-1", &serde_json::json!("nope")).is_err());
}
