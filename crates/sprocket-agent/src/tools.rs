use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use convex::Value;
use futures::StreamExt;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sprocket_workspace::{
    CommandSessionManager, WorkspaceCancellation, WorkspaceOperationCancelled, WorkspaceSkill,
    apply_workspace_patch, default_command_shell, read_skill_content,
};
use tokio::time::{Instant, sleep};

const DEFAULT_COMMAND_TIMEOUT_MS: u64 = 60_000;
const DEFAULT_COMMAND_YIELD_MS: u64 = 10_000;
const DEFAULT_COMMAND_MAX_OUTPUT_CHARS: usize = 20_000;
const DEFAULT_STDIN_YIELD_MS: u64 = 5_000;
const DEFAULT_WEB_SEARCH_RESULTS: u32 = 5;
const DEFAULT_ASK_QUESTION_YIELD_MS: u64 = 10 * 60 * 1000;
const DEFAULT_ASK_QUESTION_TIMEOUT_MS: u64 = 30 * 60 * 1000;
const DEFAULT_AWAIT_QUESTION_YIELD_MS: u64 = 5_000;
const MAX_QUESTION_CHARS: usize = 2000;
const MAX_OPTION_ID_CHARS: usize = 20;
const MAX_OPTION_LABEL_CHARS: usize = 200;
const MIN_AGENT_OPTIONS: usize = 1;
const MAX_AGENT_OPTIONS: usize = 4;
const AGENT_DECIDE_OPTION_ID: &str = "agent_decide";
const GET_QUESTION_FUNCTION: &str = "agentQuestions:getForExecutor";

use crate::convex::RuntimeClient;
use crate::hooks::ToolCallTracker;

#[derive(Debug, thiserror::Error)]
pub(crate) enum AgentToolError {
    #[error("Run is no longer active.")]
    Cancelled,
    #[error("{0}")]
    Message(String),
}

#[derive(Clone)]
struct AgentToolContext {
    runtime: RuntimeClient,
    run_id: String,
    claim_id: String,
    workspace_root: PathBuf,
    tool_call_tracker: ToolCallTracker,
    command_sessions: CommandSessionManager,
}

impl AgentToolContext {
    fn new(
        runtime: RuntimeClient,
        run_id: String,
        claim_id: String,
        workspace_root: PathBuf,
        tool_call_tracker: ToolCallTracker,
        command_sessions: CommandSessionManager,
    ) -> Self {
        Self {
            runtime,
            run_id,
            claim_id,
            workspace_root,
            tool_call_tracker,
            command_sessions,
        }
    }
}

#[derive(Clone)]
pub(crate) struct ApplyPatchTool(AgentToolContext);

#[derive(Clone)]
pub(crate) struct AskQuestionTool(AgentToolContext);

#[derive(Clone)]
pub(crate) struct AwaitQuestionTool(AgentToolContext);

#[derive(Clone)]
pub(crate) struct ExecCommandTool(AgentToolContext);

#[derive(Clone)]
pub(crate) struct ScrapeUrlTool(AgentToolContext);

#[derive(Clone)]
pub(crate) struct WebSearchTool(AgentToolContext);

#[derive(Clone)]
pub(crate) struct WriteStdinTool(AgentToolContext);

#[derive(Clone)]
pub(crate) struct CreateArtifactTool(AgentToolContext);

#[derive(Clone)]
pub(crate) struct UpdateArtifactTool(AgentToolContext);

#[derive(Clone)]
pub(crate) struct ReadSkillTool {
    context: AgentToolContext,
    skills: Arc<[WorkspaceSkill]>,
}

pub(crate) struct AgentToolSet {
    pub(crate) apply_patch: ApplyPatchTool,
    pub(crate) ask_question: AskQuestionTool,
    pub(crate) await_question: AwaitQuestionTool,
    pub(crate) command_sessions: CommandSessionManager,
    pub(crate) exec_command: ExecCommandTool,
    pub(crate) read_skill: ReadSkillTool,
    pub(crate) scrape_url: ScrapeUrlTool,
    pub(crate) web_search: WebSearchTool,
    pub(crate) write_stdin: WriteStdinTool,
    pub(crate) create_artifact: CreateArtifactTool,
    pub(crate) update_artifact: UpdateArtifactTool,
}

pub(crate) fn agent_tools(
    runtime: RuntimeClient,
    run_id: String,
    claim_id: String,
    workspace_root: PathBuf,
    tool_call_tracker: ToolCallTracker,
    skills: Arc<[WorkspaceSkill]>,
) -> AgentToolSet {
    let command_sessions = CommandSessionManager::new(workspace_root.clone());
    let context = AgentToolContext::new(
        runtime,
        run_id,
        claim_id,
        workspace_root,
        tool_call_tracker,
        command_sessions.clone(),
    );
    AgentToolSet {
        apply_patch: ApplyPatchTool(context.clone()),
        ask_question: AskQuestionTool(context.clone()),
        await_question: AwaitQuestionTool(context.clone()),
        command_sessions,
        exec_command: ExecCommandTool(context.clone()),
        read_skill: ReadSkillTool {
            context: context.clone(),
            skills,
        },
        scrape_url: ScrapeUrlTool(context.clone()),
        web_search: WebSearchTool(context.clone()),
        write_stdin: WriteStdinTool(context.clone()),
        create_artifact: CreateArtifactTool(context.clone()),
        update_artifact: UpdateArtifactTool(context),
    }
}

