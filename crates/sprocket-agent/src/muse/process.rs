//! One Muse Code session driven over MSP. Muse runs the model loop, Sprocket's tools reach
//! it over MCP, and its model events become the Messages stream `cli_session` reads.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

use super::mcp::{self, McpCall, McpEndpoint};
use super::msp::{Incoming, Msp, RpcError, command_id};
use super::{ERROR_CODE, PLAN_REQUIRED, SIGNED_OUT, served_model_id, turn_error};
use crate::cli_session::{
    CliProcess, Event, MCP_SERVER, SessionStart, Spawn, error_event, inline_image_url,
};

/// rig keeps only signed thinking. Muse keeps the real reasoning in its own session.
const THINKING_SIGNATURE: &str = "muse";
/// The skills Muse 1.4.14 bundles. Muse matches their paths exactly, without wildcards.
const BUNDLED_SKILLS: &[&str] = &[
    "blender",
    "browser-app-delivery",
    "browser-game",
    "create-plugin",
    "create-skill",
    "doctor",
    "durable-test-collateral",
    "game-3d-visuals",
    "git",
    "greenfield-project-scaffolding",
    "grill",
    "import",
    "manage-settings",
    "migrate",
    "plan",
    "python-env",
    "read-session",
    "requirements-clarification",
    "resume-claude",
    "resume-codex",
    "table-fit",
    "taste",
    "visual-coding",
    "web3d",
    "workflow-authoring",
];
const PLUGIN_SKILLS: &[&str] = &["plugin://threejs/skills/threejs/SKILL.md"];

type HeldCalls = Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>;

pub(super) struct Process {
    prompts: mpsc::UnboundedSender<Vec<Value>>,
    events: mpsc::UnboundedReceiver<Event>,
    held: HeldCalls,
    driver: JoinHandle<()>,
}

impl Drop for Process {
    /// Stops the driver, which kills Muse and closes the MCP server.
    fn drop(&mut self) {
        self.driver.abort();
    }
}

impl Process {
    pub(super) fn spawn(executable: &Path, spawn: Spawn<'_>) -> anyhow::Result<Self> {
        let (calls, call_receiver) = mpsc::unbounded_channel();
        let endpoint = mcp::serve(spawn.tools, calls)?;
        let session = Session {
            executable: executable.to_path_buf(),
            cwd: spawn.cwd.to_path_buf(),
            model: spawn.model.to_string(),
            effort: spawn.effort.map(str::to_string),
            system_prompt: spawn.system_prompt.to_string(),
            start: spawn.session,
        };
        let (prompts, prompt_receiver) = mpsc::unbounded_channel();
        let (events, event_receiver) = mpsc::unbounded_channel();
        let held = HeldCalls::default();
        let driver = Driver {
            events,
            held: Arc::clone(&held),
            translator: Translator::new(session.model.clone()),
        };
        Ok(Self {
            prompts,
            events: event_receiver,
            held,
            driver: tokio::spawn(driver.run(session, endpoint, prompt_receiver, call_receiver)),
        })
    }
}

impl CliProcess for Process {
    fn send_user(&self, content: Vec<Value>) {
        let _ = self.prompts.send(content);
    }

    fn answer(&self, tool_use_id: &str, result: Value) {
        let call = self
            .held
            .lock()
            .ok()
            .and_then(|mut held| held.remove(tool_use_id));
        if let Some(call) = call {
            let _ = call.send(result);
        }
    }

    async fn next_event(&mut self) -> Event {
        self.events
            .recv()
            .await
            .unwrap_or_else(|| Event::Exited("Muse Code stopped.".to_string()))
    }
}

struct Session {
    executable: PathBuf,
    cwd: PathBuf,
    model: String,
    effort: Option<String>,
    system_prompt: String,
    start: SessionStart,
}

/// The settings that make Muse a model transport: Sprocket's prompt and tools only, without
/// Muse's reminder agents, skills, or context blocks.
fn arguments(system_prompt: &str) -> Vec<OsString> {
    let bundled = skills_off(
        BUNDLED_SKILLS
            .iter()
            .map(|skill| format!("bundled://muse-core/skills/{skill}/SKILL.md")),
    );
    let plugin = skills_off(PLUGIN_SKILLS.iter().map(|path| path.to_string()));
    let settings = [
        (
            "run.system_prompt",
            Value::String(system_prompt.to_string()),
        ),
        ("run.toolset", json!([format!("mcp__{MCP_SERVER}__*")])),
        ("run.reminder_roster", json!([])),
        (
            "run.context_slimming",
            json!({
                "session_identity_enabled": false,
                "meta_context_note_enabled": false,
                // Skills newer Muse releases bundle stay listed, but briefly.
                "skill_catalog_descriptions": "first_sentence",
            }),
        ),
        ("skills.activation.bundled", bundled),
        ("skills.activation.plugin", plugin),
    ];
    let mut arguments: Vec<OsString> = vec!["--preset".into(), "empty".into()];
    for (key, value) in settings {
        arguments.push("-c".into());
        arguments.push(format!("{key}={value}").into());
    }
    arguments
}

