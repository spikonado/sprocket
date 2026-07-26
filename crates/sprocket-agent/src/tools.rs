use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use bashkit::{BashTool as SandboxBashTool, Tool as BashkitToolContract, ToolRequest};
use convex::Value;
use futures::StreamExt;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sprocket_workspace::{
    CommandExecOutput, CommandSessionManager, WorkspaceCancellation, WorkspaceSkill,
    apply_workspace_patch, clone_ref_repo, default_command_shell, read_skill_content,
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
    ref_repos_root: PathBuf,
    tool_call_tracker: ToolCallTracker,
    command_sessions: CommandSessionManager,
}

impl AgentToolContext {
    fn new(
        runtime: RuntimeClient,
        run_id: String,
        claim_id: String,
        workspace_root: PathBuf,
        ref_repos_root: PathBuf,
        tool_call_tracker: ToolCallTracker,
        command_sessions: CommandSessionManager,
    ) -> Self {
        Self {
            runtime,
            run_id,
            claim_id,
            workspace_root,
            ref_repos_root,
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
pub(crate) struct CloneRefRepoTool(AgentToolContext);

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
    pub(crate) clone_ref_repo: CloneRefRepoTool,
    pub(crate) command_sessions: CommandSessionManager,
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
    ref_repos_root: PathBuf,
    tool_call_tracker: ToolCallTracker,
    skills: Arc<[WorkspaceSkill]>,
) -> AgentToolSet {
    let command_sessions = CommandSessionManager::new(workspace_root.clone());
    let context = AgentToolContext::new(
        runtime,
        run_id,
        claim_id,
        workspace_root,
        ref_repos_root,
        tool_call_tracker,
        command_sessions.clone(),
    );
    AgentToolSet {
        apply_patch: ApplyPatchTool(context.clone()),
        clone_ref_repo: CloneRefRepoTool(context.clone()),
        command_sessions,
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
    /// Shell binary to launch. Defaults to the user's shell. Reference-repository commands use
    /// the sandbox shell and reject custom values.
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
    /// Wait before yielding a running session, in milliseconds. Defaults to 10000. Reference-
    /// repository commands run to completion in the sandbox and never yield a session.
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
pub(crate) struct CloneRefRepoArgs {
    /// Git remote URL. HTTPS and SSH remotes from GitHub, GitLab, and other Git hosts are supported.
    url: String,
    /// Optional branch or tag to check out. The remote's default branch is used when omitted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reference: Option<String>,
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
        "Run a shell command. Relative workdirs resolve from the project root. Commands inside the reference-repository cache run through an isolated, read-only sandbox; other commands have full machine access. Long-running host commands yield a sessionId for write_stdin polling and input."
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
            serde_json::to_value(&args).map_err(tool_error)?,
            |cancellation| async {
                let requested_cwd = self.0.command_sessions.requested_workdir(&args.workdir);
                let cwd = self
                    .0
                    .command_sessions
                    .resolve_workdir(&args.workdir)
                    .map_err(tool_error)?;
                let ref_repos_root = match tokio::fs::canonicalize(&self.0.ref_repos_root).await {
                    Ok(root) => Some(root),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                    Err(error) => return Err(tool_error(error)),
                };
                let sandboxed = ref_repos_root
                    .as_deref()
                    .map(|root| ref_repo_workdir(root, &requested_cwd, &cwd))
                    .transpose()?
                    .unwrap_or(false);
                let output = if sandboxed {
                    let ref_repos_root =
                        ref_repos_root.expect("sandboxed workdir has a cache root");
                    exec_ref_repo_command(&ref_repos_root, &cwd, cancellation, &args).await?
                } else {
                    self.0
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
                        .map_err(tool_error)?
                };
                serde_json::to_value(output).map_err(tool_error)
            },
        )
        .await
    }
}

fn ref_repo_workdir(
    ref_repos_root: &Path,
    requested_cwd: &Path,
    resolved_cwd: &Path,
) -> Result<bool, AgentToolError> {
    let requested_inside = requested_cwd.starts_with(ref_repos_root);
    let resolved_inside = resolved_cwd.starts_with(ref_repos_root);
    if requested_inside && !resolved_inside {
        return Err(tool_error(
            "reference-repository workdir resolves outside its cache root",
        ));
    }
    Ok(resolved_inside)
}

impl rig::tool::Tool for CloneRefRepoTool {
    const NAME: &'static str = "clone_ref_repo";
    type Error = AgentToolError;
    type Args = CloneRefRepoArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        "Clone a shallow Git repository snapshot into Sprocket's dedicated reference-repository cache. Returns an absolute path that can be explored with exec_command; commands in that path are automatically sandboxed and read-only. Existing matching snapshots are reused."
            .to_string()
    }

    fn parameters(&self) -> serde_json::Value {
        json!(schemars::schema_for!(CloneRefRepoArgs))
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
                let output = clone_ref_repo(
                    self.0.ref_repos_root.clone(),
                    cancellation,
                    &args.url,
                    args.reference.as_deref(),
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

fn build_ref_repo_bashkit(ref_repos_root: PathBuf, cwd: PathBuf) -> SandboxBashTool {
    let allowed_root = ref_repos_root.clone();
    let mounted_root = ref_repos_root.clone();
    let ref_repos_env = ref_repos_root.to_string_lossy().into_owned();
    SandboxBashTool::builder()
        .username("agent")
        .hostname("sprocket-sandbox")
        .cwd(cwd)
        .env("REF_REPOS", ref_repos_env)
        .configure(move |builder| {
            builder
                .allowed_mount_paths([allowed_root.clone()])
                .mount_real_readonly_at(ref_repos_root.clone(), mounted_root.clone())
        })
        .build()
}

async fn exec_ref_repo_command(
    ref_repos_root: &Path,
    cwd: &Path,
    cancellation: WorkspaceCancellation,
    args: &ExecCommandArgs,
) -> Result<CommandExecOutput, AgentToolError> {
    if args.cmd.trim().is_empty() {
        return Err(tool_error("command cannot be empty"));
    }
    if !is_default_shell(&args.shell) {
        return Err(tool_error(
            "shell cannot be customized for reference-repository commands",
        ));
    }
    if !is_default_command_yield_ms(&args.yield_time_ms) {
        return Err(tool_error(
            "yieldTimeMs cannot be customized for reference-repository commands, which run to completion in the sandbox",
        ));
    }
    let relative_cwd = cwd
        .strip_prefix(ref_repos_root)
        .map_err(|_| tool_error("reference-repository workdir escaped its cache root"))?;
    let virtual_cwd = ref_repos_root.join(relative_cwd);
    let tool = build_ref_repo_bashkit(ref_repos_root.to_path_buf(), virtual_cwd);
    let request = ToolRequest {
        commands: args.cmd.clone(),
        timeout_ms: Some(args.timeout_ms.max(1)),
    };
    let response = tokio::select! {
        biased;
        _ = cancellation.cancelled() => return Err(AgentToolError::Cancelled),
        response = tool.execute(request) => response,
    };

    let combined = combine_output(&response.stdout, &response.stderr);
    let (output, limit_truncated) =
        limit_output_chars(&combined, args.max_output_chars.clamp(1, 80_000));
    let timed_out = response.error.as_deref() == Some("timeout");
    let success = response.exit_code == 0 && response.error.is_none();
    Ok(CommandExecOutput {
        command: args.cmd.clone(),
        cwd: cwd.to_string_lossy().into_owned(),
        session_id: None,
        exit_code: Some(response.exit_code),
        success,
        running: false,
        timed_out,
        stdout: response.stdout,
        stderr: response.stderr,
        output,
        truncated: response.stdout_truncated || response.stderr_truncated || limit_truncated,
        error: response.error,
    })
}

fn combine_output(stdout: &str, stderr: &str) -> String {
    match (stdout.is_empty(), stderr.is_empty()) {
        (true, _) => stderr.to_string(),
        (_, true) => stdout.to_string(),
        (false, false) => format!("{stdout}\n{stderr}"),
    }
}

fn limit_output_chars(contents: &str, max_chars: usize) -> (String, bool) {
    let mut output: String = contents.chars().take(max_chars).collect();
    let truncated = contents.chars().nth(max_chars).is_some();
    if truncated {
        output.push_str("\n\n...[truncated]");
    }
    (output, truncated)
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

    #[test]
    fn ref_repo_workdir_rejects_symlink_escape() {
        let root = Path::new("/data/ref-repos");
        let error = ref_repo_workdir(
            root,
            Path::new("/data/ref-repos/example/escape"),
            Path::new("/outside"),
        )
        .expect_err("a lexical cache path must not resolve outside the cache");

        assert!(error.to_string().contains("outside its cache root"));
    }

    #[tokio::test]
    async fn exec_command_uses_read_only_bashkit_for_reference_repositories() {
        let root =
            std::env::temp_dir().join(format!("sprocket-bashkit-test-{}", uuid::Uuid::new_v4()));
        let repository = root.join("example");
        std::fs::create_dir_all(&repository).expect("reference repository directory");
        std::fs::write(repository.join("README.md"), "original\n")
            .expect("reference repository fixture");

        let args: ExecCommandArgs = serde_json::from_value(serde_json::json!({
            "cmd": "pwd; cat README.md; printf changed > README.md"
        }))
        .expect("valid exec_command request");
        let output = exec_ref_repo_command(&root, &repository, WorkspaceCancellation::new(), &args)
            .await
            .expect("sandboxed exec_command execution");

        assert_eq!(
            output.stdout,
            format!("{}\noriginal\n", repository.display())
        );
        assert_ne!(output.exit_code, Some(0));
        assert!(!output.success);
        assert_eq!(output.cwd, repository.to_string_lossy());
        assert_eq!(
            std::fs::read_to_string(repository.join("README.md")).unwrap(),
            "original\n"
        );
        std::fs::remove_dir_all(root).expect("temporary directory should be removed");
    }
}
