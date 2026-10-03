use rig::tool::ToolExecutionError;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sprocket_workspace::{MAX_COMMAND_YIELD_MS, MIN_COMMAND_YIELD_MS, default_command_shell};

use super::context::{AgentToolContext, tool_error};
use super::job::execute_tool_job;

pub(super) const DEFAULT_COMMAND_YIELD_MS: u64 = MIN_COMMAND_YIELD_MS;
pub(super) const DEFAULT_COMMAND_MAX_OUTPUT_CHARS: usize = 20_000;

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

fn is_default_workdir(workdir: &String) -> bool {
    workdir == "."
}

fn is_default_shell(shell: &String) -> bool {
    shell == &default_command_shell()
}

fn is_default_command_yield_ms(yield_time_ms: &u64) -> bool {
    *yield_time_ms == DEFAULT_COMMAND_YIELD_MS
}

fn is_false(value: &bool) -> bool {
    !*value
}

pub(super) fn exec_command_parameters() -> serde_json::Value {
    let mut schema = json!(schemars::schema_for!(ExecCommandArgs));
    schema["properties"]["workdir"]["default"] = json!(default_workdir());
    schema["properties"]["shell"]["default"] = json!(default_command_shell());
    schema["properties"]["yieldTimeMs"] = yield_time_schema();
    schema
}

pub(super) fn write_stdin_parameters() -> serde_json::Value {
    let mut schema = json!(schemars::schema_for!(WriteStdinArgs));
    schema["properties"]["chars"]["default"] = json!("");
    schema["properties"]["terminate"]["default"] = json!(false);
    schema["properties"]["yieldTimeMs"] = yield_time_schema();
    schema
}

fn yield_time_schema() -> serde_json::Value {
    json!({
        "type": "integer",
        "default": DEFAULT_COMMAND_YIELD_MS,
        "anyOf": [
            { "type": "integer", "enum": [0] },
            { "type": "integer", "minimum": MIN_COMMAND_YIELD_MS, "maximum": MAX_COMMAND_YIELD_MS }
        ],
        "description": format!(
            "Wait for completion, in milliseconds. Defaults to {DEFAULT_COMMAND_YIELD_MS}. \
             Use 0 to skip waiting and return status/session/log metadata without stdout/stderr; \
             output remains available through later waiting write_stdin polls. Nonzero values \
             are clamped to {MIN_COMMAND_YIELD_MS}–{MAX_COMMAND_YIELD_MS}; completion can return earlier."
        )
    })
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
    /// Wait before yielding a running session, in milliseconds. 0 returns immediately without output.
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
    /// Wait for more output or completion, in milliseconds. 0 returns immediately without output.
    #[serde(
        rename = "yieldTimeMs",
        default = "default_command_yield_ms",
        skip_serializing_if = "is_default_command_yield_ms"
    )]
    #[schemars(default = "default_command_yield_ms")]
    pub(crate) yield_time_ms: u64,
}

impl rig::tool::Tool for ExecCommandTool {
    const NAME: &'static str = "exec_command";
    type Error = ToolExecutionError;
    type Args = ExecCommandArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        "Run a shell command with full machine access. Long-running commands yield a sessionId after yieldTimeMs. Set yieldTimeMs to 0 to return without command output. The process keeps running unless timeoutMs sets a runtime limit."
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
            &self.0,
            Self::NAME,
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
        "Write input to an exec_command session, poll incremental output, wait for completion, or terminate the process tree. Set yieldTimeMs to 0 to skip waiting and return without command output."
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
            &self.0,
            Self::NAME,
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
    fn both_tools_advertise_the_same_yield_window() {
        for schema in [exec_command_parameters(), write_stdin_parameters()] {
            let yield_time = &schema["properties"]["yieldTimeMs"];
            assert_eq!(yield_time["default"], json!(DEFAULT_COMMAND_YIELD_MS));
            assert_eq!(yield_time["type"], "integer");
            assert_eq!(
                yield_time["anyOf"],
                json!([
                    { "type": "integer", "enum": [0] },
                    { "type": "integer", "minimum": MIN_COMMAND_YIELD_MS, "maximum": MAX_COMMAND_YIELD_MS }
                ])
            );
        }
    }

    #[test]
    fn yield_time_defaults_apply_and_zero_is_preserved() {
        let exec_default: ExecCommandArgs = serde_json::from_value(json!({"cmd": "pwd"})).unwrap();
        assert_eq!(exec_default.yield_time_ms, DEFAULT_COMMAND_YIELD_MS);

        let stdin_default: WriteStdinArgs =
            serde_json::from_value(json!({"sessionId": "abc"})).unwrap();
        assert_eq!(stdin_default.yield_time_ms, DEFAULT_COMMAND_YIELD_MS);

        let exec_zero: ExecCommandArgs =
            serde_json::from_value(json!({"cmd": "pwd", "yieldTimeMs": 0})).unwrap();
        assert_eq!(exec_zero.yield_time_ms, 0);
        assert_eq!(
            serde_json::to_value(exec_zero).unwrap(),
            json!({"cmd": "pwd", "yieldTimeMs": 0})
        );

        let stdin_zero: WriteStdinArgs =
            serde_json::from_value(json!({"sessionId": "abc", "yieldTimeMs": 0})).unwrap();
        assert_eq!(stdin_zero.yield_time_ms, 0);
        assert_eq!(
            serde_json::to_value(stdin_zero).unwrap(),
            json!({"sessionId": "abc", "yieldTimeMs": 0})
        );
    }

    #[test]
    fn historical_numeric_yield_values_round_trip() {
        let exec_legacy: ExecCommandArgs =
            serde_json::from_value(json!({"cmd": "pwd", "yieldTimeMs": 10_000})).unwrap();
        assert_eq!(exec_legacy.yield_time_ms, 10_000);
        assert_eq!(
            serde_json::to_value(&exec_legacy).unwrap(),
            json!({"cmd": "pwd", "yieldTimeMs": 10_000})
        );

        let stdin_legacy: WriteStdinArgs =
            serde_json::from_value(json!({"sessionId": "abc", "yieldTimeMs": 5_000})).unwrap();
        assert_eq!(stdin_legacy.yield_time_ms, 5_000);
        assert_eq!(
            serde_json::to_value(&stdin_legacy).unwrap(),
            json!({"sessionId": "abc", "yieldTimeMs": 5_000})
        );
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