fn default_workdir() -> String {
    ".".to_string()
}

fn default_timeout_ms() -> u64 {
    DEFAULT_COMMAND_TIMEOUT_MS
}

fn default_command_yield_ms() -> u64 {
    DEFAULT_COMMAND_YIELD_MS
}

fn default_max_output_chars() -> usize {
    DEFAULT_COMMAND_MAX_OUTPUT_CHARS
}

fn default_stdin_yield_ms() -> u64 {
    DEFAULT_STDIN_YIELD_MS
}

fn is_default_workdir(workdir: &String) -> bool {
    workdir == "."
}

fn is_default_shell(shell: &String) -> bool {
    shell == &default_command_shell()
}

fn is_default_timeout_ms(timeout_ms: &u64) -> bool {
    *timeout_ms == DEFAULT_COMMAND_TIMEOUT_MS
}

fn is_default_command_yield_ms(yield_time_ms: &u64) -> bool {
    *yield_time_ms == DEFAULT_COMMAND_YIELD_MS
}

fn is_default_max_output_chars(max_output_chars: &usize) -> bool {
    *max_output_chars == DEFAULT_COMMAND_MAX_OUTPUT_CHARS
}

fn is_default_stdin_yield_ms(yield_time_ms: &u64) -> bool {
    *yield_time_ms == DEFAULT_STDIN_YIELD_MS
}

fn is_false(value: &bool) -> bool {
    !*value
}

fn default_ask_question_yield_ms() -> u64 {
    DEFAULT_ASK_QUESTION_YIELD_MS
}

fn default_ask_question_timeout_ms() -> u64 {
    DEFAULT_ASK_QUESTION_TIMEOUT_MS
}

fn default_await_question_yield_ms() -> u64 {
    DEFAULT_AWAIT_QUESTION_YIELD_MS
}

fn is_default_ask_question_yield_ms(yield_time_ms: &u64) -> bool {
    *yield_time_ms == DEFAULT_ASK_QUESTION_YIELD_MS
}

fn is_default_ask_question_timeout_ms(timeout_ms: &u64) -> bool {
    *timeout_ms == DEFAULT_ASK_QUESTION_TIMEOUT_MS
}

fn is_default_await_question_yield_ms(yield_time_ms: &u64) -> bool {
    *yield_time_ms == DEFAULT_AWAIT_QUESTION_YIELD_MS
}

fn ask_question_parameters() -> serde_json::Value {
    let mut schema = json!(schemars::schema_for!(AskQuestionArgs));
    schema["properties"]["yieldTimeMs"]["default"] = json!(DEFAULT_ASK_QUESTION_YIELD_MS);
    schema["properties"]["timeoutMs"]["default"] = json!(DEFAULT_ASK_QUESTION_TIMEOUT_MS);
    schema
}

fn await_question_parameters() -> serde_json::Value {
    let mut schema = json!(schemars::schema_for!(AwaitQuestionArgs));
    schema["properties"]["yieldTimeMs"]["default"] = json!(DEFAULT_AWAIT_QUESTION_YIELD_MS);
    schema
}

fn exec_command_parameters() -> serde_json::Value {
    let mut schema = json!(schemars::schema_for!(ExecCommandArgs));
    schema["properties"]["workdir"]["default"] = json!(default_workdir());
    schema["properties"]["shell"]["default"] = json!(default_command_shell());
    schema["properties"]["timeoutMs"]["default"] = json!(DEFAULT_COMMAND_TIMEOUT_MS);
    schema["properties"]["yieldTimeMs"]["default"] = json!(DEFAULT_COMMAND_YIELD_MS);
    schema["properties"]["maxOutputChars"]["default"] = json!(DEFAULT_COMMAND_MAX_OUTPUT_CHARS);
    schema
}

fn write_stdin_parameters() -> serde_json::Value {
    let mut schema = json!(schemars::schema_for!(WriteStdinArgs));
    schema["properties"]["chars"]["default"] = json!("");
    schema["properties"]["terminate"]["default"] = json!(false);
    schema["properties"]["yieldTimeMs"]["default"] = json!(DEFAULT_STDIN_YIELD_MS);
    schema
}

fn default_web_search_results() -> u32 {
    DEFAULT_WEB_SEARCH_RESULTS
}

fn is_default_web_search_results(num_results: &u32) -> bool {
    *num_results == DEFAULT_WEB_SEARCH_RESULTS
}

fn web_search_parameters() -> serde_json::Value {
    let mut schema = json!(schemars::schema_for!(WebSearchArgs));
    schema["properties"]["numResults"]["default"] = json!(DEFAULT_WEB_SEARCH_RESULTS);
    schema
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
pub(crate) struct ExecCommandArgs {
    /// Shell command to execute.
    cmd: String,
    /// Working directory. Absolute paths and `~` may be anywhere on the machine; relative paths resolve from the project root. Defaults to `.`.
    #[serde(
        default = "default_workdir",
        skip_serializing_if = "is_default_workdir"
    )]
    #[schemars(default = "default_workdir")]
    workdir: String,
    /// Shell binary to launch. Defaults to the user's shell.
    #[serde(
        default = "default_command_shell",
        skip_serializing_if = "is_default_shell"
    )]
    #[schemars(default = "default_command_shell")]
    shell: String,
    /// Command timeout in milliseconds. Defaults to 60000.
    #[serde(
        rename = "timeoutMs",
        default = "default_timeout_ms",
        skip_serializing_if = "is_default_timeout_ms"
    )]
    #[schemars(default = "default_timeout_ms")]
    timeout_ms: u64,
    /// Wait before yielding a running session, in milliseconds. Defaults to 10000.
    #[serde(
        rename = "yieldTimeMs",
        default = "default_command_yield_ms",
        skip_serializing_if = "is_default_command_yield_ms"
    )]
    #[schemars(default = "default_command_yield_ms")]
    yield_time_ms: u64,
    /// Maximum combined output characters returned to the model.
    #[serde(
        rename = "maxOutputChars",
        default = "default_max_output_chars",
        skip_serializing_if = "is_default_max_output_chars"
    )]
    #[schemars(default = "default_max_output_chars")]
    max_output_chars: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
