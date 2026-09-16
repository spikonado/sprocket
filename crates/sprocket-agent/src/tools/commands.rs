use rig::tool::ToolExecutionError;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sprocket_workspace::default_command_shell;

use super::context::{AgentToolContext, tool_error};
use super::job::execute_tool_job;

pub(super) const DEFAULT_COMMAND_YIELD_MS: u64 = 10_000;
pub(super) const DEFAULT_COMMAND_MAX_OUTPUT_CHARS: usize = 20_000;
pub(super) const DEFAULT_STDIN_YIELD_MS: u64 = 5_000;

#[derive(Clone)]
pub(crate) struct ExecCommandTool(pub(super) AgentToolContext);

#[derive(Clone)]
pub(crate) struct WriteStdinTool(pub(super) AgentToolContext);

fn default_workdir() -> String {
    ".".to_string()
}

fn default_command_yield_ms() -> u64 {
    DEFAULT_COMMAND_YIELD_MS
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

fn is_default_command_yield_ms(yield_time_ms: &u64) -> bool {
    *yield_time_ms == DEFAULT_COMMAND_YIELD_MS
}

fn is_default_stdin_yield_ms(yield_time_ms: &u64) -> bool {
    *yield_time_ms == DEFAULT_STDIN_YIELD_MS
}

fn is_false(value: &bool) -> bool {
    !*value
}

pub(super) fn exec_command_parameters() -> serde_json::Value {
    let mut schema = json!(schemars::schema_for!(ExecCommandArgs));
    schema["properties"]["workdir"]["default"] = json!(default_workdir());
    schema["properties"]["shell"]["default"] = json!(default_command_shell());
    schema["properties"]["yieldTimeMs"]["default"] = json!(DEFAULT_COMMAND_YIELD_MS);
    schema
}

pub(super) fn write_stdin_parameters() -> serde_json::Value {
    let mut schema = json!(schemars::schema_for!(WriteStdinArgs));
    schema["properties"]["chars"]["default"] = json!("");
    schema["properties"]["terminate"]["default"] = json!(false);
    schema["properties"]["yieldTimeMs"]["default"] = json!(DEFAULT_STDIN_YIELD_MS);
    schema
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
pub(crate) struct ExecCommandArgs {
    /// Shell command to execute.
    pub(crate) cmd: String,
    /// Working directory for this cmd. Absolute paths and `~` may be anywhere on the machine; relative paths resolve from the project root. Defaults to `.`.
    #[serde(
        default = "default_workdir",
        skip_serializing_if = "is_default_workdir"
    )]
    #[schemars(default = "default_workdir")]
    pub(crate) workdir: String,
    /// Shell binary to launch. Defaults to the user's shell.
    #[serde(
        default = "default_command_shell",
        skip_serializing_if = "is_default_shell"
    )]
    #[schemars(default = "default_command_shell")]
    pub(crate) shell: String,
    /// Maximum process runtime in milliseconds. Omit to allow the command to run until it exits or is terminated.
    #[serde(rename = "timeoutMs", default, skip_serializing_if = "Option::is_none")]
    pub(crate) timeout_ms: Option<u64>,
    /// Wait before yielding a running session, in milliseconds. Defaults to 10000.
    #[serde(
        rename = "yieldTimeMs",
        default = "default_command_yield_ms",
        skip_serializing_if = "is_default_command_yield_ms"
    )]
    #[schemars(default = "default_command_yield_ms")]
    pub(crate) yield_time_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
pub(crate) struct WriteStdinArgs {
    /// Command session identifier returned by exec_command. Completed results remain available until this agent run ends.
    #[serde(rename = "sessionId")]
    pub(crate) session_id: String,
    /// Characters to write to the command's standard input.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub(crate) chars: String,
    /// Terminate the command and its descendants.
    #[serde(default, skip_serializing_if = "is_false")]
    pub(crate) terminate: bool,
    /// Wait for more output or completion, in milliseconds. Defaults to 5000.
    #[serde(
        rename = "yieldTimeMs",
        default = "default_stdin_yield_ms",
        skip_serializing_if = "is_default_stdin_yield_ms"
    )]
    #[schemars(default = "default_stdin_yield_ms")]
    pub(crate) yield_time_ms: u64,
}

impl rig::tool::Tool for ExecCommandTool {
    const NAME: &'static str = "exec_command";
    type Error = ToolExecutionError;
    type Args = ExecCommandArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        "Run a shell command with full machine access. Long-running commands yield a sessionId after yieldTimeMs. The process keeps running unless timeoutMs sets a runtime limit."
            .to_string()
    }

    fn parameters(&self) -> serde_json::Value {
        exec_command_parameters()
    }

    async fn call(
        &self,
        _context: &mut rig::tool::ToolContext,
        args: Self::Args,
    ) -> Result<Self::Output, Self::Error> {
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
                        DEFAULT_COMMAND_MAX_OUTPUT_CHARS,
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
    type Error = ToolExecutionError;
    type Args = WriteStdinArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        "Write input to an exec_command session, poll incremental output, wait for completion, or terminate the process tree."
            .to_string()
    }

    fn parameters(&self) -> serde_json::Value {
        write_stdin_parameters()
    }

    async fn call(
        &self,
        _context: &mut rig::tool::ToolContext,
        args: Self::Args,
    ) -> Result<Self::Output, Self::Error> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exec_command_schema_does_not_expose_the_preview_limit() {
        let schema = exec_command_parameters();
        let properties = schema["properties"].as_object().unwrap();
        assert_eq!(properties.len(), 5);
        assert!(!properties.contains_key("maxOutputChars"));
        assert!(
            properties["workdir"]["description"]
                .as_str()
                .unwrap()
                .starts_with("Working directory for this cmd")
        );
        assert_eq!(schema["required"], json!(["cmd"]));
        assert!(properties["timeoutMs"].get("default").is_none());
    }

    #[test]
    fn stdin_schema_still_requires_the_session_id() {
        let schema = write_stdin_parameters();
        assert_eq!(schema["required"], json!(["sessionId"]));
        assert_eq!(schema["properties"]["sessionId"]["type"], "string");
        assert!(serde_json::from_value::<WriteStdinArgs>(json!({})).is_err());
    }

    #[test]
    fn old_preview_limits_are_not_replayed_as_tool_arguments() {
        let args: ExecCommandArgs = serde_json::from_value(json!({
            "cmd": "pwd",
            "maxOutputChars": 1,
        }))
        .unwrap();
        assert_eq!(serde_json::to_value(args).unwrap(), json!({"cmd": "pwd"}));
    }

    #[test]
    fn timeout_is_optional_and_preserved_when_set() {
        let without_timeout: ExecCommandArgs =
            serde_json::from_value(json!({"cmd": "sleep 120"})).unwrap();
        assert_eq!(without_timeout.timeout_ms, None);

        let with_timeout: ExecCommandArgs = serde_json::from_value(json!({
            "cmd": "sleep 120",
            "timeoutMs": 1_000,
        }))
        .unwrap();
        assert_eq!(with_timeout.timeout_ms, Some(1_000));
        assert_eq!(
            serde_json::to_value(with_timeout).unwrap(),
            json!({"cmd": "sleep 120", "timeoutMs": 1_000})
        );
    }
}
