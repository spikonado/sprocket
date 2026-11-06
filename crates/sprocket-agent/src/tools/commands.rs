use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use rig::tool::ToolExecutionError;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sprocket_transcript::TranscriptPart;
use sprocket_workspace::{CommandAction, default_command_shell};

use super::async_tools::{YieldMode, default_yield_ms, is_default_yield_ms, yield_time_schema};
use super::context::{AgentToolContext, tool_error};
use super::job::execute_serialized_tool_job;

pub(super) const DEFAULT_COMMAND_MAX_OUTPUT_CHARS: usize = 20_000;

/// Where each command session's next read starts. A result's `nextOffset`
/// only counts once `executor:complete` accepts it, which is the mutation that
/// records it in the transcript, so later runs resume from the transcript.
/// Parallel reads of one session may return the same output; serializing them
/// would let a waiting poll block the control call it waits for.
#[derive(Clone, Default)]
pub(crate) struct CommandCursors(Arc<Mutex<HashMap<String, u64>>>);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecordedRead {
    session_id: Option<String>,
    #[serde(deserialize_with = "sprocket_convex::deserialize_convex_u64")]
    next_offset: u64,
}

impl CommandCursors {
    pub(crate) fn from_parts(parts: &[TranscriptPart]) -> Self {
        let cursors = Self::default();
        for part in parts {
            let Some(tool) = &part.tool else { continue };
            if tool.status == "completed"
                && matches!(tool.name.as_str(), "exec_cmd" | "poll_cmd" | "control_cmd")
                && let Some(output) = &tool.output
            {
                let input_session_id = tool
                    .input
                    .as_ref()
                    .and_then(|input| input.get("sessionId")?.as_str());
                cursors.record(output, input_session_id);
            }
        }
        cursors
    }

    fn record(&self, output: &serde_json::Value, input_session_id: Option<&str>) {
        let Ok(read) = RecordedRead::deserialize(output) else {
            return;
        };
        let Some(session_id) = read.session_id.as_deref().or(input_session_id) else {
            return;
        };
        let mut cursors = self.0.lock().unwrap();
        let cursor = cursors.entry(session_id.to_string()).or_default();
        *cursor = (*cursor).max(read.next_offset);
    }

    async fn read<F, Fut>(
        &self,
        session_id: &str,
        read: F,
    ) -> Result<serde_json::Value, ToolExecutionError>
    where
        F: FnOnce(u64) -> Fut,
        Fut: std::future::Future<Output = Result<serde_json::Value, ToolExecutionError>>,
    {
        let from_offset = self.0.lock().unwrap().get(session_id).copied().unwrap_or(0);
        let result = read(from_offset).await?;
        self.record(&result, Some(session_id));
        Ok(result)
    }
}

#[derive(Clone)]
pub(crate) struct ExecCmdTool(pub(super) AgentToolContext);

#[derive(Clone)]
pub(crate) struct ControlCmdTool(pub(super) AgentToolContext);

#[derive(Clone)]
pub(crate) struct PollCmdTool(pub(super) AgentToolContext);

pub(super) fn exec_command_parameters(max_yield_ms: u64) -> serde_json::Value {
    let mut schema = json!(schemars::schema_for!(ExecCommandArgs));
    schema["properties"]["yieldTimeMs"] = yield_time_schema(
        YieldMode::Action,
        max_yield_ms,
        "Maximum time to wait for completion before returning the tool call.",
    );
    schema["additionalProperties"] = json!(false);
    schema
}

pub(super) fn control_command_parameters(max_yield_ms: u64) -> serde_json::Value {
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
        max_yield_ms,
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

pub(super) fn poll_command_parameters(max_yield_ms: u64) -> serde_json::Value {
    let mut schema = json!(schemars::schema_for!(PollCommandArgs));
    schema["properties"]["yieldTimeMs"] = yield_time_schema(
        YieldMode::Poll,
        max_yield_ms,
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
        "Run a shell command. The command keeps running past `yieldTimeMs`, so run long jobs in the foreground and check them with poll_cmd. Jobs started with `&` or `nohup` are killed when the shell exits.".to_string()
    }

    fn parameters(&self) -> serde_json::Value {
        exec_command_parameters(self.0.max_yield_ms)
    }

    async fn call(
        &self,
        _context: &mut rig::tool::ToolContext,
        args: Self::Args,
    ) -> Result<Self::Output, Self::Error> {
        let result =
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
                        YieldMode::Action.normalize(args.yield_time_ms, self.0.max_yield_ms),
                        DEFAULT_COMMAND_MAX_OUTPUT_CHARS,
                    )
                    .await
                    .map_err(tool_error)
            })
            .await?;
        self.0.command_cursors.record(&result, None);
        Ok(result)
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
        control_command_parameters(self.0.max_yield_ms)
    }

    async fn call(
        &self,
        _context: &mut rig::tool::ToolContext,
        args: Self::Args,
    ) -> Result<Self::Output, Self::Error> {
        let action = args.action.action();
        action.validate(&args.chars).map_err(tool_error)?;
        let args = &args;
        self.0
            .command_cursors
            .read(&args.session_id, move |from_offset| {
                execute_serialized_tool_job(
                    &self.0,
                    Self::NAME,
                    args,
                    move |cancellation| async move {
                        self.0
                            .command_sessions
                            .control_command(
                                cancellation,
                                &args.session_id,
                                action,
                                &args.chars,
                                YieldMode::Action
                                    .normalize(args.yield_time_ms, self.0.max_yield_ms),
                                from_offset,
                            )
                            .await
                            .map_err(tool_error)
                    },
                )
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
        poll_command_parameters(self.0.max_yield_ms)
    }

    async fn call(
        &self,
        _context: &mut rig::tool::ToolContext,
        args: Self::Args,
    ) -> Result<Self::Output, Self::Error> {
        let args = &args;
        self.0
            .command_cursors
            .read(&args.session_id, move |from_offset| {
                execute_serialized_tool_job(
                    &self.0,
                    Self::NAME,
                    args,
                    move |cancellation| async move {
                        self.0
                            .command_sessions
                            .poll_command(
                                cancellation,
                                &args.session_id,
                                YieldMode::Poll.normalize(args.yield_time_ms, self.0.max_yield_ms),
                                from_offset,
                            )
                            .await
                            .map_err(tool_error)
                    },
                )
            })
            .await
    }
}

#[cfg(test)]
mod tests;
