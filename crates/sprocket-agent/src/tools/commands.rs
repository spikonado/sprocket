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

fn default_workdir() -> String {
    ".".to_string()
}

fn is_default_workdir(workdir: &String) -> bool {
    workdir == "."
}

fn is_default_shell(shell: &String) -> bool {
    shell == &default_command_shell()
}

pub(super) fn exec_command_parameters() -> serde_json::Value {
    let mut schema = json!(schemars::schema_for!(ExecCommandArgs));
    schema["properties"]["workdir"]["default"] = json!(default_workdir());
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
    /// Working directory for this command. Absolute paths and ~ may be anywhere on the machine; relative paths resolve from the project root.
    #[serde(
        default = "default_workdir",
        skip_serializing_if = "is_default_workdir"
    )]
    #[schemars(default = "default_workdir")]
    pub(crate) workdir: String,
    /// Shell binary to launch; resolved to the user's shell when omitted.
    #[serde(
        default = "default_command_shell",
        skip_serializing_if = "is_default_shell"
    )]
    #[schemars(default = "default_command_shell")]
    pub(crate) shell: String,
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
            self.0
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
        "Write text to a command's stdin or request termination of its process tree.".to_string()
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
mod tests {
    use super::*;
    use sprocket_workspace::async_tools::{DEFAULT_YIELD_MS, MAX_YIELD_MS, MIN_POLL_YIELD_MS};

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
                .starts_with("Working directory for this command")
        );
        assert_eq!(schema["required"], json!(["cmd"]));
        assert!(properties["timeoutMs"].get("default").is_none());
    }

    #[test]
    fn exec_command_schema_shell_default_is_runtime_dependent() {
        let schema = exec_command_parameters();
        let shell = &schema["properties"]["shell"];
        assert_eq!(
            shell["description"],
            "Shell binary to launch; resolved to the user's shell when omitted."
        );
        assert!(shell.get("default").is_none());
    }

    #[test]
    fn control_schema_requires_session_and_action_with_action_constraints() {
        let schema = control_command_parameters();
        assert_eq!(schema["required"], json!(["sessionId", "action"]));
        assert_eq!(schema["additionalProperties"], json!(false));
        assert_eq!(schema["properties"]["sessionId"]["type"], "string");
        assert_eq!(
            schema["properties"]["sessionId"]["description"],
            "Session returned by exec_cmd."
        );
        assert_eq!(
            schema["properties"]["action"]["enum"],
            json!(["write", "terminate"])
        );
        assert_eq!(schema["properties"]["chars"]["default"], json!(""));
        assert_eq!(
            schema["anyOf"],
            json!([
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
            ])
        );
        assert!(serde_json::from_value::<ControlCommandArgs>(json!({})).is_err());
        assert!(
            serde_json::from_value::<ControlCommandArgs>(json!({"sessionId": "42"})).is_err(),
            "action is required"
        );
    }

    #[test]
    fn control_args_deserialize_strictly() {
        let write: ControlCommandArgs = serde_json::from_value(json!({
            "sessionId": "42",
            "action": "write",
            "chars": "yes\n",
        }))
        .unwrap();
        assert_eq!(write.action, CommandActionArg::Write);
        assert_eq!(write.chars, "yes\n");

        let terminate: ControlCommandArgs =
            serde_json::from_value(json!({"sessionId": "42", "action": "terminate"})).unwrap();
        assert_eq!(terminate.action, CommandActionArg::Terminate);
        assert!(terminate.chars.is_empty());

        assert!(
            serde_json::from_value::<ControlCommandArgs>(
                json!({"sessionId": "42", "action": "write", "terminate": true})
            )
            .is_err(),
            "legacy write_stdin fields are rejected"
        );
        assert!(
            serde_json::from_value::<ControlCommandArgs>(
                json!({"sessionId": "42", "action": "signal"})
            )
            .is_err(),
            "unknown actions are rejected"
        );
    }

    #[test]
    fn control_action_and_chars_are_validated_before_dispatch() {
        let write_without_chars: ControlCommandArgs =
            serde_json::from_value(json!({"sessionId": "42", "action": "write"})).unwrap();
        assert!(write_without_chars.chars.is_empty());
        let error = write_without_chars
            .action
            .action()
            .validate(&write_without_chars.chars)
            .expect_err("write requires nonempty chars");
        assert!(error.to_string().contains("nonempty chars"));

        let write: ControlCommandArgs = serde_json::from_value(
            json!({"sessionId": "42", "action": "write", "chars": "input\n"}),
        )
        .unwrap();
        write
            .action
            .action()
            .validate(&write.chars)
            .expect("nonempty write is valid");

        let terminate: ControlCommandArgs =
            serde_json::from_value(json!({"sessionId": "42", "action": "terminate"})).unwrap();
        terminate
            .action
            .action()
            .validate(&terminate.chars)
            .expect("terminate defaults to empty chars");

        let terminate_with_chars: ControlCommandArgs = serde_json::from_value(
            json!({"sessionId": "42", "action": "terminate", "chars": "leftover"}),
        )
        .unwrap();
        terminate_with_chars
            .action
            .action()
            .validate(&terminate_with_chars.chars)
            .expect_err("terminate requires empty chars");
    }

    #[test]
    fn poll_schema_only_takes_a_session_and_a_yield_window() {
        let schema = poll_command_parameters();
        assert_eq!(schema["required"], json!(["sessionId"]));
        assert_eq!(schema["additionalProperties"], json!(false));
        let properties = schema["properties"].as_object().unwrap();
        assert_eq!(properties.len(), 2);
        let yield_time = &properties["yieldTimeMs"];
        assert_eq!(yield_time["default"], json!(DEFAULT_YIELD_MS));
        assert_eq!(
            yield_time["anyOf"],
            json!([
                { "type": "integer", "enum": [0] },
                { "type": "integer", "minimum": MIN_POLL_YIELD_MS, "maximum": MAX_YIELD_MS }
            ])
        );
        assert_eq!(
            yield_time["description"],
            "Maximum time to wait for completion before returning the tool call. Zero returns an immediate status/output snapshot."
        );
    }

    #[test]
    fn poll_args_deserialize_strictly() {
        let poll: PollCommandArgs = serde_json::from_value(json!({"sessionId": "42"})).unwrap();
        assert_eq!(poll.yield_time_ms, DEFAULT_YIELD_MS);

        assert!(
            serde_json::from_value::<PollCommandArgs>(json!({"sessionId": "42", "chars": "x"}))
                .is_err(),
            "poll takes no action fields"
        );
    }

    #[test]
    fn exec_and_control_advertise_the_same_yield_window() {
        for schema in [exec_command_parameters(), control_command_parameters()] {
            let yield_time = &schema["properties"]["yieldTimeMs"];
            assert_eq!(yield_time["default"], json!(DEFAULT_YIELD_MS));
            assert_eq!(yield_time["type"], "integer");
            assert_eq!(yield_time["minimum"], 0);
            assert_eq!(yield_time["maximum"], MAX_YIELD_MS);
            assert!(yield_time.get("anyOf").is_none());
            assert_eq!(
                yield_time["description"],
                "Maximum time to wait for completion before returning the tool call."
            );
        }
    }

    #[test]
    fn yield_time_defaults_apply_and_zero_is_preserved() {
        let exec_default: ExecCommandArgs = serde_json::from_value(json!({"cmd": "pwd"})).unwrap();
        assert_eq!(exec_default.yield_time_ms, DEFAULT_YIELD_MS);

        let control_default: ControlCommandArgs =
            serde_json::from_value(json!({"sessionId": "abc", "action": "terminate"})).unwrap();
        assert_eq!(control_default.yield_time_ms, DEFAULT_YIELD_MS);

        let exec_zero: ExecCommandArgs =
            serde_json::from_value(json!({"cmd": "pwd", "yieldTimeMs": 0})).unwrap();
        assert_eq!(exec_zero.yield_time_ms, 0);
        assert_eq!(
            serde_json::to_value(exec_zero).unwrap(),
            json!({"cmd": "pwd", "yieldTimeMs": 0})
        );

        let control_zero: ControlCommandArgs = serde_json::from_value(
            json!({"sessionId": "abc", "action": "terminate", "yieldTimeMs": 0}),
        )
        .unwrap();
        assert_eq!(control_zero.yield_time_ms, 0);
        assert_eq!(
            serde_json::to_value(control_zero).unwrap(),
            json!({"sessionId": "abc", "action": "terminate", "yieldTimeMs": 0})
        );
    }

    #[test]
    fn historical_numeric_yield_values_round_trip() {
        let exec_legacy: ExecCommandArgs =
            serde_json::from_value(json!({"cmd": "pwd", "yieldTimeMs": 10_000})).unwrap();
        assert_eq!(exec_legacy.yield_time_ms, 10_000);
        let serialized = serde_json::to_value(&exec_legacy).unwrap();
        let restored: ExecCommandArgs = serde_json::from_value(serialized).unwrap();
        assert_eq!(restored.yield_time_ms, 10_000);

        let control_legacy: ControlCommandArgs = serde_json::from_value(
            json!({"sessionId": "abc", "action": "terminate", "yieldTimeMs": 5_000}),
        )
        .unwrap();
        assert_eq!(control_legacy.yield_time_ms, 5_000);
        assert_eq!(
            serde_json::to_value(&control_legacy).unwrap(),
            json!({"sessionId": "abc", "action": "terminate", "yieldTimeMs": 5_000})
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
