mod process;

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use bytes::Bytes;
use rig::completion::Message;
use rig::http_client::{self, HttpClientExt, Request, Response};
use rig::operation::Completion;
use rig::providers::anthropic::AnthropicConfig;
use rig::wasm_compat::WasmCompatSend;
use rig::{DynModel, Model};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::OwnedMutexGuard;

use self::process::{Event, Process, SessionStart, Spawn};
use crate::stream_recovery::provider_response;
use crate::types::ClaudeCodeLocator;

const TOOL_PREFIX: &str = "mcp__sprocket__";
const UNUSED_ENDPOINT: &str = "http://claude-code.invalid";
const DEFAULT_MAX_TOKENS: u64 = 128_000;
const STREAM_REQUIRED: &str = "Claude Code only streams completions.";
const USAGE_LIMIT_CODE: &str = "claude_subscription_usage_limit";
const ERROR_CODE: &str = "claude_code_error";
const IMAGE_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(30);

static IMAGE_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(reqwest::Client::new);

type Digest32 = [u8; 32];

/// Runs Anthropic models through the local Claude Code CLI on the user's subscription.
#[derive(Clone)]
pub struct ClaudeCode {
    locator: Arc<dyn ClaudeCodeLocator>,
    config_dir: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ResumePoint {
    session_id: String,
    model: String,
}

/// The Claude Code session that wrote the history's latest reply, read from the response
/// ID `stamp_session` gave it.
pub(crate) fn resume_point(history: &[Message]) -> Option<ResumePoint> {
    let origin = history.iter().rev().find_map(|message| match message {
        Message::Assistant(assistant) => Some(assistant.origin.as_ref()),
        _ => None,
    })??;
    let session_id = origin.response_id.as_deref()?;
    uuid::Uuid::parse_str(session_id).ok()?;
    Some(ResumePoint {
        session_id: session_id.to_string(),
        model: origin.model.clone(),
    })
}

impl ClaudeCode {
    pub fn new(locator: Arc<dyn ClaudeCodeLocator>, config_dir: PathBuf) -> Self {
        Self {
            locator,
            config_dir,
        }
    }

