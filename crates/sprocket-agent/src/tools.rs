use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

use convex::Value;
use futures::StreamExt;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sprocket_workspace::{
    CommandSessionManager, WorkspaceCancellation, WorkspaceSkill, apply_workspace_patch,
    default_command_shell, read_skill_content,
};

const DEFAULT_COMMAND_TIMEOUT_MS: u64 = 60_000;
const DEFAULT_COMMAND_YIELD_MS: u64 = 10_000;
const DEFAULT_COMMAND_MAX_OUTPUT_CHARS: usize = 20_000;
const DEFAULT_STDIN_YIELD_MS: u64 = 5_000;
const DEFAULT_WEB_SEARCH_RESULTS: u32 = 5;

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
pub(crate) struct ExecCommandTool(AgentToolContext);

#[derive(Clone)]
pub(crate) struct ScrapeUrlTool(AgentToolContext);

#[derive(Clone)]
pub(crate) struct WebSearchTool(AgentToolContext);

#[derive(Clone)]
pub(crate) struct WriteStdinTool(AgentToolContext);

#[derive(Clone)]
pub(crate) struct ReadSkillTool {
    context: AgentToolContext,
    skills: Arc<[WorkspaceSkill]>,
}

pub(crate) struct AgentToolSet {
    pub(crate) apply_patch: ApplyPatchTool,
    pub(crate) exec_command: ExecCommandTool,
    pub(crate) read_skill: ReadSkillTool,
    pub(crate) scrape_url: ScrapeUrlTool,
    pub(crate) web_search: WebSearchTool,
    pub(crate) write_stdin: WriteStdinTool,
}

pub(crate) fn agent_tools(
    runtime: RuntimeClient,
    run_id: String,
    claim_id: String,
    workspace_root: PathBuf,
    command_sessions: CommandSessionManager,
    tool_call_tracker: ToolCallTracker,
    skills: Arc<[WorkspaceSkill]>,
) -> AgentToolSet {
    let context = AgentToolContext::new(
        runtime,
        run_id,
        claim_id,
        workspace_root,
        tool_call_tracker,
        command_sessions,
    );
    AgentToolSet {
        apply_patch: ApplyPatchTool(context.clone()),
        exec_command: ExecCommandTool(context.clone()),
        read_skill: ReadSkillTool {
            context: context.clone(),
            skills,
        },
        scrape_url: ScrapeUrlTool(context.clone()),
        web_search: WebSearchTool(context.clone()),
        write_stdin: WriteStdinTool(context),
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
    /// Begin Patch envelope or unified/`diff --git` patch.
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
pub(crate) struct ReadSkillArgs {
    /// Skill name from the Skills section of the system instructions.
    name: String,
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
        let session_id = self.0.command_sessions.reserve_session_id();
        let mut payload = serde_json::to_value(&args).map_err(tool_error)?;
        payload["sessionId"] = session_id.clone().into();
        execute_tool_job(
            &self.0.runtime,
            &self.0.run_id,
            &self.0.claim_id,
            Self::NAME,
            &self.0.tool_call_tracker,
            payload,
            |cancellation| async {
                let output = self
                    .0
                    .command_sessions
                    .exec_command_with_session_id(
                        cancellation,
                        session_id,
                        &args.cmd,
                        &args.workdir,
                        &args.shell,
                        args.timeout_ms,
                        args.yield_time_ms,
                        args.max_output_chars,
                    )
                    .await
                    .map_err(tool_error)?;
                serde_json::to_value(output).map_err(tool_error)
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
            serde_json::to_value(&args).map_err(tool_error)?,
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
                serde_json::to_value(output).map_err(tool_error)
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
        "Create, update, delete, rename, or copy workspace files via a Begin Patch envelope or unified/`diff --git` patch."
            .to_string()
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
            serde_json::to_value(&args).map_err(tool_error)?,
            |cancellation| async {
                let output =
                    apply_workspace_patch(self.0.workspace_root.clone(), cancellation, &args.patch)
                        .await
                        .map_err(tool_error)?;
                serde_json::to_value(output).map_err(tool_error)
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
        let payload = serde_json::to_value(&args).map_err(tool_error)?;
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
        let payload = serde_json::to_value(&args).map_err(tool_error)?;
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
        let payload = serde_json::to_value(&args).map_err(tool_error)?;
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

    let content = read_skill_content(skill).map_err(tool_error)?;
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
                        break Err(tool_error(format!("run status subscription failed: {error}")));
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

fn tool_error(error: impl std::fmt::Display) -> AgentToolError {
    AgentToolError::Message(error.to_string())
}

#[cfg(test)]
mod tests {
    use sprocket_workspace::{SkillSource, WorkspaceSkill};

    use super::*;

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
}