pub(crate) struct WriteStdinArgs {
    /// Running command session identifier returned by exec_command.
    #[serde(rename = "sessionId")]
    session_id: String,
    /// Characters to write to the command's standard input.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    chars: String,
    /// Terminate the command and its descendants.
    #[serde(default, skip_serializing_if = "is_false")]
    terminate: bool,
    /// Wait for more output or completion, in milliseconds. Defaults to 5000.
    #[serde(
        rename = "yieldTimeMs",
        default = "default_stdin_yield_ms",
        skip_serializing_if = "is_default_stdin_yield_ms"
    )]
    #[schemars(default = "default_stdin_yield_ms")]
    yield_time_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
pub(crate) struct ApplyPatchArgs {
    /// Prefer Begin Patch format.
    /// For Begin Patch, use `@@` or `@@ anchor`, never unified `@@ -n,m +p,q @@`.
    /// Supports `*** Delete File:`, `*** Move to:`, `*** Copy File:` / `*** Copy to:`.
    /// Unified/`diff --git` also accepted; well-formed hunk line counts are auto-corrected.
    /// Example:
    /// *** Begin Patch
    /// *** Add File: path/to/new.txt
    /// +hello
    /// *** Update File: path/to/existing.txt
    /// @@
    /// -old
    /// +new
    /// *** End Patch
    patch: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
pub(crate) struct WebSearchArgs {
    /// Web search query.
    query: String,
    /// Number of results to return, between 1 and 10. Defaults to 5.
    #[serde(
        rename = "numResults",
        default = "default_web_search_results",
        skip_serializing_if = "is_default_web_search_results"
    )]
    #[schemars(default = "default_web_search_results")]
    num_results: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
pub(crate) struct ScrapeUrlArgs {
    /// URL of the web page to read.
    url: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
pub(crate) struct CreateArtifactArgs {
    /// Title for the artifact.
    title: String,
    #[serde(rename = "contentType")]
    content_type: ArtifactContentType,
    /// Full content of the artifact.
    content: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ArtifactContentType {
    Markdown,
    Html,
    React,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
pub(crate) struct UpdateArtifactArgs {
    /// ID of the artifact to update.
    #[serde(rename = "artifactId")]
    artifact_id: String,
    /// The new full content of the artifact.
    content: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
pub(crate) struct ReadSkillArgs {
    /// Skill name from the Skills section of the system instructions.
    name: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
pub(crate) struct AskQuestionOption {
    /// Stable option identifier returned with the user's answer.
    id: String,
    /// Option text shown to the user.
    label: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
pub(crate) struct AskQuestionArgs {
    /// Question shown above the composer.
    question: String,
    /// Answer choices. Provide 1-4 options; a "Let me (the agent) decide" option is appended automatically.
    options: Vec<AskQuestionOption>,
    /// Wait for an answer before yielding a questionId, in milliseconds. Use 0 to return immediately.
    #[serde(
        rename = "yieldTimeMs",
        default = "default_ask_question_yield_ms",
        skip_serializing_if = "is_default_ask_question_yield_ms"
    )]
    #[schemars(default = "default_ask_question_yield_ms")]
    yield_time_ms: u64,
    /// Expire the unanswered question after this many milliseconds.
    #[serde(
        rename = "timeoutMs",
        default = "default_ask_question_timeout_ms",
        skip_serializing_if = "is_default_ask_question_timeout_ms"
    )]
    #[schemars(default = "default_ask_question_timeout_ms")]
    timeout_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
pub(crate) struct AwaitQuestionArgs {
    /// Question identifier returned by ask_question when still pending.
    #[serde(rename = "questionId")]
    question_id: String,
    /// Wait for an answer or timeout, in milliseconds.
    #[serde(
        rename = "yieldTimeMs",
        default = "default_await_question_yield_ms",
        skip_serializing_if = "is_default_await_question_yield_ms"
    )]
    #[schemars(default = "default_await_question_yield_ms")]
    yield_time_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct QuestionAnswer {
    #[serde(skip_serializing_if = "Option::is_none")]
    option_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    option_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QuestionSnapshot {
    question_id: String,
    question: String,
    options: Vec<AskQuestionOption>,
    status: String,
    answer: Option<QuestionAnswer>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateQuestionResponse {
    question_id: String,
    question: String,
    options: Vec<AskQuestionOption>,
}

impl rig::tool::Tool for ExecCommandTool {
    const NAME: &'static str = "exec_command";
    type Error = AgentToolError;
    type Args = ExecCommandArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        "Run a shell command with full machine access. Long-running commands yield a sessionId for write_stdin polling and input."
            .to_string()
    }

    fn parameters(&self) -> serde_json::Value {
        exec_command_parameters()
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        execute_tool_job(
            &self.0.runtime,
            &self.0.run_id,
            &self.0.claim_id,
            Self::NAME,
            &self.0.tool_call_tracker,
            serde_json::to_value(&args).map_err(|e| tool_error(e.into()))?,
            |cancellation| async {
                let output = self
                    .0
                    .command_sessions
                    .exec_command(
                        cancellation,
                        &args.cmd,
                        &args.workdir,
                        &args.shell,
                        args.timeout_ms,
                        args.yield_time_ms,
                        args.max_output_chars,
                    )
                    .await
                    .map_err(tool_error)?;
                serde_json::to_value(output).map_err(|e| tool_error(e.into()))
            },
        )
        .await
    }
}

impl rig::tool::Tool for WriteStdinTool {
    const NAME: &'static str = "write_stdin";
    type Error = AgentToolError;
    type Args = WriteStdinArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        "Write input to a running exec_command session, poll incremental output, wait for completion, or terminate the process tree."
            .to_string()
    }

    fn parameters(&self) -> serde_json::Value {
        write_stdin_parameters()
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        execute_tool_job(
            &self.0.runtime,
            &self.0.run_id,
            &self.0.claim_id,
            Self::NAME,
            &self.0.tool_call_tracker,
            serde_json::to_value(&args).map_err(|e| tool_error(e.into()))?,
            |cancellation| async {
                let output = self
                    .0
                    .command_sessions
                    .write_stdin(
                        cancellation,
                        &args.session_id,
                        &args.chars,
                        args.terminate,
                        args.yield_time_ms,
                    )
                    .await
                    .map_err(tool_error)?;
                serde_json::to_value(output).map_err(|e| tool_error(e.into()))
            },
        )
        .await
    }
}

impl rig::tool::Tool for AskQuestionTool {
    const NAME: &'static str = "ask_question";
    type Error = AgentToolError;
    type Args = AskQuestionArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        format!(
            "Ask the user a multiple-choice question above the composer. Waits up to yieldTimeMs for an answer, otherwise returns a questionId for await_question."
        )
    }