fn skills_off(paths: impl Iterator<Item = String>) -> Value {
    Value::Object(paths.map(|path| (path, json!("off"))).collect())
}

struct Driver {
    events: mpsc::UnboundedSender<Event>,
    held: HeldCalls,
    translator: Translator,
}

impl Driver {
    async fn run(
        mut self,
        session: Session,
        endpoint: McpEndpoint,
        mut prompts: mpsc::UnboundedReceiver<Vec<Value>>,
        mut calls: mpsc::UnboundedReceiver<McpCall>,
    ) {
        let (msp, mut incoming) = match start(&session, &endpoint).await {
            Ok(started) => started,
            Err(error) => {
                let _ = self.events.send(Event::TurnEnd { error });
                return;
            }
        };
        let session_id = session.start.id();
        loop {
            tokio::select! {
                biased;
                message = incoming.recv() => {
                    if !self.incoming(session_id, message) {
                        return;
                    }
                }
                Some(call) = calls.recv() => {
                    self.tool_call(call);
                }
                Some(content) = prompts.recv() => {
                    if let Err(error) =
                        start_turn(&msp, session_id, session.effort.as_deref(), content).await
                    {
                        let _ = self.events.send(Event::TurnEnd { error: rpc_turn_error(&error) });
                    }
                }
            }
        }
    }

    /// Handles a message from Muse, returning false once Muse stops.
    fn incoming(&mut self, session_id: &str, message: Option<Incoming>) -> bool {
        match message {
            Some(Incoming::Notification { method, params }) => {
                if params["sessionId"] == session_id {
                    let events = self.translator.notification(&method, &params);
                    self.send(events);
                }
                true
            }
            Some(Incoming::Exited(reason)) => {
                let _ = self.events.send(Event::Exited(reason));
                false
            }
            None => {
                let _ = self
                    .events
                    .send(Event::Exited("Muse Code stopped.".to_string()));
                false
            }
        }
    }

    /// Ends the model step with `call`, which Muse holds until Sprocket answers it. Muse runs
    /// MCP calls one at a time, so each call is a step of its own.
    fn tool_call(&mut self, call: McpCall) {
        let id = format!("toolu_{}", uuid::Uuid::new_v4().simple());
        let mut events = self.translator.tool_use(&id, &call.name, &call.arguments);
        events.extend(self.translator.end_step("tool_use"));
        if let Ok(mut held) = self.held.lock() {
            held.insert(id, call.reply);
        }
        self.send(events);
    }

    fn send(&self, events: Vec<Event>) {
        for event in events {
            let _ = self.events.send(event);
        }
    }
}

/// Starts Muse and its session, or explains why it can't run the turn.
async fn start(
    session: &Session,
    endpoint: &McpEndpoint,
) -> Result<(Msp, mpsc::UnboundedReceiver<Incoming>), Value> {
    let arguments = arguments(&session.system_prompt);
    let (msp, incoming) = Msp::start(&session.executable, arguments, &session.cwd)
        .await
        .map_err(|error| error_event(ERROR_CODE, &format!("{error:#}")))?;
    let models = msp
        .call("model/list", json!({}))
        .await
        .map_err(|error| rpc_turn_error(&error))?;
    let Some(model_id) = served_model_id(&models, &session.model) else {
        let account = msp.call("account/read", json!({})).await;
        let signed_in = account.is_ok_and(|account| account["state"] == "accountLogin");
        return Err(error_event(
            ERROR_CODE,
            if signed_in { PLAN_REQUIRED } else { SIGNED_OUT },
        ));
    };
    let config = json!({
        "mcpServers": {
            MCP_SERVER: {
                "transport": "streamableHttp",
                "url": endpoint.url,
                "headers": { "Authorization": format!("Bearer {}", endpoint.token) },
                "mode": "required",
            },
        },
    });
    let (method, params) = match &session.start {
        SessionStart::New(id) => (
            "session/start",
            json!({
                "sessionId": id,
                "commandId": command_id(),
                "workspaceRoot": session.cwd.to_string_lossy(),
                "providerId": "meta",
                "modelId": model_id,
                "approvalMode": "allowAll",
                "config": config,
            }),
        ),
        SessionStart::Resume(id) => (
            "session/resume",
            json!({ "sessionId": id, "commandId": command_id(), "config": config }),
        ),
    };
    msp.call(method, params)
        .await
        .map_err(|error| rpc_turn_error(&error))?;
    Ok((msp, incoming))
}

