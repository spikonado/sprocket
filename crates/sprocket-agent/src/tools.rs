use std::path::PathBuf;

use convex::Value;
use rig::completion::ToolDefinition;
use serde::{Deserialize, Serialize};
use sprocket_workspace::{create_workspace_file, exec_workspace_command, replace_workspace_file};

use crate::convex::RuntimeClient;

#[derive(Debug, thiserror::Error)]
pub(crate) enum AgentToolError {
    #[error("{0}")]
    Message(String),
}

#[derive(Clone)]
struct WorkspaceToolContext {
    runtime: RuntimeClient,
    run_id: String,
    workspace_root: PathBuf,
}

impl WorkspaceToolContext {
    fn new(runtime: RuntimeClient, run_id: String, workspace_root: PathBuf) -> Self {
        Self {
            runtime,
            run_id,
            workspace_root,
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
    workspace_root: PathBuf,
) -> WorkspaceToolSet {
    let context = WorkspaceToolContext::new(runtime, run_id, workspace_root);
    WorkspaceToolSet {
        exec_command: ExecCommandTool(context.clone()),
        create_file: CreateFileTool(context.clone()),
        replace_in_file: ReplaceInFileTool(context),
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct ExecCommandArgs {
    cmd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    workdir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    shell: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    login: Option<bool>,
    #[serde(rename = "timeoutMs", skip_serializing_if = "Option::is_none")]
    timeout_ms: Option<u64>,
    #[serde(rename = "maxOutputChars", skip_serializing_if = "Option::is_none")]
    max_output_chars: Option<usize>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct CreateFileArgs {
    path: String,
    content: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct ReplaceInFileArgs {
    path: String,
    #[serde(rename = "oldText")]
    old_text: String,
    #[serde(rename = "newText")]
    new_text: String,
    #[serde(rename = "replaceAll")]
    replace_all: Option<bool>,
}

impl rig::tool::Tool for ExecCommandTool {
    const NAME: &'static str = "exec_command";
    type Error = AgentToolError;
    type Args = ExecCommandArgs;
    type Output = serde_json::Value;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Runs a shell command inside the workspace and returns its output."
                .to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "cmd": { "type": "string", "description": "Shell command to execute." },
                    "workdir": { "type": "string", "description": "Relative/absolute path to the directory in which the command should be executed." },
                    "shell": { "type": "string", "description": "Shell binary to launch." },
                    "login": { "type": "boolean", "description": "Whether to run the shell with login semantics. Defaults to false." },
                    "timeoutMs": { "type": "integer", "minimum": 1, "description": "Command timeout in milliseconds." },
                    "maxOutputChars": { "type": "integer", "minimum": 1, "maximum": 80000, "description": "Maximum combined output characters returned to the model." }
                },
                "required": ["cmd"]
            }),
        }
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        execute_tool_job(
            &self.0.runtime,
            &self.0.run_id,
            Self::NAME,
            serde_json::to_value(&args).map_err(tool_error)?,
            async {
                let output = exec_workspace_command(
                    self.0.workspace_root.clone(),
                    &args.cmd,
                    args.workdir.as_deref(),
                    args.shell.as_deref(),
                    args.login,
                    args.timeout_ms,
                    args.max_output_chars,
                )
                .await
                .map_err(tool_error)?;
                Ok(serde_json::json!({
                    "command": output.command,
                    "cwd": output.cwd,
                    "exitCode": output.exit_code,
                    "success": output.success,
                    "timedOut": output.timed_out,
                    "stdout": output.stdout,
                    "stderr": output.stderr,
                    "output": output.output,
                    "truncated": output.truncated,
                }))
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

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Create a new UTF-8 text file. Fails if the file already exists."
                .to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Relative file path inside the workspace" },
                    "content": { "type": "string", "description": "Entire file contents" }
                },
                "required": ["path", "content"]
            }),
        }
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        execute_tool_job(
            &self.0.runtime,
            &self.0.run_id,
            Self::NAME,
            serde_json::to_value(&args).map_err(tool_error)?,
            async {
                let output =
                    create_workspace_file(self.0.workspace_root.clone(), &args.path, &args.content)
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

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Apply an exact text replacement inside an existing UTF-8 file."
                .to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Relative file path inside the workspace" },
                    "oldText": { "type": "string", "description": "Exact existing text to replace" },
                    "newText": { "type": "string", "description": "Replacement text" },
                    "replaceAll": { "type": "boolean" }
                },
                "required": ["path", "oldText", "newText"]
            }),
        }
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        execute_tool_job(
            &self.0.runtime,
            &self.0.run_id,
            Self::NAME,
            serde_json::to_value(&args).map_err(tool_error)?,
            async {
                let output = replace_workspace_file(
                    self.0.workspace_root.clone(),
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

async fn execute_tool_job<F>(
    runtime: &RuntimeClient,
    run_id: &str,
    kind: &str,
    payload: serde_json::Value,
    future: F,
) -> Result<serde_json::Value, AgentToolError>
where
    F: std::future::Future<Output = Result<serde_json::Value, AgentToolError>>,
{
    eprintln!("sprocket-agent: starting tool {} for run {}", kind, run_id);
    let mut begin_args = runtime.args_with_actor();
    begin_args.insert("runId".to_string(), run_id.to_string().into());
    begin_args.insert("kind".to_string(), kind.to_string().into());
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

    match future.await {
        Ok(output) => {
            eprintln!("sprocket-agent: completed tool {} for run {}", kind, run_id);
            let mut complete_args = runtime.args_with_actor();
            complete_args.insert("jobId".to_string(), job_id.into());
            complete_args.insert(
                "result".to_string(),
                Value::try_from(output.clone()).map_err(tool_error)?,
            );
            runtime
                .mutation_unit("executor:complete", complete_args)
                .await
                .map_err(tool_error)?;
            Ok(output)
        }
        Err(error) => {
            eprintln!(
                "sprocket-agent: failed tool {} for run {}: {}",
                kind, run_id, error
            );
            let mut fail_args = runtime.args_with_actor();
            fail_args.insert("jobId".to_string(), job_id.into());
            fail_args.insert("error".to_string(), error.to_string().into());
            runtime
                .mutation_unit("executor:fail", fail_args)
                .await
                .map_err(tool_error)?;
            Err(error)
        }
    }
}

fn tool_error(error: impl std::fmt::Display) -> AgentToolError {
    AgentToolError::Message(error.to_string())
}