    fn parameters(&self) -> serde_json::Value {
        ask_question_parameters()
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        let prepared = prepare_ask_question(&args)?;
        let payload = serde_json::to_value(&args).map_err(|e| tool_error(e.into()))?;
        execute_tool_job(
            &self.0.runtime,
            &self.0.run_id,
            &self.0.claim_id,
            Self::NAME,
            &self.0.tool_call_tracker,
            payload,
            |cancellation| {
                let runtime = self.0.runtime.clone();
                let run_id = self.0.run_id.clone();
                let claim_id = self.0.claim_id.clone();
                async move {
                    let created = create_agent_question(
                        &runtime,
                        &run_id,
                        &claim_id,
                        &prepared.question,
                        &prepared.options,
                        args.timeout_ms,
                    )
                    .await?;
                    observe_question(
                        &runtime,
                        &run_id,
                        &created.question_id,
                        &created.question,
                        &created.options,
                        args.yield_time_ms,
                        cancellation,
                    )
                    .await
                }
            },
        )
        .await
    }
}

impl rig::tool::Tool for AwaitQuestionTool {
    const NAME: &'static str = "await_question";
    type Error = AgentToolError;
    type Args = AwaitQuestionArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        "Wait for a previously yielded ask_question result. Poll with yieldTimeMs until answered, timed out, or still pending."
            .to_string()
    }

    fn parameters(&self) -> serde_json::Value {
        await_question_parameters()
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        if args.question_id.trim().is_empty() {
            return Err(AgentToolError::Message(
                "questionId cannot be empty".to_string(),
            ));
        }
        let payload = serde_json::to_value(&args).map_err(|e| tool_error(e.into()))?;
        execute_tool_job(
            &self.0.runtime,
            &self.0.run_id,
            &self.0.claim_id,
            Self::NAME,
            &self.0.tool_call_tracker,
            payload,
            |cancellation| {
                let runtime = self.0.runtime.clone();
                let run_id = self.0.run_id.clone();
                let question_id = args.question_id.clone();
                async move {
                    let snapshot = fetch_question_snapshot(&runtime, &run_id, &question_id).await?;
                    let Some(snapshot) = snapshot else {
                        return Err(AgentToolError::Message(format!(
                            "Unknown questionId '{question_id}'"
                        )));
                    };
                    // Avoid racing the yield deadline against a slow first subscription
                    // update when the question is already terminal.
                    if snapshot.status != "pending" {
                        return question_result_from_snapshot(&snapshot);
                    }
                    observe_question(
                        &runtime,
                        &run_id,
                        &snapshot.question_id,
                        &snapshot.question,
                        &snapshot.options,
                        args.yield_time_ms,
                        cancellation,
                    )
                    .await
                }
            },
        )
        .await
    }
}

