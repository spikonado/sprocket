use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::io::Write;
use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::Context;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use super::Recorder;

const MCP_SERVER: &str = "sprocket";
const STDERR_TAIL_BYTES: usize = 4096;
const TURN_END_TIMEOUT: Duration = Duration::from_secs(30);
const STDERR_DRAIN_TIMEOUT: Duration = Duration::from_secs(1);
const EXIT_GRACE: Duration = Duration::from_secs(5);

pub(super) enum SessionStart {
    New(String),
    Resume(String),
}

impl SessionStart {
    pub(super) fn id(&self) -> &str {
        match self {
            Self::New(id) | Self::Resume(id) => id,
        }
    }
}

pub(super) struct Spawn<'a> {
    pub(super) executable: &'a Path,
    pub(super) config_dir: &'a Path,
    pub(super) cwd: &'a Path,
    pub(super) token: &'a str,
    pub(super) model: &'a str,
    pub(super) effort: Option<&'a str>,
    pub(super) system_prompt: &'a str,
    pub(super) session: SessionStart,
    pub(super) tools: Vec<Value>,
    pub(super) recorder: Arc<Recorder>,
}

#[derive(Debug)]
pub(super) enum Event {
    /// A Messages stream event of the top-level conversation.
    Stream(Value),
    RateLimit(Value),
    Result(Value),
    Exited(String),
}

/// One Claude Code CLI session driven over its stream-json control protocol, with
/// Sprocket's tools served to it as an in-process MCP server.
pub(super) struct Process {
    child: Option<Child>,
    _system_prompt: tempfile::NamedTempFile,
    input: mpsc::UnboundedSender<String>,
    events: mpsc::UnboundedReceiver<Event>,
    calls: Arc<Mutex<ToolCalls>>,
    writer: JoinHandle<()>,
    reader: Option<JoinHandle<()>>,
}

