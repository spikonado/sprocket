use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::io::Write;
use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::Context;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use super::{ClaudeCodeCli, result_error};
use crate::cli_session::{
    CliProcess, Event, MCP_SERVER, McpReply, SessionStart, Spawn, mcp_reply, read_stderr, rpc_error,
};

const TOOL_PREFIX: &str = "mcp__sprocket__";
const STDERR_DRAIN_TIMEOUT: Duration = Duration::from_secs(1);
const EXIT_GRACE: Duration = Duration::from_secs(5);

pub(super) struct Process {
    child: Option<Child>,
    _system_prompt: tempfile::NamedTempFile,
    input: mpsc::UnboundedSender<String>,
    events: mpsc::UnboundedReceiver<Event>,
    calls: Arc<Mutex<ToolCalls>>,
    reader: Option<JoinHandle<()>>,
}

impl Drop for Process {
    /// Closing stdin alone lets Claude Code finish an open turn, so this interrupts it first.
    fn drop(&mut self) {
        self.send(&json!({
            "type": "control_request",
            "request_id": "interrupt",
            "request": { "subtype": "interrupt" },
        }));
        let (Some(child), Some(reader)) = (self.child.take(), self.reader.take()) else {
            return;
        };
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                let _ = tokio::time::timeout(EXIT_GRACE, reader).await;
                drop(child);
            });
        }
    }
}

impl Process {
    pub(super) fn spawn(cli: &ClaudeCodeCli, spawn: Spawn<'_>) -> anyhow::Result<Self> {
        let prompts = cli.config_dir.join("system-prompts");
        std::fs::create_dir_all(&prompts)
            .with_context(|| format!("create {}", prompts.display()))?;
        let mut system_prompt = tempfile::Builder::new()
            .suffix(".md")
            .tempfile_in(&prompts)?;
        system_prompt.write_all(spawn.system_prompt.as_bytes())?;
        system_prompt.flush()?;

        let mut command = Command::new(&cli.executable);
        command
            .args(arguments(&spawn, system_prompt.path()))
            .current_dir(spawn.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        for (key, _) in std::env::vars_os() {
            if is_inherited_claude_setting(&key) {
                command.env_remove(key);
            }
        }
        command
            .env("CLAUDE_CODE_OAUTH_TOKEN", &cli.token)
            .env("CLAUDE_CONFIG_DIR", &cli.config_dir)
            .env("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1")
            // Subscriptions meter Claude Code's default `sdk-cli` entrypoint about twice as
            // heavily. Without the artifact flag, a custom entrypoint adds a per-session
            // scratchpad line to every request, which breaks the prompt cache.
            .env("CLAUDE_CODE_ENTRYPOINT", "sprocket")
            .env("CLAUDE_CODE_DISABLE_ARTIFACT", "1")
            // `--setting-sources=` still loads auto memory and managed CLAUDE.md files.
            .env("CLAUDE_CODE_DISABLE_AUTO_MEMORY", "1")
            .env("CLAUDE_CODE_DISABLE_CLAUDE_MDS", "1")
            .env("ENABLE_TOOL_SEARCH", "false")
            // Sprocket hands off context itself, and its tool outputs are already bounded.
            .env("DISABLE_AUTO_COMPACT", "1")
            .env("MAX_MCP_OUTPUT_TOKENS", "1000000");
        let mut child = command
            .spawn()
            .with_context(|| format!("start Claude Code at {}", cli.executable.display()))?;
        let stdin = child.stdin.take().context("Claude Code has no stdin")?;
        let stdout = child.stdout.take().context("Claude Code has no stdout")?;
        let stderr = child.stderr.take().context("Claude Code has no stderr")?;

        let (input, pending_input) = mpsc::unbounded_channel();
        let (sender, events) = mpsc::unbounded_channel();
        let calls = Arc::<Mutex<ToolCalls>>::default();
        let output = Output {
            input: input.downgrade(),
            events: sender,
            calls: Arc::clone(&calls),
            tools: spawn.tools,
            rate_limit: None,
        };
        tokio::spawn(write_input(stdin, pending_input));
        let process = Self {
            child: Some(child),
            _system_prompt: system_prompt,
            input,
            events,
            calls,
            reader: Some(tokio::spawn(output.read(stdout, stderr))),
        };
        process.send(&json!({
            "type": "control_request",
            "request_id": "initialize",
            "request": { "subtype": "initialize", "hooks": null },
        }));
        Ok(process)
    }

    fn send(&self, message: &Value) {
        let _ = self.input.send(message.to_string());
    }
}

impl CliProcess for Process {
    fn send_user(&self, content: Vec<Value>) {
        self.send(&json!({
            "type": "user",
            "message": { "role": "user", "content": content },
            "parent_tool_use_id": null,
            "session_id": "",
            // Delivers the text as written, without @-mention or slash command expansion.
            "client_composed": true,
        }));
    }