impl rig::tool::Tool for ApplyPatchTool {
    const NAME: &'static str = "apply_patch";
    type Error = AgentToolError;
    type Args = ApplyPatchArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        "Use to create, update, delete, rename, or copy files.".to_string()
    }

    fn parameters(&self) -> serde_json::Value {
        json!(schemars::schema_for!(ApplyPatchArgs))
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        execute_tool_job(
            &self.0.runtime,
            &self.0.run_id,
            &self.0.claim_id,
            Self::NAME,
            &self.0.tool_call_tracker,
            serde_json::to_value(&args).map_err(|e| tool_error(e.into()))?,
            |cancellation| async {
                let output =
                    apply_workspace_patch(self.0.workspace_root.clone(), cancellation, &args.patch)
                        .await
                        .map_err(tool_error)?;
                serde_json::to_value(output).map_err(|e| tool_error(e.into()))
            },
        )
        .await
    }
}

impl rig::tool::Tool for WebSearchTool {
    const NAME: &'static str = "web_search";
    type Error = AgentToolError;
    type Args = WebSearchArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        "Search the web. Returns relevant pages with their URL, title, and a text excerpt. Use for current events or information beyond the local workspace."
            .to_string()
    }

    fn parameters(&self) -> serde_json::Value {
        web_search_parameters()
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        let payload = serde_json::to_value(&args).map_err(|e| tool_error(e.into()))?;
        execute_tool_job(
            &self.0.runtime,
            &self.0.run_id,
            &self.0.claim_id,
            Self::NAME,
            &self.0.tool_call_tracker,
            payload,
            |cancellation| {
                let mut action_args = BTreeMap::new();
                action_args.insert("runId".to_string(), self.0.run_id.clone().into());
                action_args.insert("claimId".to_string(), self.0.claim_id.clone().into());
                action_args.insert("query".to_string(), args.query.clone().into());
                // Omitted at the default so the Convex action owns the default value.
                if !is_default_web_search_results(&args.num_results) {
                    action_args.insert(
                        "numResults".to_string(),
                        Value::Float64(f64::from(args.num_results)),
                    );
                }
                run_convex_tool_action(
                    &self.0.runtime,
                    cancellation,
                    "webTools:webSearch",
                    action_args,
                )
            },
        )
        .await
    }
}

impl rig::tool::Tool for ScrapeUrlTool {
    const NAME: &'static str = "scrape_url";
    type Error = AgentToolError;
    type Args = ScrapeUrlArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        "Read a web page by URL and return its content converted to markdown. Very long pages are truncated."
            .to_string()
    }

    fn parameters(&self) -> serde_json::Value {
        json!(schemars::schema_for!(ScrapeUrlArgs))
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        let payload = serde_json::to_value(&args).map_err(|e| tool_error(e.into()))?;
        execute_tool_job(
            &self.0.runtime,
            &self.0.run_id,
            &self.0.claim_id,
            Self::NAME,
            &self.0.tool_call_tracker,
            payload,
            |cancellation| {
                let mut action_args = BTreeMap::new();
                action_args.insert("runId".to_string(), self.0.run_id.clone().into());
                action_args.insert("claimId".to_string(), self.0.claim_id.clone().into());
                action_args.insert("url".to_string(), args.url.clone().into());
                run_convex_tool_action(
                    &self.0.runtime,
                    cancellation,
                    "webTools:scrapeUrl",
                    action_args,
                )
            },
        )
        .await
    }
}

impl rig::tool::Tool for CreateArtifactTool {
    const NAME: &'static str = "create_artifact";
    type Error = AgentToolError;
    type Args = CreateArtifactArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        "Create a markdown/html/react artifact that's rendered for the user.".to_string()
    }

    fn parameters(&self) -> serde_json::Value {
        json!(schemars::schema_for!(CreateArtifactArgs))
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        let payload = serde_json::to_value(&args).map_err(|e| tool_error(e.into()))?;
        execute_tool_job(
            &self.0.runtime,
            &self.0.run_id,
            &self.0.claim_id,
            Self::NAME,
            &self.0.tool_call_tracker,
            payload.clone(),
            |cancellation| async {
                let mutation_args =
                    mutation_args_from_payload(&self.0.run_id, &self.0.claim_id, &payload)?;
                run_convex_tool_mutation(
                    &self.0.runtime,
                    cancellation,
                    "artifacts:createArtifact",
                    mutation_args,
                )
                .await
            },
        )
        .await
    }
}

impl rig::tool::Tool for UpdateArtifactTool {
    const NAME: &'static str = "update_artifact";
    type Error = AgentToolError;
    type Args = UpdateArtifactArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        "Replace an existing artifact's content, creating a new version.".to_string()
    }

    fn parameters(&self) -> serde_json::Value {
        json!(schemars::schema_for!(UpdateArtifactArgs))
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        let payload = serde_json::to_value(&args).map_err(|e| tool_error(e.into()))?;
        execute_tool_job(
            &self.0.runtime,
            &self.0.run_id,
            &self.0.claim_id,
            Self::NAME,
            &self.0.tool_call_tracker,
            payload.clone(),
            |cancellation| async {
                let mutation_args =
                    mutation_args_from_payload(&self.0.run_id, &self.0.claim_id, &payload)?;
                run_convex_tool_mutation(
                    &self.0.runtime,
                    cancellation,
                    "artifacts:appendArtifactVersion",
                    mutation_args,
                )
                .await
            },
        )
        .await
    }
}