    pub(crate) async fn completion_model(
        &self,
        token: String,
        anthropic_model: &str,
        instructions: &str,
        cwd: &Path,
        resume: Option<ResumePoint>,
    ) -> anyhow::Result<DynModel<Completion>> {
        let executable = self.locator.executable().await?;
        let wire = AnthropicConfig::new("")
            .with_base_url(UNUSED_ENDPOINT)
            .completion(anthropic_model)
            .with_default_max_tokens(DEFAULT_MAX_TOKENS);
        let transport = ClaudeCodeTransport(Arc::new(Run {
            executable,
            config_dir: self.config_dir.clone(),
            token,
            instructions: instructions.to_string(),
            cwd: cwd.to_path_buf(),
            state: Arc::new(tokio::sync::Mutex::new(RunState {
                resume,
                session: None,
            })),
        }));
        Ok(Model::new(wire, transport).erase())
    }
}

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
struct UserFacingError {
    message: String,
    #[source]
    source: anyhow::Error,
}

/// Shows the message this module wrote for a failed turn instead of rig's diagnostic.
pub(crate) fn user_facing_error(error: anyhow::Error) -> anyhow::Error {
    let message = error.chain().find_map(|cause| {
        let response = provider_response(cause)?;
        if !matches!(
            response.machine_code()?.as_str(),
            USAGE_LIMIT_CODE | ERROR_CODE
        ) {
            return None;
        }
        response.envelope_json()?["error"]["message"]
            .as_str()
            .map(str::to_string)
    });
    match message {
        Some(message) => UserFacingError {
            message,
            source: error,
        }
        .into(),
        None => error,
    }
}

struct Run {
    executable: PathBuf,
    config_dir: PathBuf,
    token: String,
    instructions: String,
    cwd: PathBuf,
    state: Arc<tokio::sync::Mutex<RunState>>,
}

struct RunState {
    /// Taken by the run's first turn, the only one whose history ends at that reply.
    resume: Option<ResumePoint>,
    session: Option<Session>,
}

struct Session {
    process: Process,
    live: LiveSession,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Launch {
    model: String,
    effort: Option<String>,
    system: Digest32,
    tools: Digest32,
}

#[derive(Clone, Debug)]
struct LiveSession {
    id: String,
    launch: Launch,
    messages: Vec<Digest32>,
    awaiting: Awaiting,
}

impl LiveSession {
    fn expect_turn(&mut self, turn: &Turn) {
        self.messages = turn.hashes.clone();
        self.awaiting = Awaiting::TurnEnd;
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Awaiting {
    /// Claude Code waits on Sprocket to run these tool calls.
    ToolResults(Vec<String>),
    /// Claude Code is finishing or has finished its turn.
    TurnEnd,
}

/// One Messages request, as Claude Code takes it.
#[derive(Debug)]
struct Turn {
    launch: Launch,
    system_prompt: String,
    tools: Vec<Value>,
    messages: Vec<Value>,
    hashes: Vec<Digest32>,
}

impl Turn {
    fn parse(body: &[u8], instructions: &str) -> anyhow::Result<Self> {
        let body: Value = serde_json::from_slice(body)?;
        let model = body["model"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Messages request has no model"))?
            .to_string();
        let mut system_prompt = instructions.to_string();
        for text in system_texts(&body["system"]) {
            if !system_prompt.is_empty() {
                system_prompt.push_str("\n\n");
            }
            system_prompt.push_str(text);
        }
        let tools: Vec<Value> = body["tools"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|tool| {
                json!({
                    "name": tool["name"],
                    "description": tool["description"],
                    "inputSchema": tool["input_schema"],
                })
            })
            .collect();
        let messages: Vec<Value> = body["messages"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(canonical_message)
            .collect();
        Ok(Self {
            launch: Launch {
                model,
                effort: body["output_config"]["effort"].as_str().map(str::to_string),
                system: digest(&Value::String(system_prompt.clone())),
                tools: digest(&Value::Array(tools.clone())),
            },
            system_prompt,
            tools,
            hashes: messages.iter().map(digest).collect(),
            messages,
        })
    }
}

fn system_texts(system: &Value) -> Vec<&str> {
    match system {
        Value::String(text) => vec![text.as_str()],
        Value::Array(blocks) => blocks
            .iter()
            .filter_map(|block| block["text"].as_str())
            .collect(),
        _ => Vec::new(),
    }
}

/// The message without what Claude Code owns or rewrites: thinking and cache markers.
fn canonical_message(message: &Value) -> Option<Value> {
    let blocks = match &message["content"] {
        Value::String(text) => vec![json!({ "type": "text", "text": text })],
        Value::Array(blocks) => blocks
            .iter()
            .filter(|block| {
                !matches!(
                    block["type"].as_str(),
                    Some("thinking" | "redacted_thinking")
                )
            })
            .map(without_cache_control)
            .collect(),
        _ => Vec::new(),
    };
    (!blocks.is_empty()).then(|| json!({ "role": message["role"], "content": blocks }))
}

fn without_cache_control(block: &Value) -> Value {
    let mut block = block.clone();
    if let Some(object) = block.as_object_mut() {
        object.remove("cache_control");
        if let Some(Value::Array(content)) = object.get_mut("content") {
            for item in content {
                if let Some(item) = item.as_object_mut() {
                    item.remove("cache_control");
                }
            }
        }
    }
    block
}

fn digest(value: &Value) -> Digest32 {
    Sha256::digest(value.to_string().as_bytes()).into()
}

#[derive(Debug, PartialEq)]
enum Plan {
    AnswerTools(Vec<(String, Value)>),
    Continue(Vec<Value>),
    Resume {
        session_id: String,
        content: Vec<Value>,
    },
    Fresh,
}

fn plan(turn: &Turn, live: Option<&LiveSession>, resume: Option<&ResumePoint>) -> Plan {
    if let Some(live) = live.filter(|live| live.launch == turn.launch)
        && let Some(tail) = continuation(turn, &live.messages)
    {
        let planned = match &live.awaiting {
            Awaiting::ToolResults(ids) => tool_results(tail, ids).map(Plan::AnswerTools),
            Awaiting::TurnEnd => new_user_content(tail).map(Plan::Continue),
        };
        if let Some(planned) = planned {
            return planned;
        }
    }
    if let Some(resume) = resume.filter(|resume| resume.model == turn.launch.model)
        && let Some(content) = after_last_reply(turn).and_then(resumed_content)
    {
        return Plan::Resume {
            session_id: resume.session_id.clone(),
            content,
        };
    }
    Plan::Fresh
}

fn after_last_reply(turn: &Turn) -> Option<&[Value]> {
    let reply = turn
        .messages
        .iter()
        .rposition(|m| m["role"] == "assistant")?;
    Some(&turn.messages[reply + 1..])
}

/// The user messages after the reply Claude Code wrote to `known`, when `turn` extends it.
fn continuation<'a>(turn: &'a Turn, known: &[Digest32]) -> Option<&'a [Value]> {
    let reply = known.len();
    if turn.hashes.len() < reply + 2 || turn.hashes[..reply] != *known {
        return None;
    }
    let tail = &turn.messages[reply + 1..];
    (turn.messages[reply]["role"] == "assistant" && tail.iter().all(|m| m["role"] == "user"))
        .then_some(tail)
}

fn blocks(messages: &[Value]) -> impl Iterator<Item = &Value> {
    messages
        .iter()
        .flat_map(|message| message["content"].as_array().into_iter().flatten())
}

fn tool_results(tail: &[Value], awaited: &[String]) -> Option<Vec<(String, Value)>> {
    let results: Vec<(String, Value)> = blocks(tail)
        .map(|block| {
            (block["type"] == "tool_result")
                .then(|| Some((block["tool_use_id"].as_str()?.to_string(), block.clone())))
                .flatten()
        })
        .collect::<Option<_>>()?;
    let answered: HashSet<&str> = results.iter().map(|(id, _)| id.as_str()).collect();
    let awaited: HashSet<&str> = awaited.iter().map(String::as_str).collect();
    (answered == awaited && answered.len() == results.len()).then_some(results)
}

fn new_user_content(tail: &[Value]) -> Option<Vec<Value>> {
    let content: Vec<Value> = blocks(tail).cloned().collect();
    (!content.is_empty() && content.iter().all(|block| block["type"] != "tool_result"))
        .then_some(content)
}

/// An interrupt makes Claude Code reject its pending tool calls, so Sprocket's own results
/// for them go in as text.
fn resumed_content(tail: &[Value]) -> Option<Vec<Value>> {
    let (results, prompt): (Vec<&Value>, Vec<&Value>) =
        blocks(tail).partition(|block| block["type"] == "tool_result");
    let mut content = Vec::new();
    if !results.is_empty() {
        let mut text = String::from("Sprocket recorded these results for your tool calls:\n");
        for result in results {
            render_block(result, &mut text, &mut content);
        }
        content.push(json!({ "type": "text", "text": text }));
    }
    content.extend(prompt.into_iter().cloned());
    (!content.is_empty()).then_some(content)
}

/// One user message that carries a conversation Claude Code didn't write. The latest user
/// turn stays as real content; earlier turns become text, and their images stay in place.
fn checkpoint(messages: &[Value]) -> Vec<Value> {
    let latest_start = messages
        .iter()
        .rposition(|message| message["role"] != "user")
        .map_or(0, |index| index + 1);
    let (history, latest) = match new_user_content(&messages[latest_start..]) {
        Some(latest) => (&messages[..latest_start], latest),
        None => (messages, Vec::new()),
    };
    let mut content = Vec::new();
    if !history.is_empty() {
        let mut text = String::from(
            "Sprocket recorded this conversation before you joined it. Continue it as its assistant.\n<conversation-checkpoint>\n",
        );
        for message in history {
            let role = message["role"].as_str().unwrap_or("user");
            text.push_str(&format!("<{role}>\n"));
            for block in message["content"].as_array().into_iter().flatten() {
                render_block(block, &mut text, &mut content);
            }
            text.push_str(&format!("</{role}>\n"));
        }
        text.push_str("</conversation-checkpoint>");
        content.push(json!({ "type": "text", "text": text }));
    }
    if latest.is_empty() {
        content.push(json!({ "type": "text", "text": "Continue from the checkpoint." }));
    }
    content.extend(latest);
    content.retain(|block| block["type"] != "text" || block["text"] != "");
    content
}

fn render_block(block: &Value, text: &mut String, content: &mut Vec<Value>) {
    match block["type"].as_str() {
        Some("text") => {
            text.push_str(block["text"].as_str().unwrap_or_default());
            text.push('\n');
        }
        Some("image" | "document") => {
            content.push(json!({ "type": "text", "text": std::mem::take(text) }));
            content.push(block.clone());
        }
        Some("tool_use") => text.push_str(&format!(
            "<tool_call id=\"{}\" name=\"{}\">{}</tool_call>\n",
            block["id"].as_str().unwrap_or_default(),
            block["name"].as_str().unwrap_or_default(),
            block["input"]
        )),
        Some("tool_result") => {
            let error = if block["is_error"] == true {
                " error"
            } else {
                ""
            };
            text.push_str(&format!(
                "<tool_result id=\"{}\"{error}>\n",
                block["tool_use_id"].as_str().unwrap_or_default()
            ));
            match &block["content"] {
                Value::String(result) => {
                    text.push_str(result);
                    text.push('\n');
                }
                Value::Array(items) => {
                    for item in items {
                        render_block(item, text, content);
                    }
                }
                _ => {}
            }
            text.push_str("</tool_result>\n");
        }
        _ => {
            text.push_str(&block.to_string());
            text.push('\n');
        }
    }
}

/// MCP carries images only as base64, while tool images usually arrive as uploaded URLs.
async fn inline_image_urls(result: &mut Value) {
    for item in result["content"].as_array_mut().into_iter().flatten() {
        if item["type"] != "image" || item["source"]["type"] != "url" {
            continue;
        }
        let Some(url) = item["source"]["url"].as_str() else {
            continue;
        };
        match download_image(url).await {
            Ok((media_type, bytes)) => {
                item["source"] = json!({
                    "type": "base64",
                    "media_type": media_type,
                    "data": STANDARD.encode(bytes),
                });
            }
            Err(error) => eprintln!("sprocket-agent: couldn't download a tool image ({error:#})"),
        }
    }
}

async fn download_image(url: &str) -> anyhow::Result<(String, Bytes)> {
    let response = IMAGE_CLIENT
        .get(url)
        .timeout(IMAGE_DOWNLOAD_TIMEOUT)
        .send()
        .await?
        .error_for_status()?;
    let media_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .filter(|value| value.starts_with("image/"))
        .ok_or_else(|| anyhow::anyhow!("the response isn't an image"))?
        .to_string();
    Ok((media_type, response.bytes().await?))
}

/// The MCP result for a Messages tool result.
fn mcp_tool_result(block: &Value) -> Value {
    let content: Vec<Value> = match &block["content"] {
        Value::String(text) => vec![json!({ "type": "text", "text": text })],
        Value::Array(items) => items
            .iter()
            .map(|item| match item["type"].as_str() {
                Some("text") => json!({ "type": "text", "text": item["text"] }),
                Some("image") if item["source"]["type"] == "base64" => json!({
                    "type": "image",
                    "data": item["source"]["data"],
                    "mimeType": item["source"]["media_type"],
                }),
                _ => json!({ "type": "text", "text": item.to_string() }),
            })
            .collect(),
        _ => Vec::new(),
    };
    json!({ "content": content, "isError": block["is_error"] == true })
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

fn sse(event: &Value) -> Bytes {
    let kind = event["type"].as_str().unwrap_or("message");
    Bytes::from(format!("event: {kind}\ndata: {event}\n\n"))
}

fn error_event(code: &str, message: &str) -> Value {
    json!({ "type": "error", "error": { "type": "api_error", "code": code, "message": message } })
}

/// The error event for a turn Claude Code ended with `result`.
fn result_error(result: &Value, rate_limit: Option<&Value>, now_secs: u64) -> Value {
    let status = result["api_error_status"].as_u64();
    let rejected = rate_limit.filter(|info| info["status"] == "rejected");
    if status == Some(429) || rejected.is_some() {
        let resets = rejected
            .and_then(|info| info["resetsAt"].as_u64())
            .and_then(|at| at.checked_sub(now_secs))
            .map(|seconds| match seconds {
                0..3_600 => format!(" It resets in about {} minutes.", seconds / 60 + 1),
                _ => format!(" It resets in about {} hours.", seconds.div_ceil(3_600)),
            })
            .unwrap_or_default();
        return error_event(
            USAGE_LIMIT_CODE,
            &format!(
                "Your Claude subscription's usage limit has been reached.{resets} Try again after it resets, or switch to another provider."
            ),
        );
    }
    if status == Some(401) {
        return error_event(
            ERROR_CODE,
            "Claude rejected the subscription token. Remove it and sign in with Claude again in Settings > BYOK/BYOS.",
        );
    }
    let detail = result["result"]
        .as_str()
        .or_else(|| result["errors"][0].as_str())
        .unwrap_or("Claude Code ended the turn with an error.");
    error_event(ERROR_CODE, detail)
}

#[derive(Clone)]
struct ClaudeCodeTransport(Arc<Run>);

impl std::fmt::Debug for ClaudeCodeTransport {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("ClaudeCodeTransport")
    }
}

fn transport_error(message: impl Into<String>) -> http_client::Error {
    http_client::Error::Instance(message.into().into())
}

impl HttpClientExt for ClaudeCodeTransport {
    fn send<T, U>(
        &self,
        _req: Request<T>,
    ) -> impl Future<Output = http_client::Result<Response<http_client::LazyBody<U>>>>
    + WasmCompatSend
    + 'static
    where
        T: Into<Bytes>,
        T: WasmCompatSend,
        U: From<Bytes>,
        U: WasmCompatSend + 'static,
    {
        std::future::ready(Err(transport_error(STREAM_REQUIRED)))
    }

    fn send_multipart<U>(
        &self,
        _req: Request<rig::http_client::MultipartForm>,
    ) -> impl Future<Output = http_client::Result<Response<http_client::LazyBody<U>>>>
    + WasmCompatSend
    + 'static
    where
        U: From<Bytes>,
        U: WasmCompatSend + 'static,
    {
        std::future::ready(Err(transport_error(STREAM_REQUIRED)))
    }

    fn send_streaming<T>(
        &self,
        req: Request<T>,
    ) -> impl Future<Output = http_client::Result<http_client::StreamingResponse>> + WasmCompatSend
    where
        T: Into<Bytes> + WasmCompatSend,
    {
        let run = Arc::clone(&self.0);
        let body: Bytes = req.into_body().into();
        async move {
            let turn = Turn::parse(&body, &run.instructions)
                .map_err(|error| transport_error(format!("invalid Messages request: {error}")))?;
            let state = Arc::clone(&run.state).lock_owned().await;
            let stream = TurnStream::start(run, state, turn)
                .await
                .map_err(|error| transport_error(format!("{error:#}")))?;
            let body: http_client::BoxedStream = Box::pin(stream.into_stream());
            Response::builder()
                .status(http::StatusCode::OK)
                .header(http::header::CONTENT_TYPE, "text/event-stream")
                .body(body)
                .map_err(http_client::Error::Protocol)
        }
    }
}

struct TurnStream {
    run: Arc<Run>,
    state: OwnedMutexGuard<RunState>,
    turn: Turn,
    resumed: bool,
    started: bool,
    finished: bool,
    tool_uses: Vec<String>,
    stop_reason: Option<String>,
    rate_limit: Option<Value>,
}

impl TurnStream {
    async fn start(
        run: Arc<Run>,
        mut state: OwnedMutexGuard<RunState>,
        turn: Turn,
    ) -> anyhow::Result<Self> {
        let resume = state.resume.take();
        let planned = plan(
            &turn,
            state.session.as_ref().map(|session| &session.live),
            resume.as_ref(),
        );
        let resumed = matches!(planned, Plan::Resume { .. });
        match planned {
            Plan::AnswerTools(results) => {
                let mut answers = Vec::with_capacity(results.len());
                for (tool_use_id, mut result) in results {
                    inline_image_urls(&mut result).await;
                    answers.push((tool_use_id, mcp_tool_result(&result)));
                }
                let session = state
                    .session
                    .as_mut()
                    .expect("a planned answer has a live session");
                for (tool_use_id, answer) in answers {
                    session.process.answer(&tool_use_id, answer);
                }
                session.live.expect_turn(&turn);
            }
            Plan::Continue(content) => {
                let session = state
                    .session
                    .as_mut()
                    .expect("a planned continuation has a live session");
                match session.process.finish_turn().await {
                    Ok(()) => {
                        session.process.send_user(content);
                        session.live.expect_turn(&turn);
                    }
                    Err(error) => {
                        eprintln!(
                            "sprocket-agent: {error:#}; replaying the conversation in a new Claude Code session"
                        );
                        spawn_fresh(&run, &mut state, &turn)?;
                    }
                }
            }
            Plan::Resume {
                session_id,
                content,
            } => spawn(
                &run,
                &mut state,
                &turn,
                SessionStart::Resume(session_id),
                content,
            )?,
            Plan::Fresh => spawn_fresh(&run, &mut state, &turn)?,
        }
        Ok(Self {
            run,
            state,
            turn,
            resumed,
            started: false,
            finished: false,
            tool_uses: Vec::new(),
            stop_reason: None,
            rate_limit: None,
        })
    }

    fn into_stream(self) -> impl futures::Stream<Item = http_client::Result<Bytes>> + Send {
        futures::stream::unfold(self, |mut turn| async move {
            let frame = turn.next_frame().await?;
            Some((Ok(frame), turn))
        })
    }

    async fn next_frame(&mut self) -> Option<Bytes> {
        if self.finished {
            return None;
        }
        loop {
            let event = match self.state.session.as_mut() {
                Some(session) => session.process.next_event().await,
                None => Event::Exited("Claude Code is not running.".to_string()),
            };
            match event {
                Event::Stream(mut event) => {
                    self.started = true;
                    self.observe(&event);
                    unprefix_tool_names(&mut event);
                    self.stamp_session(&mut event);
                    if event["type"] == "message_stop" {
                        self.finish();
                    }
                    return Some(sse(&event));
                }
                Event::RateLimit(info) => self.rate_limit = Some(info),
                Event::Result(result) if !self.started && self.resumed => {
                    if let Some(frame) = self.restart_fresh(&result["result"].to_string()) {
                        return Some(frame);
                    }
                }
                Event::Result(result) => {
                    let error = if result["is_error"] == true {
                        result_error(&result, self.rate_limit.as_ref(), crate::now_ms() / 1_000)
                    } else {
                        error_event(ERROR_CODE, "Claude Code ended the turn without a reply.")
                    };
                    return Some(self.fail(&error));
                }
                Event::Exited(reason) if !self.started && self.resumed => {
                    if let Some(frame) = self.restart_fresh(&reason) {
                        return Some(frame);
                    }
                }
                Event::Exited(reason) => {
                    return Some(self.fail(&error_event(
                        ERROR_CODE,
                        &format!("Claude Code stopped unexpectedly: {reason}"),
                    )));
                }
            }
        }
    }

    fn observe(&mut self, event: &Value) {
        match event["type"].as_str() {
            Some("message_start") => {
                self.tool_uses.clear();
                self.stop_reason = None;
            }
            Some("content_block_start") if event["content_block"]["type"] == "tool_use" => {
                if let Some(id) = event["content_block"]["id"].as_str() {
                    self.tool_uses.push(id.to_string());
                }
            }
            Some("message_delta") => {
                if let Some(reason) = event["delta"]["stop_reason"].as_str() {
                    self.stop_reason = Some(reason.to_string());
                }
            }
            _ => {}
        }
    }

    /// The transcript keeps the reply's response ID, so the session outlives this run and host.
    fn stamp_session(&self, event: &mut Value) {
        if event["type"] == "message_start"
            && let Some(session) = &self.state.session
        {
            event["message"]["id"] = Value::String(session.live.id.clone());
        }
    }

    fn finish(&mut self) {
        self.finished = true;
        if self.stop_reason.as_deref() == Some("tool_use")
            && let Some(session) = self.state.session.as_mut()
        {
            session.live.awaiting = Awaiting::ToolResults(std::mem::take(&mut self.tool_uses));
        }
    }

    fn fail(&mut self, error: &Value) -> Bytes {
        self.finished = true;
        self.state.session = None;
        sse(error)
    }

    fn restart_fresh(&mut self, reason: &str) -> Option<Bytes> {
        eprintln!(
            "sprocket-agent: Claude Code could not resume its session ({reason}); replaying the conversation"
        );
        self.resumed = false;
        if let Err(error) = spawn_fresh(&self.run, &mut self.state, &self.turn) {
            return Some(self.fail(&error_event(ERROR_CODE, &format!("{error:#}"))));
        }
        None
    }
}

/// Starts a new session that replays the conversation from a checkpoint.
fn spawn_fresh(run: &Run, state: &mut RunState, turn: &Turn) -> anyhow::Result<()> {
    let start = SessionStart::New(uuid::Uuid::new_v4().to_string());
    spawn(run, state, turn, start, checkpoint(&turn.messages))
}

fn spawn(
    run: &Run,
    state: &mut RunState,
    turn: &Turn,
    start: SessionStart,
    content: Vec<Value>,
) -> anyhow::Result<()> {
    state.session = None;
    let id = start.id().to_string();
    let process = Process::spawn(Spawn {
        executable: &run.executable,
        config_dir: &run.config_dir,
        cwd: &run.cwd,
        token: &run.token,
        model: &turn.launch.model,
        effort: turn.launch.effort.as_deref(),
        system_prompt: &turn.system_prompt,
        session: start,
        tools: turn.tools.clone(),
    })?;
    process.send_user(content);
    state.session = Some(Session {
        process,
        live: LiveSession {
            id,
            launch: turn.launch.clone(),
            messages: turn.hashes.clone(),
            awaiting: Awaiting::TurnEnd,
        },
    });
    Ok(())
}

#[cfg(test)]
mod tests;