    fn answer(&self, tool_use_id: &str, result: Value) {
        let Ok(mut calls) = self.calls.lock() else {
            return;
        };
        match calls.held.remove(tool_use_id) {
            Some(call) => self.send(&call.response(result)),
            None => {
                calls.results.insert(tool_use_id.to_string(), result);
            }
        }
    }

    async fn next_event(&mut self) -> Event {
        self.events
            .recv()
            .await
            .unwrap_or_else(|| Event::Exited("Claude Code stopped.".to_string()))
    }
}

fn arguments(spawn: &Spawn<'_>, system_prompt: &Path) -> Vec<OsString> {
    let mcp_config = json!({ "mcpServers": { MCP_SERVER: { "type": "sdk", "name": MCP_SERVER } } });
    let mut arguments: Vec<OsString> = [
        "--print",
        "--output-format",
        "stream-json",
        "--input-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--tools",
        "",
        "--strict-mcp-config",
        "--permission-prompt-tool",
        "stdio",
        "--setting-sources=",
        "--disable-slash-commands",
        // Sprocket's instructions can change between runs of a resumed session.
        "--system-prompt-snapshot",
        "off",
    ]
    .into_iter()
    .map(OsString::from)
    .collect();
    arguments.push("--mcp-config".into());
    arguments.push(mcp_config.to_string().into());
    arguments.push(format!("--allowedTools=mcp__{MCP_SERVER}").into());
    arguments.push(format!("--model={}", spawn.model).into());
    arguments.push("--system-prompt-file".into());
    arguments.push(system_prompt.into());
    if let Some(effort) = spawn.effort {
        arguments.push(format!("--effort={effort}").into());
    }
    arguments.push(match &spawn.session {
        SessionStart::New(id) => format!("--session-id={id}").into(),
        SessionStart::Resume(id) => format!("--resume={id}").into(),
    });
    arguments
}

/// Settings from the user's own Claude Code setup, which could change the account,
/// endpoint, or behavior Sprocket runs with.
fn is_inherited_claude_setting(key: &OsStr) -> bool {
    let key = key.to_string_lossy().to_ascii_uppercase();
    key.starts_with("ANTHROPIC_") || key.starts_with("CLAUDE") || key == "MCP_TOOL_TIMEOUT"
}

async fn write_input(mut stdin: ChildStdin, mut input: mpsc::UnboundedReceiver<String>) {
    while let Some(mut line) = input.recv().await {
        line.push('\n');
        if stdin.write_all(line.as_bytes()).await.is_err() || stdin.flush().await.is_err() {
            return;
        }
    }
}

#[derive(Default)]
struct ToolCalls {
    held: HashMap<String, HeldCall>,
    results: HashMap<String, Value>,
}

struct HeldCall {
    request_id: Value,
    rpc_id: Value,
}

impl HeldCall {
    fn response(&self, result: Value) -> Value {
        control_success(
            &self.request_id,
            json!({ "mcp_response": { "jsonrpc": "2.0", "id": self.rpc_id, "result": result } }),
        )
    }
}

fn control_success(request_id: &Value, response: Value) -> Value {
    json!({
        "type": "control_response",
        "response": { "subtype": "success", "request_id": request_id, "response": response },
    })
}

fn control_error(request_id: &Value, error: &str) -> Value {
    json!({
        "type": "control_response",
        "response": { "subtype": "error", "request_id": request_id, "error": error },
    })
}

struct Output {
    /// Weak, so the writer closes stdin once the `Process` is dropped.
    input: mpsc::WeakUnboundedSender<String>,
    events: mpsc::UnboundedSender<Event>,
    calls: Arc<Mutex<ToolCalls>>,
    tools: Vec<Value>,
    rate_limit: Option<Value>,
}

impl Output {
    async fn read(mut self, stdout: ChildStdout, stderr: ChildStderr) {
        let stderr_tail = Arc::new(Mutex::new(String::new()));
        let stderr_reader = tokio::spawn(read_stderr(stderr, Arc::clone(&stderr_tail)));
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Ok(message) = serde_json::from_str::<Value>(&line) {
                self.handle(message);
            }
        }
        let _ = tokio::time::timeout(STDERR_DRAIN_TIMEOUT, stderr_reader).await;
        let reason = stderr_tail
            .lock()
            .map(|tail| tail.trim().to_string())
            .unwrap_or_default();
        let _ = self.events.send(Event::Exited(if reason.is_empty() {
            "it exited without an error message".to_string()
        } else {
            reason
        }));
    }