impl rig::tool::Tool for ReadSkillTool {
    const NAME: &'static str = "read_skill";
    type Error = AgentToolError;
    type Args = ReadSkillArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        "Read a skill's SKILL.md instructions by name. Use when a task matches a skill listed in the Skills section of your instructions."
            .to_string()
    }

    fn parameters(&self) -> serde_json::Value {
        json!(schemars::schema_for!(ReadSkillArgs))
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        let payload = serde_json::to_value(&args).map_err(|e| tool_error(e.into()))?;
        let skills = self.skills.clone();
        execute_tool_job(
            &self.context.runtime,
            &self.context.run_id,
            &self.context.claim_id,
            Self::NAME,
            &self.context.tool_call_tracker,
            payload,
            |_cancellation| async move {
                let output = resolve_read_skill(&skills, &args.name)?;
                Ok(output)
            },
        )
        .await
    }
}

pub(crate) fn resolve_read_skill(
    skills: &[WorkspaceSkill],
    name: &str,
) -> Result<serde_json::Value, AgentToolError> {
    let Some(skill) = skills.iter().find(|skill| skill.name == name) else {
        let available = if skills.is_empty() {
            "(none)".to_string()
        } else {
            skills
                .iter()
                .map(|skill| skill.name.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        };
        return Err(AgentToolError::Message(format!(
            "Unknown skill '{name}'. Available skills: {available}"
        )));
    };

    let content = read_skill_content(skill).map_err(|e| tool_error(anyhow::Error::msg(e)))?;
    let mut value = json!({
        "name": content.name,
        "description": content.description,
        "content": content.content,
    });
    if let Some(dir) = content.dir {
        value["dir"] = json!(dir);
    }
    if content.truncated {
        value["truncated"] = json!(true);
    }
    Ok(value)
}

#[derive(Clone, Debug)]
struct PreparedAskQuestion {
    question: String,
    options: Vec<AskQuestionOption>,
}

fn prepare_ask_question(args: &AskQuestionArgs) -> Result<PreparedAskQuestion, AgentToolError> {
    let question = args.question.trim();
    if question.is_empty() {
        return Err(AgentToolError::Message(
            "Question cannot be empty.".to_string(),
        ));
    }
    if question.chars().count() > MAX_QUESTION_CHARS {
        return Err(AgentToolError::Message(format!(
            "Question cannot exceed {MAX_QUESTION_CHARS} characters."
        )));
    }
    if args.options.len() < MIN_AGENT_OPTIONS || args.options.len() > MAX_AGENT_OPTIONS {
        return Err(AgentToolError::Message(format!(
            "Provide between {MIN_AGENT_OPTIONS} and {MAX_AGENT_OPTIONS} options (the agent-decide option is added automatically)."
        )));
    }

    let mut seen = HashSet::new();
    let mut options = Vec::with_capacity(args.options.len());
    for option in &args.options {
        let id = option.id.trim();
        let label = option.label.trim();
        if id.is_empty() {
            return Err(AgentToolError::Message(
                "Option id cannot be empty.".to_string(),
            ));
        }
        if label.is_empty() {
            return Err(AgentToolError::Message(
                "Option label cannot be empty.".to_string(),
            ));
        }
        if id.chars().count() > MAX_OPTION_ID_CHARS {
            return Err(AgentToolError::Message(format!(
                "Option id cannot exceed {MAX_OPTION_ID_CHARS} characters."
            )));
        }
        if label.chars().count() > MAX_OPTION_LABEL_CHARS {
            return Err(AgentToolError::Message(format!(
                "Option label cannot exceed {MAX_OPTION_LABEL_CHARS} characters."
            )));
        }
        if id == AGENT_DECIDE_OPTION_ID {
            return Err(AgentToolError::Message(format!(
                "Option id '{AGENT_DECIDE_OPTION_ID}' is reserved."
            )));
        }
        if !seen.insert(id.to_string()) {
            return Err(AgentToolError::Message(format!(
                "Duplicate option id '{id}'."
            )));
        }
        options.push(AskQuestionOption {
            id: id.to_string(),
            label: label.to_string(),
        });
    }

    Ok(PreparedAskQuestion {
        question: question.to_string(),
        options,
    })
}

async fn create_agent_question(
    runtime: &RuntimeClient,
    run_id: &str,
    claim_id: &str,
    question: &str,
    options: &[AskQuestionOption],
    timeout_ms: u64,
) -> Result<CreateQuestionResponse, AgentToolError> {
    let mut args = BTreeMap::new();
    args.insert("runId".to_string(), run_id.to_string().into());
    args.insert("claimId".to_string(), claim_id.to_string().into());
    args.insert("question".to_string(), question.to_string().into());
    args.insert(
        "options".to_string(),
        Value::try_from(serde_json::to_value(options).map_err(|e| tool_error(e.into()))?)
            .map_err(tool_error)?,
    );
    args.insert("timeoutMs".to_string(), Value::Float64(timeout_ms as f64));
    runtime
        .mutation_json("agentQuestions:create", args)
        .await
        .map_err(tool_error)
}

async fn fetch_question_snapshot(
    runtime: &RuntimeClient,
    run_id: &str,
    question_id: &str,
) -> Result<Option<QuestionSnapshot>, AgentToolError> {
    let mut args = BTreeMap::new();
    args.insert("runId".to_string(), run_id.to_string().into());
    args.insert("questionId".to_string(), question_id.to_string().into());
    runtime
        .query_json(GET_QUESTION_FUNCTION, args)
        .await
        .map_err(tool_error)
}

fn pending_question_result(
    question_id: &str,
    question: &str,
    options: &[AskQuestionOption],
) -> serde_json::Value {
    json!({
        "questionId": question_id,
        "question": question,
        "options": options,
        "pending": true,
        "timedOut": false,
    })
}

fn question_result_from_snapshot(
    snapshot: &QuestionSnapshot,
) -> Result<serde_json::Value, AgentToolError> {
    match snapshot.status.as_str() {
        "pending" => Ok(pending_question_result(
            &snapshot.question_id,
            &snapshot.question,
            &snapshot.options,
        )),
        "answered" => Ok(json!({
            "questionId": snapshot.question_id,
            "question": snapshot.question,
            "options": snapshot.options,
            "pending": false,
            "timedOut": false,
            "answer": snapshot.answer,
        })),
        "timedOut" => Ok(json!({
            "questionId": snapshot.question_id,
            "question": snapshot.question,
            "options": snapshot.options,
            "pending": false,
            "timedOut": true,
        })),
        "cancelled" => Err(AgentToolError::Cancelled),
        other => Err(AgentToolError::Message(format!(
            "Unexpected question status '{other}'"
        ))),
    }
}

async fn observe_question(
    runtime: &RuntimeClient,
    run_id: &str,
    question_id: &str,
    question: &str,
    options: &[AskQuestionOption],
    yield_time_ms: u64,
    cancellation: WorkspaceCancellation,
) -> Result<serde_json::Value, AgentToolError> {
    let mut args = BTreeMap::new();
    args.insert("runId".to_string(), run_id.to_string().into());
    args.insert("questionId".to_string(), question_id.to_string().into());
    let mut updates = runtime
        .subscribe(GET_QUESTION_FUNCTION, args)
        .await
        .map_err(tool_error)?;

    let deadline = if yield_time_ms == 0 {
        None
    } else {
        Some(Instant::now() + Duration::from_millis(yield_time_ms))
    };

    loop {
        if cancellation.is_cancelled() {
            return Err(AgentToolError::Cancelled);
        }

        let update = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(AgentToolError::Cancelled),
            // Prefer subscription updates over the yield deadline so an answer/timeout
            // that arrives in the same tick is not reported as still pending.
            update = updates.next() => update,
            _ = async {
                if let Some(deadline) = deadline {
                    sleep(deadline.saturating_duration_since(Instant::now())).await;
                } else {
                    std::future::pending::<()>().await;
                }
            }, if deadline.is_some() => {
                // Last-chance read: an answer may have landed without the
                // subscription delivering before the yield deadline.
                if let Some(snapshot) =
                    fetch_question_snapshot(runtime, run_id, question_id).await?
                {
                    if snapshot.status != "pending" {
                        return question_result_from_snapshot(&snapshot);
                    }
                }
                return Ok(pending_question_result(question_id, question, options));
            },
        };

        let Some(update) = update else {
            return Err(AgentToolError::Message(
                "question subscription closed".to_string(),
            ));
        };
        let snapshot: Option<QuestionSnapshot> =
            RuntimeClient::decode_subscription_update(update, GET_QUESTION_FUNCTION)
                .map_err(tool_error)?;
        let Some(snapshot) = snapshot else {
            return Err(AgentToolError::Message(format!(
                "Unknown questionId '{question_id}'"
            )));
        };
        if snapshot.status != "pending" {
            return question_result_from_snapshot(&snapshot);
        }
        if yield_time_ms == 0 {
            return Ok(pending_question_result(question_id, question, options));
        }
    }
}

