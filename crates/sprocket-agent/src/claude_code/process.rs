use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::io::Write;
use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::Context;
use futures::StreamExt;
use futures::channel::mpsc as mcp_channel;
use rmcp::model::{CallToolResult, ClientJsonRpcMessage, RequestId, ServerJsonRpcMessage, Tool};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

use super::{ClaudeCodeCli, result_error};
use crate::cli_session::mcp::{Server, ToolCall, tool_error};
use crate::cli_session::{CliProcess, Event, MCP_SERVER, SessionStart, Spawn, read_stderr};

const TOOL_PREFIX: &str = "mcp__sprocket__";
const TOOL_USE_ID: &str = "claudecode/toolUseId";
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
        let (output, mcp) = Output::new(input.downgrade(), sender, Arc::clone(&calls), spawn.tools);
        tokio::spawn(write_input(stdin, pending_input));
        let process = Self {
            child: Some(child),
            _system_prompt: system_prompt,
            input,
            events,
            calls,
            reader: Some(tokio::spawn(output.read(stdout, stderr, mcp))),
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

    fn answer(&self, tool_use_id: &str, result: CallToolResult) {
        if let Ok(mut calls) = self.calls.lock() {
            calls.answer(tool_use_id, result);
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

/// Claude Code's tool calls and Sprocket's answers, matched by tool use ID since either can
/// come first.
#[derive(Default)]
struct ToolCalls {
    held: HashMap<String, oneshot::Sender<CallToolResult>>,
    results: HashMap<String, CallToolResult>,
}

impl ToolCalls {
    fn answer(&mut self, tool_use_id: &str, result: CallToolResult) {
        match self.held.remove(tool_use_id) {
            Some(reply) => {
                let _ = reply.send(result);
            }
            None => {
                self.results.insert(tool_use_id.to_string(), result);
            }
        }
    }

    fn hold(&mut self, tool_use_id: String, reply: oneshot::Sender<CallToolResult>) {
        match self.results.remove(&tool_use_id) {
            Some(result) => {
                let _ = reply.send(result);
            }
            None => {
                self.held.insert(tool_use_id, reply);
            }
        }
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
    to_server: mcp_channel::UnboundedSender<ClientJsonRpcMessage>,
    /// The control request each in-flight MCP request came in, keyed by JSON-RPC ID.
    pending: HashMap<RequestId, Value>,
    rate_limit: Option<Value>,
}

struct FromServer {
    messages: mcp_channel::UnboundedReceiver<ServerJsonRpcMessage>,
    calls: mpsc::UnboundedReceiver<ToolCall>,
}

impl Output {
    /// Claude Code relays its `sdk` MCP server's messages over the control protocol, so
    /// Sprocket's server runs over in-memory channels.
    fn new(
        input: mpsc::WeakUnboundedSender<String>,
        events: mpsc::UnboundedSender<Event>,
        calls: Arc<Mutex<ToolCalls>>,
        tools: Vec<Tool>,
    ) -> (Self, FromServer) {
        let (call_sender, call_receiver) = mpsc::unbounded_channel();
        let (to_server, server_input) = mcp_channel::unbounded();
        let (server_output, messages) = mcp_channel::unbounded();
        let server = Server::new(tools, call_sender);
        tokio::spawn(async move {
            match rmcp::serve_server(server, (server_output, server_input)).await {
                Ok(service) => {
                    let _ = service.waiting().await;
                }
                Err(error) => tracing::debug!("Claude Code's MCP session ended ({error})"),
            }
        });
        let output = Self {
            input,
            events,
            calls,
            to_server,
            pending: HashMap::new(),
            rate_limit: None,
        };
        let from_server = FromServer {
            messages,
            calls: call_receiver,
        };
        (output, from_server)
    }

    async fn read(self, stdout: ChildStdout, stderr: ChildStderr, from_server: FromServer) {
        let stderr_tail = Arc::new(Mutex::new(String::new()));
        let stderr_reader = tokio::spawn(read_stderr(stderr, Arc::clone(&stderr_tail)));
        let events = self.events.clone();
        self.run(stdout, from_server).await;
        let _ = tokio::time::timeout(STDERR_DRAIN_TIMEOUT, stderr_reader).await;
        let reason = stderr_tail
            .lock()
            .map(|tail| tail.trim().to_string())
            .unwrap_or_default();
        let _ = events.send(Event::Exited(if reason.is_empty() {
            "it exited without an error message".to_string()
        } else {
            reason
        }));
    }

    async fn run(mut self, stdout: impl AsyncRead + Unpin, mut from_server: FromServer) {
        let mut lines = BufReader::new(stdout).lines();
        loop {
            tokio::select! {
                line = lines.next_line() => {
                    let Ok(Some(line)) = line else {
                        return;
                    };
                    if let Ok(message) = serde_json::from_str::<Value>(&line) {
                        self.handle(message);
                    }
                }
                Some(message) = from_server.messages.next() => self.server_message(message),
                Some(call) = from_server.calls.recv() => self.tool_call(call),
            }
        }
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
                self.pending
                    .retain(|_, request_id| *request_id != message["request_id"]);
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

    fn control_request(&mut self, request_id: &Value, request: &Value) {
        match request["subtype"].as_str() {
            Some("mcp_message") if request["server_name"] == MCP_SERVER => {
                let message = match ClientJsonRpcMessage::deserialize(&request["message"]) {
                    Ok(message) => message,
                    Err(error) => {
                        return self.send(&control_error(
                            request_id,
                            &format!("Sprocket could not read the MCP message ({error})."),
                        ));
                    }
                };
                if let ClientJsonRpcMessage::Request(rpc) = &message {
                    self.pending.insert(rpc.id.clone(), request_id.clone());
                } else {
                    // Notifications and responses get no JSON-RPC reply, but their control
                    // request needs an ack.
                    self.send(&control_success(
                        request_id,
                        json!({ "mcp_response": { "jsonrpc": "2.0", "result": {} } }),
                    ));
                }
                let _ = self.to_server.unbounded_send(message);
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

    /// Sprocket's server only answers requests, so anything else has no control request to go in.
    fn server_message(&mut self, message: ServerJsonRpcMessage) {
        let rpc_id = match &message {
            ServerJsonRpcMessage::Response(response) => Some(&response.id),
            ServerJsonRpcMessage::Error(error) => error.id.as_ref(),
            _ => None,
        };
        if let Some(request_id) = rpc_id.and_then(|rpc_id| self.pending.remove(rpc_id)) {
            self.send(&control_success(
                &request_id,
                json!({ "mcp_response": message }),
            ));
        }
    }

    fn tool_call(&self, call: ToolCall) {
        let Some(tool_use_id) = call.meta.get(TOOL_USE_ID).and_then(Value::as_str) else {
            let _ = call.reply.send(tool_error(
                "Sprocket needs Claude Code's tool use ID to run a tool.",
            ));
            return;
        };
        if let Ok(mut calls) = self.calls.lock() {
            calls.hold(tool_use_id.to_string(), call.reply);
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
