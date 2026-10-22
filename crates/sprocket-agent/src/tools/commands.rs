use rig::tool::ToolExecutionError;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sprocket_workspace::{CommandAction, async_tools::YieldMode, default_command_shell};

use super::async_tools::{default_yield_ms, is_default_yield_ms, yield_time_schema};
use super::context::{AgentToolContext, tool_error};
use super::job::execute_serialized_tool_job;

pub(super) const DEFAULT_COMMAND_MAX_OUTPUT_CHARS: usize = 20_000;

#[derive(Clone)]
pub(crate) struct ExecCmdTool(pub(super) AgentToolContext);

#[derive(Clone)]
pub(crate) struct ControlCmdTool(pub(super) AgentToolContext);

#[derive(Clone)]
pub(crate) struct PollCmdTool(pub(super) AgentToolContext);

pub(super) fn exec_command_parameters() -> serde_json::Value {
    let mut schema = json!(schemars::schema_for!(ExecCommandArgs));
    schema["properties"]["yieldTimeMs"] = yield_time_schema(
        YieldMode::Action,
        "Maximum time to wait for completion before returning the tool call.",
    );
    schema["additionalProperties"] = json!(false);
    schema
}

pub(super) fn control_command_parameters() -> serde_json::Value {
    let mut schema = json!(schemars::schema_for!(ControlCommandArgs));
    schema["properties"]["action"] = json!({
        "type": "string",
        "enum": ["write", "terminate"],
        "description": "Writing targets stdin; termination targets the command and its descendants."
    });
    if let Some(definitions) = schema["$defs"].as_object_mut() {
        definitions.remove("CommandActionArg");
    }
    schema["properties"]["chars"]["default"] = json!("");
    schema["properties"]["yieldTimeMs"] = yield_time_schema(
        YieldMode::Action,
        "Maximum time to wait for completion before returning the tool call.",
    );
    schema["anyOf"] = json!([
        {
            "properties": {
                "action": { "type": "string", "enum": ["write"] },
                "chars": { "type": "string", "minLength": 1 }
            },
            "required": ["chars"]
        },
        {
            "properties": {
                "action": { "type": "string", "enum": ["terminate"] },
                "chars": { "type": "string", "enum": [""] }
            }
        }
    ]);
    schema
}

pub(super) fn poll_command_parameters() -> serde_json::Value {
    let mut schema = json!(schemars::schema_for!(PollCommandArgs));
    schema["properties"]["yieldTimeMs"] = yield_time_schema(
        YieldMode::Poll,
        "Maximum time to wait for completion before returning the tool call. Zero returns an immediate status/output snapshot.",
    );
    schema
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
pub(crate) struct ExecCommandArgs {
    /// Shell command to execute.
    pub(crate) cmd: String,
    /// Shell binary to launch, e.g. bash or pwsh. Defaults to the machine's shell.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "String")]
    pub(crate) shell: Option<String>,
    /// Maximum process runtime. Without a limit, the command runs until it exits or is terminated.
    #[serde(rename = "timeoutMs", default, skip_serializing_if = "Option::is_none")]
    pub(crate) timeout_ms: Option<u64>,
    /// Maximum time to wait for completion before returning the tool call.
    #[serde(
        rename = "yieldTimeMs",
        default = "default_yield_ms",
        skip_serializing_if = "is_default_yield_ms"
    )]
    #[schemars(default = "default_yield_ms")]
    pub(crate) yield_time_ms: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CommandActionArg {
    Write,
    Terminate,
}

impl CommandActionArg {
    fn action(self) -> CommandAction {
        match self {
            Self::Write => CommandAction::Write,
            Self::Terminate => CommandAction::Terminate,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct ControlCommandArgs {
    /// Session returned by exec_cmd.
    #[serde(rename = "sessionId")]
    pub(crate) session_id: String,
    /// Writing targets stdin; termination targets the command and its descendants.
    pub(crate) action: CommandActionArg,
    /// Text written to stdin. No newline is added.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub(crate) chars: String,
    /// Maximum time to wait for completion before returning the tool call.
    #[serde(
        rename = "yieldTimeMs",
        default = "default_yield_ms",
        skip_serializing_if = "is_default_yield_ms"
    )]
    #[schemars(default = "default_yield_ms")]
    pub(crate) yield_time_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct PollCommandArgs {
    /// Session returned by exec_cmd.
    #[serde(rename = "sessionId")]
    pub(crate) session_id: String,
    /// Maximum time to wait for completion before returning the tool call. Zero returns an immediate status/output snapshot.
    #[serde(
        rename = "yieldTimeMs",
        default = "default_yield_ms",
        skip_serializing_if = "is_default_yield_ms"
    )]
    #[schemars(default = "default_yield_ms")]
    pub(crate) yield_time_ms: u64,
}

impl rig::tool::Tool for ExecCmdTool {
    const NAME: &'static str = "exec_cmd";
    type Error = ToolExecutionError;
    type Args = ExecCommandArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        "Run a shell command.".to_string()
    }

    fn parameters(&self) -> serde_json::Value {
        exec_command_parameters()
    }

    async fn call(
        &self,
        _context: &mut rig::tool::ToolContext,
        args: Self::Args,
    ) -> Result<Self::Output, Self::Error> {
        execute_serialized_tool_job(&self.0, Self::NAME, &args, |cancellation| async {
            let cwd = self.0.cwd.get();
            self.0
                .command_sessions
                .exec_command(
                    cancellation,
                    &args.cmd,
                    &cwd.to_string_lossy(),
                    &args.shell.clone().unwrap_or_else(default_command_shell),
                    args.timeout_ms,
                    args.yield_time_ms,
                    DEFAULT_COMMAND_MAX_OUTPUT_CHARS,
                )
                .await
                .map_err(tool_error)
        })
        .await
    }
}

impl rig::tool::Tool for ControlCmdTool {
    const NAME: &'static str = "control_cmd";
    type Error = ToolExecutionError;
    type Args = ControlCommandArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        "Write text to a command's stdin or terminate its process tree.".to_string()
    }

    fn parameters(&self) -> serde_json::Value {
        control_command_parameters()
    }

    async fn call(
        &self,
        _context: &mut rig::tool::ToolContext,
        args: Self::Args,
    ) -> Result<Self::Output, Self::Error> {
        let action = args.action.action();
        action.validate(&args.chars).map_err(tool_error)?;
        execute_serialized_tool_job(&self.0, Self::NAME, &args, |cancellation| async {
            self.0
                .command_sessions
                .control_command(
                    cancellation,
                    &args.session_id,
                    action,
                    &args.chars,
                    args.yield_time_ms,
                )
                .await
                .map_err(tool_error)
        })
        .await
    }
}

impl rig::tool::Tool for PollCmdTool {
    const NAME: &'static str = "poll_cmd";
    type Error = ToolExecutionError;
    type Args = PollCommandArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        "Read command status and current output.".to_string()
    }

    fn parameters(&self) -> serde_json::Value {
        poll_command_parameters()
    }

    async fn call(
        &self,
        _context: &mut rig::tool::ToolContext,
        args: Self::Args,
    ) -> Result<Self::Output, Self::Error> {
        execute_serialized_tool_job(&self.0, Self::NAME, &args, |cancellation| async {
            self.0
                .command_sessions
                .poll_command(cancellation, &args.session_id, args.yield_time_ms)
                .await
                .map_err(tool_error)
        })
        .await
    }
}

#[cfg(test)]
mod tests;