/// Runs a tool's work as a Convex action, aborting the wait when the run is
/// cancelled. The action itself keeps running server-side; its job record is
/// reconciled by the normal completion flow.
async fn run_convex_tool_action(
    runtime: &RuntimeClient,
    cancellation: WorkspaceCancellation,
    function: &str,
    args: BTreeMap<String, Value>,
) -> Result<serde_json::Value, AgentToolError> {
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err(AgentToolError::Cancelled),
        result = runtime.action_json::<serde_json::Value>(function, args) => {
            result.map_err(tool_error)
        }
    }
}

/// Runs a tool's work as a Convex mutation. Cancellation only aborts the wait;
/// the mutation still commits server-side if it already started.
async fn run_convex_tool_mutation(
    runtime: &RuntimeClient,
    cancellation: WorkspaceCancellation,
    function: &str,
    args: BTreeMap<String, Value>,
) -> Result<serde_json::Value, AgentToolError> {
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err(AgentToolError::Cancelled),
        result = runtime.mutation_json::<serde_json::Value>(function, args) => {
            result.map_err(tool_error)
        }
    }
}

/// Merge run claim fields with a serialized tool-args object for a Convex mutation.
fn mutation_args_from_payload(
    run_id: &str,
    claim_id: &str,
    payload: &serde_json::Value,
) -> Result<BTreeMap<String, Value>, AgentToolError> {
    let mut mutation_args = BTreeMap::new();
    mutation_args.insert("runId".to_string(), run_id.to_string().into());
    mutation_args.insert("claimId".to_string(), claim_id.to_string().into());
    let Some(fields) = payload.as_object() else {
        return Err(AgentToolError::Message(
            "artifact tool payload must be an object".to_string(),
        ));
    };
    for (key, value) in fields {
        mutation_args.insert(
            key.clone(),
            Value::try_from(value.clone()).map_err(tool_error)?,
        );
    }
    Ok(mutation_args)
}

