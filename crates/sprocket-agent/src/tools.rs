use std::path::PathBuf;

use convex::Value;
use futures::StreamExt;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sprocket_workspace::{
    WorkspaceCancellation, create_workspace_file, exec_workspace_command, replace_workspace_file,
};

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
struct WorkspaceToolContext {
    runtime: RuntimeClient,
    run_id: String,
    claim_id: String,
    workspace_root: PathBuf,
    tool_call_tracker: ToolCallTracker,
}

impl WorkspaceToolContext {
    fn new(
        runtime: RuntimeClient,
        run_id: String,
        claim_id: String,
        workspace_root: PathBuf,
        tool_call_tracker: ToolCallTracker,
    ) -> Self {
        Self {
            runtime,
            run_id,
            claim_id,
            workspace_root,
            tool_call_tracker,
        }
    }
}

#[derive(Clone)]
pub(crate) struct ExecCommandTool(WorkspaceToolContext);

#[derive(Clone)]
pub(crate) struct CreateFileTool(WorkspaceToolContext);

#[derive(Clone)]
pub(crate) struct ReplaceInFileTool(WorkspaceToolContext);

pub(crate) struct WorkspaceToolSet {
    pub(crate) exec_command: ExecCommandTool,
    pub(crate) create_file: CreateFileTool,
    pub(crate) replace_in_file: ReplaceInFileTool,
}

pub(crate) fn workspace_tools(
    runtime: RuntimeClient,
    run_id: String,
    claim_id: String,
    workspace_root: PathBuf,
    tool_call_tracker: ToolCallTracker,
) -> WorkspaceToolSet {
    let context =
        WorkspaceToolContext::new(runtime, run_id, claim_id, workspace_root, tool_call_tracker);
    WorkspaceToolSet {
        exec_command: ExecCommandTool(context.clone()),
        create_file: CreateFileTool(context.clone()),
        replace_in_file: ReplaceInFileTool(context),
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
pub(crate) struct ExecCommandArgs {
    /// Shell command to execute.
    cmd: String,
    /// Relative/absolute path to the directory in which the command should be executed.
    #[serde(skip_serializing_if = "Option::is_none")]
    workdir: Option<String>,
    /// Shell binary to launch.
    #[serde(skip_serializing_if = "Option::is_none")]
    shell: Option<String>,
    /// Whether to run the shell with login semantics. Defaults to false.
    #[serde(skip_serializing_if = "Option::is_none")]
    login: Option<bool>,
    /// Command timeout in milliseconds.
    #[serde(rename = "timeoutMs", skip_serializing_if = "Option::is_none")]
    timeout_ms: Option<u64>,
    /// Maximum combined output characters returned to the model.
    #[serde(rename = "maxOutputChars", skip_serializing_if = "Option::is_none")]
    max_output_chars: Option<usize>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
pub(crate) struct CreateFileArgs {
    /// Relative file path inside the workspace.
    path: String,
    /// Entire file contents.
    content: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
pub(crate) struct ReplaceInFileArgs {
    /// Relative file path inside the workspace.
    path: String,
    /// Exact existing text to replace.
    #[serde(rename = "oldText")]
    old_text: String,
    /// Replacement text.
    #[serde(rename = "newText")]
    new_text: String,
    /// When true, replace every occurrence of oldText; otherwise replace the first match only.
    #[serde(rename = "replaceAll", skip_serializing_if = "Option::is_none")]
    replace_all: Option<bool>,
}

impl rig::tool::Tool for ExecCommandTool {
    const NAME: &'static str = "exec_command";
    type Error = AgentToolError;
    type Args = ExecCommandArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        "Runs a shell command inside the workspace and returns its output.".to_string()
    }

    fn parameters(&self) -> serde_json::Value {
        json!(schemars::schema_for!(ExecCommandArgs))
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
                let output = exec_workspace_command(
                    self.0.workspace_root.clone(),
                    cancellation,
                    &args.cmd,
                    args.workdir.as_deref(),
                    args.shell.as_deref(),
                    args.login,
                    args.timeout_ms,
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

impl rig::tool::Tool for CreateFileTool {
    const NAME: &'static str = "create_file";
    type Error = AgentToolError;
    type Args = CreateFileArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        "Create a new UTF-8 text file. Fails if the file already exists.".to_string()
    }

    fn parameters(&self) -> serde_json::Value {
        json!(schemars::schema_for!(CreateFileArgs))
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
                let output = create_workspace_file(
                    self.0.workspace_root.clone(),
                    cancellation,
                    &args.path,
                    &args.content,
                )
                .await
                .map_err(tool_error)?;
                Ok(serde_json::json!({
                    "path": output.path,
                    "bytesWritten": output.bytes_written,
                }))
            },
        )
        .await
    }
}

impl rig::tool::Tool for ReplaceInFileTool {
    const NAME: &'static str = "replace_in_file";
    type Error = AgentToolError;
    type Args = ReplaceInFileArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        "Apply an exact text replacement inside an existing UTF-8 file.".to_string()
    }

    fn parameters(&self) -> serde_json::Value {
        json!(schemars::schema_for!(ReplaceInFileArgs))
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
                let output = replace_workspace_file(
                    self.0.workspace_root.clone(),
                    cancellation,
                    &args.path,
                    &args.old_text,
                    &args.new_text,
                    args.replace_all.unwrap_or(false),
                )
                .await
                .map_err(tool_error)?;
                Ok(serde_json::json!({
                    "path": output.path,
                    "replacements": output.replacements,
                    "bytesWritten": output.bytes_written,
                }))
            },
        )
        .await
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

    let mut begin_args = runtime.args_with_actor();
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
            let mut complete_args = runtime.args_with_actor();
            complete_args.insert("jobId".to_string(), job_id.into());
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
            let mut fail_args = runtime.args_with_actor();
            fail_args.insert("jobId".to_string(), job_id.into());
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