impl Drop for Process {
    /// Closing stdin ends Claude Code after its current turn, so a `result` that is on its
    /// way still saves the session. A process that doesn't exit in time is killed.
    fn drop(&mut self) {
        self.writer.abort();
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
    pub(super) fn spawn(spawn: Spawn<'_>) -> anyhow::Result<Self> {
        let prompts = spawn.config_dir.join("system-prompts");
        std::fs::create_dir_all(&prompts)
            .with_context(|| format!("create {}", prompts.display()))?;
        let mut system_prompt = tempfile::Builder::new()
            .suffix(".md")
            .tempfile_in(&prompts)?;
        system_prompt.write_all(spawn.system_prompt.as_bytes())?;
        system_prompt.flush()?;

        let mut command = Command::new(spawn.executable);
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
            .env("CLAUDE_CODE_OAUTH_TOKEN", spawn.token)
            .env("CLAUDE_CONFIG_DIR", spawn.config_dir)
            .env("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1")
            // Sprocket hands off context itself, and its tool outputs are already bounded.
            .env("DISABLE_AUTO_COMPACT", "1")
            .env("MAX_MCP_OUTPUT_TOKENS", "1000000");
        let mut child = command
            .spawn()
            .with_context(|| format!("start Claude Code at {}", spawn.executable.display()))?;
        let stdin = child.stdin.take().context("Claude Code has no stdin")?;
        let stdout = child.stdout.take().context("Claude Code has no stdout")?;
        let stderr = child.stderr.take().context("Claude Code has no stderr")?;

        let (input, pending_input) = mpsc::unbounded_channel();
        let (sender, events) = mpsc::unbounded_channel();
        let calls = Arc::<Mutex<ToolCalls>>::default();
        let output = Output {
            input: input.clone(),
            events: sender,
            calls: Arc::clone(&calls),
            tools: spawn.tools,
            recorder: spawn.recorder,
        };
        let process = Self {
            child: Some(child),
            _system_prompt: system_prompt,
            input,
            events,
            calls,
            writer: tokio::spawn(write_input(stdin, pending_input)),
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

    pub(super) fn send_user(&self, content: Vec<Value>) {
        self.send(&json!({
            "type": "user",
            "message": { "role": "user", "content": content },
            "parent_tool_use_id": null,
            "session_id": "",
            // Delivers the text as written, without @-mention or slash command expansion.
            "client_composed": true,
        }));
    }

    /// Answers Claude Code's call for `tool_use_id` now, or when it makes the call.
    pub(super) fn answer(&self, tool_use_id: &str, result: Value) {
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

    pub(super) async fn next_event(&mut self) -> Event {
        self.events
            .recv()
            .await
            .unwrap_or_else(|| Event::Exited("Claude Code stopped.".to_string()))
    }

    /// Waits for the `result` that follows a turn's last message.
    pub(super) async fn finish_turn(&mut self) -> anyhow::Result<()> {
        tokio::time::timeout(TURN_END_TIMEOUT, async {
            loop {
                match self.next_event().await {
                    Event::Result(_) => return Ok(()),
                    Event::Exited(reason) => anyhow::bail!("Claude Code stopped: {reason}"),
                    Event::Stream(_) | Event::RateLimit(_) => {}
                }
            }
        })
        .await
        .context("Claude Code did not finish its turn")?
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

#[derive(Debug, PartialEq)]
enum McpReply {
    Respond(Value),
    ToolCall { rpc_id: Value, tool_use_id: String },
}

fn mcp_reply(message: &Value, tools: &[Value]) -> McpReply {
    let id = &message["id"];
    let rpc_error = |code: i64, text: &str| {
        McpReply::Respond(json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": code, "message": text },
        }))
    };
    let result =
        |result: Value| McpReply::Respond(json!({ "jsonrpc": "2.0", "id": id, "result": result }));
    let method = message["method"].as_str();
    if id.is_null() || method.is_none() {
        // Notifications and responses get no JSON-RPC reply, but their control request needs an ack.
        return McpReply::Respond(json!({ "jsonrpc": "2.0", "result": {} }));
    }
    match method {
        Some("initialize") => result(json!({
            "protocolVersion": message["params"]["protocolVersion"],
            "capabilities": { "tools": {} },
            "serverInfo": { "name": MCP_SERVER, "version": env!("CARGO_PKG_VERSION") },
        })),
        Some("tools/list") => result(json!({ "tools": tools })),
        Some("ping") => result(json!({})),
        Some("tools/call") => match message["params"]["_meta"]["claudecode/toolUseId"].as_str() {
            Some(tool_use_id) => McpReply::ToolCall {
                rpc_id: id.clone(),
                tool_use_id: tool_use_id.to_string(),
            },
            None => rpc_error(
                -32602,
                "Sprocket needs Claude Code's tool use ID to run a tool.",
            ),
        },
        _ => rpc_error(-32601, "Method not found"),
    }
}

/// A clean end lets the thread's next run resume the session.
fn ended_cleanly(result: &Value) -> bool {
    result["is_error"] != true
        && result["subtype"] == "success"
        && result["stop_reason"] == "end_turn"
}

struct Output {
    input: mpsc::UnboundedSender<String>,
    events: mpsc::UnboundedSender<Event>,
    calls: Arc<Mutex<ToolCalls>>,
    tools: Vec<Value>,
    recorder: Arc<Recorder>,
}

impl Output {
    async fn read(self, stdout: ChildStdout, stderr: ChildStderr) {
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
        let _ = self.input.send(message.to_string());
    }

    fn handle(&self, mut message: Value) {
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
                let _ = self.events.send(Event::Stream(message["event"].take()));
            }
            "rate_limit_event" => {
                let _ = self
                    .events
                    .send(Event::RateLimit(message["rate_limit_info"].take()));
            }
            "result" => {
                if ended_cleanly(&message) {
                    self.recorder.finished_cleanly();
                }
                let _ = self.events.send(Event::Result(message));
            }
            _ => {}
        }
    }

    fn control_request(&self, request_id: &Value, request: &Value) {
        match request["subtype"].as_str() {
            Some("mcp_message") if request["server_name"] == MCP_SERVER => {
                match mcp_reply(&request["message"], &self.tools) {
                    McpReply::Respond(response) => self.send(&control_success(
                        request_id,
                        json!({ "mcp_response": response }),
                    )),
                    McpReply::ToolCall {
                        rpc_id,
                        tool_use_id,
                    } => self.hold(
                        tool_use_id,
                        HeldCall {
                            request_id: request_id.clone(),
                            rpc_id,
                        },
                    ),
                }
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

async fn read_stderr(mut stderr: ChildStderr, tail: Arc<Mutex<String>>) {
    let mut buffer = [0; 4096];
    while let Ok(read) = stderr.read(&mut buffer).await
        && read > 0
    {
        let Ok(mut tail) = tail.lock() else {
            return;
        };
        tail.push_str(&String::from_utf8_lossy(&buffer[..read]));
        if tail.len() > STDERR_TAIL_BYTES {
            let mut cut = tail.len() - STDERR_TAIL_BYTES;
            while !tail.is_char_boundary(cut) {
                cut += 1;
            }
            tail.drain(..cut);
        }
    }
}

#[cfg(test)]
mod tests;