async fn start_turn(
    msp: &Msp,
    session_id: &str,
    effort: Option<&str>,
    content: Vec<Value>,
) -> Result<(), RpcError> {
    let mut params = json!({
        "sessionId": session_id,
        "commandId": command_id(),
        "input": msp_input(content).await,
    });
    if let Some(effort) = effort {
        params["reasoningEffort"] = Value::String(effort.to_string());
    }
    msp.call("turn/start", params).await.map(drop)
}

/// Muse's input parts for Messages user content.
async fn msp_input(content: Vec<Value>) -> Vec<Value> {
    let mut input = Vec::with_capacity(content.len());
    for mut block in content {
        inline_image_url(&mut block).await;
        input.push(match block["type"].as_str() {
            Some("text") => json!({ "type": "text", "text": block["text"] }),
            Some("image") if block["source"]["type"] == "base64" => json!({
                "type": "image",
                "base64Data": block["source"]["data"],
                "mediaType": block["source"]["media_type"],
            }),
            _ => json!({ "type": "text", "text": block.to_string() }),
        });
    }
    input
}

fn rpc_turn_error(error: &RpcError) -> Value {
    turn_error(
        &json!({ "message": error.message, "kind": error.data["kind"] }),
        crate::now_ms(),
    )
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BlockKind {
    Thinking,
    Text,
}

struct Item {
    kind: BlockKind,
    streamed: bool,
}

struct OpenBlock {
    item_id: String,
    index: usize,
    kind: BlockKind,
    /// The reasoning summary part the last delta extended.
    part: Option<String>,
}

/// Turns Muse's item notifications into Messages stream events, one message per model step.
struct Translator {
    model: String,
    items: HashMap<String, Item>,
    message_open: bool,
    blocks: usize,
    block: Option<OpenBlock>,
    usage: Value,
}

impl Translator {
    fn new(model: String) -> Self {
        Self {
            model,
            items: HashMap::new(),
            message_open: false,
            blocks: 0,
            block: None,
            usage: Value::Null,
        }
    }

    fn notification(&mut self, method: &str, params: &Value) -> Vec<Event> {
        let mut events = Vec::new();
        match method {
            "item/started" => {
                let item = &params["item"];
                if let (Some(id), Some(kind)) = (item["itemId"].as_str(), block_kind(item)) {
                    let item = Item {
                        kind,
                        streamed: false,
                    };
                    self.items.insert(id.to_string(), item);
                }
            }
            "item/delta" => self.delta(params, &mut events),
            "item/completed" => self.completed(&params["item"], &mut events),
            "session/tokenUsage" => self.usage = params["usage"].clone(),
            "turn/completed" => self.turn_completed(params, &mut events),
            _ => {}
        }
        events
    }

    fn delta(&mut self, params: &Value, events: &mut Vec<Event>) {
        let (Some(item_id), Some(field), Some(delta)) = (
            params["itemId"].as_str(),
            params["field"].as_str(),
            params["delta"].as_str(),
        ) else {
            return;
        };
        let Some(item) = self.items.get_mut(item_id) else {
            return;
        };
        let kind = item.kind;
        let streams_block = match kind {
            BlockKind::Thinking => field.starts_with("summary."),
            BlockKind::Text => field == "text",
        };
        if !streams_block || delta.is_empty() {
            return;
        }
        item.streamed = true;
        let block = self.open_block(item_id, kind, events);
        let separator = match kind {
            BlockKind::Thinking if block.part.as_deref().is_some_and(|part| part != field) => {
                "\n\n"
            }
            _ => "",
        };
        if kind == BlockKind::Thinking {
            block.part = Some(field.to_string());
        }
        let index = block.index;
        events.push(block_delta(index, kind, &format!("{separator}{delta}")));
    }

    /// Closes the item's block, or writes the whole item when Muse streamed none of it.
    fn completed(&mut self, item: &Value, events: &mut Vec<Event>) {
        let Some(item_id) = item["itemId"].as_str() else {
            return;
        };
        let Some(Item { kind, streamed }) = self.items.remove(item_id) else {
            return;
        };
        if self
            .block
            .as_ref()
            .is_some_and(|block| block.item_id == item_id)
        {
            self.close_block(events);
            return;
        }
        if streamed {
            return;
        }
        let text = match kind {
            BlockKind::Thinking => item["summary"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join("\n\n"),
            BlockKind::Text => item["text"].as_str().unwrap_or_default().to_string(),
        };
        if text.is_empty() {
            return;
        }
        let index = self.open_block(item_id, kind, events).index;
        events.push(block_delta(index, kind, &text));
        self.close_block(events);
    }

    fn tool_use(&mut self, id: &str, name: &str, input: &Value) -> Vec<Event> {
        let mut events = Vec::new();
        self.close_block(&mut events);
        self.open_message(&mut events);
        let index = self.blocks;
        self.blocks += 1;
        let input = if input.is_null() {
            json!({})
        } else {
            input.clone()
        };
        events.extend([
            Event::Stream(json!({
                "type": "content_block_start",
                "index": index,
                "content_block": { "type": "tool_use", "id": id, "name": name, "input": {} },
            })),
            Event::Stream(json!({
                "type": "content_block_delta",
                "index": index,
                "delta": { "type": "input_json_delta", "partial_json": input.to_string() },
            })),
            Event::Stream(json!({ "type": "content_block_stop", "index": index })),
        ]);
        events
    }

    fn end_step(&mut self, stop_reason: &str) -> Vec<Event> {
        let mut events = Vec::new();
        self.close_block(&mut events);
        self.open_message(&mut events);
        let usage = std::mem::take(&mut self.usage);
        let count = |key: &str| usage[key].as_u64().unwrap_or_default();
        let (cache_read, cache_write) = (count("cacheReadTokens"), count("cacheWriteTokens"));
        events.extend([
            Event::Stream(json!({
                "type": "message_delta",
                "delta": { "stop_reason": stop_reason, "stop_sequence": null },
                "usage": {
                    "input_tokens": count("inputTokens").saturating_sub(cache_read + cache_write),
                    "output_tokens": count("outputTokens"),
                    "cache_read_input_tokens": cache_read,
                    "cache_creation_input_tokens": cache_write,
                },
            })),
            Event::Stream(json!({ "type": "message_stop" })),
        ]);
        self.message_open = false;
        self.blocks = 0;
        events
    }

    fn turn_completed(&mut self, params: &Value, events: &mut Vec<Event>) {
        let error = if params["terminal"] == "completed" {
            if self.message_open {
                events.extend(self.end_step("end_turn"));
            }
            error_event(ERROR_CODE, "Muse Code ended the turn without a reply.")
        } else {
            turn_error(&params["error"], crate::now_ms())
        };
        self.items.clear();
        self.block = None;
        self.message_open = false;
        self.blocks = 0;
        self.usage = Value::Null;
        events.push(Event::TurnEnd { error });
    }

    fn open_message(&mut self, events: &mut Vec<Event>) {
        if self.message_open {
            return;
        }
        self.message_open = true;
        events.push(Event::Stream(json!({
            "type": "message_start",
            "message": {
                "id": "",
                "type": "message",
                "role": "assistant",
                "model": self.model,
                "content": [],
                "stop_reason": null,
                "stop_sequence": null,
                "usage": { "input_tokens": 0, "output_tokens": 0 },
            },
        })));
    }

    fn open_block(
        &mut self,
        item_id: &str,
        kind: BlockKind,
        events: &mut Vec<Event>,
    ) -> &mut OpenBlock {
        if self
            .block
            .as_ref()
            .is_some_and(|block| block.item_id != item_id)
        {
            self.close_block(events);
        }
        if self.block.is_none() {
            self.open_message(events);
            let index = self.blocks;
            self.blocks += 1;
            let content_block = match kind {
                BlockKind::Thinking => {
                    json!({ "type": "thinking", "thinking": "", "signature": "" })
                }
                BlockKind::Text => json!({ "type": "text", "text": "" }),
            };
            events.push(Event::Stream(json!({
                "type": "content_block_start",
                "index": index,
                "content_block": content_block,
            })));
            self.block = Some(OpenBlock {
                item_id: item_id.to_string(),
                index,
                kind,
                part: None,
            });
        }
        self.block.as_mut().expect("the block was just opened")
    }

    fn close_block(&mut self, events: &mut Vec<Event>) {
        let Some(block) = self.block.take() else {
            return;
        };
        if block.kind == BlockKind::Thinking {
            events.push(Event::Stream(json!({
                "type": "content_block_delta",
                "index": block.index,
                "delta": { "type": "signature_delta", "signature": THINKING_SIGNATURE },
            })));
        }
        events.push(Event::Stream(
            json!({ "type": "content_block_stop", "index": block.index }),
        ));
    }
}

fn block_kind(item: &Value) -> Option<BlockKind> {
    match item["kind"].as_str()? {
        "reasoning" => Some(BlockKind::Thinking),
        "agentMessage" => Some(BlockKind::Text),
        _ => None,
    }
}

fn block_delta(index: usize, kind: BlockKind, text: &str) -> Event {
    let delta = match kind {
        BlockKind::Thinking => json!({ "type": "thinking_delta", "thinking": text }),
        BlockKind::Text => json!({ "type": "text_delta", "text": text }),
    };
    Event::Stream(json!({ "type": "content_block_delta", "index": index, "delta": delta }))
}

#[cfg(test)]
mod tests;