    fn send(&self, message: &Value) {
        if let Some(input) = self.input.upgrade() {
            let _ = input.send(message.to_string());
        }
    }

    fn handle(&mut self, mut message: Value) {
        let kind = message["type"].as_str().unwrap_or_default().to_string();
        match kind.as_str() {
            "control_request" => self.control_request(&message["request_id"], &message["request"]),
            "control_cancel_request" => {
                if let Ok(mut calls) = self.calls.lock() {
                    calls
                        .held
                        .retain(|_, call| call.request_id != message["request_id"]);
                }
            }
            "stream_event" if message["parent_tool_use_id"].is_null() => {
                let mut event = message["event"].take();
                unprefix_tool_names(&mut event);
                let _ = self.events.send(Event::Stream(event));
            }
            "rate_limit_event" => self.rate_limit = Some(message["rate_limit_info"].take()),
            "result" => {
                let error =
                    result_error(&message, self.rate_limit.as_ref(), crate::now_ms() / 1_000);
                let _ = self.events.send(Event::TurnEnd { error });
            }
            _ => {}
        }
    }

    fn control_request(&self, request_id: &Value, request: &Value) {
        match request["subtype"].as_str() {
            Some("mcp_message") if request["server_name"] == MCP_SERVER => {
                let response = match mcp_reply(&request["message"], &self.tools) {
                    // Notifications and responses get no JSON-RPC reply, but their control
                    // request needs an ack.
                    McpReply::Ack => json!({ "jsonrpc": "2.0", "result": {} }),
                    McpReply::Respond(response) => response,
                    McpReply::ToolCall { rpc_id, params } => {
                        let Some(tool_use_id) = params["_meta"]["claudecode/toolUseId"].as_str()
                        else {
                            return self.send(&control_success(
                                request_id,
                                json!({ "mcp_response": rpc_error(&rpc_id, -32602, "Sprocket needs Claude Code's tool use ID to run a tool.") }),
                            ));
                        };
                        let call = HeldCall {
                            request_id: request_id.clone(),
                            rpc_id,
                        };
                        return self.hold(tool_use_id.to_string(), call);
                    }
                };
                self.send(&control_success(
                    request_id,
                    json!({ "mcp_response": response }),
                ));
            }
            Some("can_use_tool") => self.send(&control_success(
                request_id,
                json!({ "behavior": "allow", "updatedInput": request["input"] }),
            )),
            subtype => self.send(&control_error(
                request_id,
                &format!("Sprocket does not handle {subtype:?} control requests."),
            )),
        }
    }

    fn hold(&self, tool_use_id: String, call: HeldCall) {
        let Ok(mut calls) = self.calls.lock() else {
            return;
        };
        match calls.results.remove(&tool_use_id) {
            Some(result) => self.send(&call.response(result)),
            None => {
                calls.held.insert(tool_use_id, call);
            }
        }
    }
}

/// Claude Code names Sprocket's tools after their MCP server.
fn unprefix_tool_names(event: &mut Value) {
    if event["type"] == "content_block_start"
        && event["content_block"]["type"] == "tool_use"
        && let Some(name) = event["content_block"]["name"].as_str()
        && let Some(name) = name.strip_prefix(TOOL_PREFIX)
    {
        event["content_block"]["name"] = Value::String(name.to_string());
    }
}

#[cfg(test)]
mod tests;