async fn execute_tool_job<F, Fut>(
    runtime: &RuntimeClient,
    run_id: &str,
    claim_id: &str,
    kind: &str,
    tool_call_tracker: &ToolCallTracker,
    payload: serde_json::Value,
    operation: F,
) -> Result<serde_json::Value, AgentToolError>
where
    F: FnOnce(WorkspaceCancellation) -> Fut,
    Fut: std::future::Future<Output = Result<serde_json::Value, AgentToolError>>,
{
    eprintln!("sprocket-agent: starting tool {} for run {}", kind, run_id);
    let mut run_updates = runtime
        .run_finished_subscription(run_id)
        .await
        .map_err(tool_error)?;
    let initial_update = run_updates
        .next()
        .await
        .ok_or_else(|| AgentToolError::Message("run status subscription closed".to_string()))?;
    let initial_run_finished =
        RuntimeClient::decode_run_finished_update(initial_update).map_err(tool_error)?;
    if initial_run_finished {
        return Err(AgentToolError::Cancelled);
    }

    let mut begin_args = BTreeMap::new();
    begin_args.insert("runId".to_string(), run_id.to_string().into());
    begin_args.insert("claimId".to_string(), claim_id.to_string().into());
    begin_args.insert("kind".to_string(), kind.to_string().into());
    if let Some(call_id) = tool_call_tracker.claim(kind, &payload) {
        begin_args.insert("callId".to_string(), call_id.into());
    }
    begin_args.insert(
        "payload".to_string(),
        Value::try_from(payload.clone()).map_err(tool_error)?,
    );
    let begin_result: serde_json::Value = runtime
        .mutation_json("agentRuntime:beginToolJob", begin_args)
        .await
        .map_err(tool_error)?;
    let job_id = begin_result
        .get("jobId")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| AgentToolError::Message("beginToolJob did not return a jobId".to_string()))?
        .to_string();

    let cancellation = WorkspaceCancellation::new();
    let operation = operation(cancellation.clone());
    tokio::pin!(operation);
    let operation_result = loop {
        tokio::select! {
            biased;
            update = run_updates.next() => {
                let Some(update) = update else {
                    cancellation.cancel();
                    let _ = operation.await;
                    break Err(AgentToolError::Message("run status subscription closed".to_string()));
                };
                match RuntimeClient::decode_run_finished_update(update) {
                    Ok(false) => {}
                    Ok(true) => {
                        cancellation.cancel();
                        let _ = operation.await;
                        eprintln!("sprocket-agent: cancelled tool {} for run {}", kind, run_id);
                        return Err(AgentToolError::Cancelled);
                    }
                    Err(error) => {
                        cancellation.cancel();
                        let _ = operation.await;
                        break Err(tool_error(anyhow::anyhow!("run status subscription failed: {error}")));
                    }
                }
            },
            result = &mut operation => break result,
        }
    };

    match operation_result {
        Ok(output) => {
            eprintln!("sprocket-agent: completed tool {} for run {}", kind, run_id);
            let mut complete_args = BTreeMap::new();
            complete_args.insert("jobId".to_string(), job_id.into());
            complete_args.insert("runId".to_string(), run_id.to_string().into());
            complete_args.insert("claimId".to_string(), claim_id.to_string().into());
            complete_args.insert(
                "result".to_string(),
                Value::try_from(output.clone()).map_err(tool_error)?,
            );
            let accepted: bool = runtime
                .mutation_json("executor:complete", complete_args)
                .await
                .map_err(tool_error)?;
            if accepted {
                Ok(output)
            } else {
                Err(AgentToolError::Cancelled)
            }
        }
        Err(error) => {
            eprintln!(
                "sprocket-agent: failed tool {} for run {}: {}",
                kind, run_id, error
            );
            // Terminal runs already cancel claimed jobs via
            // cancelExecutorJobsForTerminalRun in finalizeRunRecord.
            if matches!(error, AgentToolError::Cancelled) {
                return Err(AgentToolError::Cancelled);
            }
            let mut fail_args = BTreeMap::new();
            fail_args.insert("jobId".to_string(), job_id.into());
            fail_args.insert("runId".to_string(), run_id.to_string().into());
            fail_args.insert("claimId".to_string(), claim_id.to_string().into());
            fail_args.insert("error".to_string(), error.to_string().into());
            let accepted: bool = runtime
                .mutation_json("executor:fail", fail_args)
                .await
                .map_err(tool_error)?;
            if accepted {
                Err(error)
            } else {
                Err(AgentToolError::Cancelled)
            }
        }
    }
}

fn tool_error(error: anyhow::Error) -> AgentToolError {
    if error.is::<WorkspaceOperationCancelled>() {
        AgentToolError::Cancelled
    } else {
        AgentToolError::Message(format!("{error:#}"))
    }
}

#[cfg(test)]
mod tests {
    use sprocket_workspace::{SkillSource, WorkspaceSkill};

    use super::*;

    #[test]
    fn tool_error_includes_anyhow_context_chain() {
        let error =
            anyhow::anyhow!("invalid add-file line").context("failed to parse Begin Patch input");
        match tool_error(error) {
            AgentToolError::Message(message) => {
                assert!(
                    message.contains("failed to parse Begin Patch input"),
                    "missing outer context: {message}"
                );
                assert!(
                    message.contains("invalid add-file line"),
                    "missing root cause: {message}"
                );
            }
            AgentToolError::Cancelled => panic!("expected message error"),
        }
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
