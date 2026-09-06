//! Rig runner compaction against a local Responses SSE fixture.

use std::collections::VecDeque;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::thread;
use std::time::{Duration, Instant};

use futures::StreamExt;
use rig::agent::{MultiTurnStreamItem, StreamingError};
use rig::client::AgentClientExt;
use rig::completion::{Message, PromptError};
use rig::message::{AssistantContent, ToolResultContent, UserContent};
use rig::providers::openai;
use rig::streaming::StreamingPrompt;
use rig::tool::{DynamicTool, Tool, ToolOutput};
use serde_json::{Value as JsonValue, json};

use super::{
    ContextCompactionHook, HANDOFF_PROMPT, HANDOFF_REQUESTED, HandoffRequest, HandoffTool,
    context_summary_text,
};
use crate::hooks::AGENT_TOOL_NAMES;

const MODEL: &str = "gateway-model";
const OLD_CONTEXT: &str = "UNIQUE_OLD_CONTEXT xyz-arm-bus";
const DEFERRED_PROMPT: &str = "Keep going on the arm firmware. Do not summarise this turn.";
const TOOL_RESULT: &str = "pending-tool-result:/workspace";
const FIRST_SUMMARY: &str = "first-handoff-document";
const SECOND_SUMMARY: &str = "second-handoff-document";
const HANDOFF_FAILED: &str =
    "Context handoff failed: the agent must submit one complete handoff document.";
const DRIVE_TIMEOUT: Duration = Duration::from_secs(12);
const OVER_LIMIT: u64 = 100;

#[derive(Debug)]
enum DriveEnd {
    HandoffNeeded,
    Submitted(String),
    MissingDocument,
    Stopped(String),
    Finished(String),
}

fn sse(event: JsonValue) -> String {
    format!("data: {event}\n\n")
}

fn response_json(
    status: &str,
    output: Vec<JsonValue>,
    input_tokens: u64,
    output_tokens: u64,
) -> JsonValue {
    let mut response = json!({
        "id": "resp_compaction",
        "object": "response",
        "created_at": 0,
        "status": status,
        "model": MODEL,
        "output": output,
        "tools": [],
        "usage": {
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "total_tokens": input_tokens + output_tokens
        }
    });
    if status == "incomplete" {
        response["incomplete_details"] = json!({ "reason": "max_output_tokens" });
    }
    response
}

fn function_call_item(call_id: &str, name: &str, arguments: &str) -> JsonValue {
    json!({
        "type": "function_call",
        "id": format!("fc_{call_id}"),
        "call_id": call_id,
        "name": name,
        "arguments": arguments,
        "status": "completed"
    })
}

fn tool_call_sse(
    call_id: &str,
    name: &str,
    arguments: JsonValue,
    input_tokens: u64,
    output_tokens: u64,
) -> String {
    let item = function_call_item(call_id, name, &arguments.to_string());
    [
        sse(json!({
            "type": "response.created",
            "sequence_number": 0,
            "response": response_json("in_progress", vec![], input_tokens, output_tokens),
        })),
        sse(json!({
            "type": "response.output_item.added",
            "item_id": format!("fc_{call_id}"),
            "output_index": 0,
            "sequence_number": 1,
            "item": item.clone(),
        })),
        sse(json!({
            "type": "response.output_item.done",
            "item_id": format!("fc_{call_id}"),
            "output_index": 0,
            "sequence_number": 2,
            "item": item.clone(),
        })),
        sse(json!({
            "type": "response.completed",
            "sequence_number": 3,
            "response": response_json("completed", vec![item], input_tokens, output_tokens),
        })),
    ]
    .concat()
}

fn two_tool_calls_sse() -> String {
    let first = function_call_item(
        "call_a",
        HandoffTool::NAME,
        &json!({ "document": FIRST_SUMMARY }).to_string(),
    );
    let second = function_call_item(
        "call_b",
        HandoffTool::NAME,
        &json!({ "document": SECOND_SUMMARY }).to_string(),
    );
    [
        sse(json!({
            "type": "response.created",
            "sequence_number": 0,
            "response": response_json("in_progress", vec![], 10, 10),
        })),
        sse(json!({
            "type": "response.output_item.added",
            "item_id": "fc_call_a",
            "output_index": 0,
            "sequence_number": 1,
            "item": first.clone(),
        })),
        sse(json!({
            "type": "response.output_item.done",
            "item_id": "fc_call_a",
            "output_index": 0,
            "sequence_number": 2,
            "item": first.clone(),
        })),
        sse(json!({
            "type": "response.output_item.added",
            "item_id": "fc_call_b",
            "output_index": 1,
            "sequence_number": 3,
            "item": second.clone(),
        })),
        sse(json!({
            "type": "response.output_item.done",
            "item_id": "fc_call_b",
            "output_index": 1,
            "sequence_number": 4,
            "item": second.clone(),
        })),
        sse(json!({
            "type": "response.completed",
            "sequence_number": 5,
            "response": response_json("completed", vec![first, second], 10, 10),
        })),
    ]
    .concat()
}

fn text_sse(text: &str, input_tokens: u64, output_tokens: u64) -> String {
    let message = json!({
        "type": "message",
        "id": "msg_1",
        "role": "assistant",
        "status": "completed",
        "content": [{ "type": "output_text", "text": text }]
    });
    [
        sse(json!({
            "type": "response.created",
            "sequence_number": 0,
            "response": response_json("in_progress", vec![], input_tokens, output_tokens),
        })),
        sse(json!({
            "type": "response.output_text.delta",
            "item_id": "msg_1",
            "output_index": 0,
            "content_index": 0,
            "sequence_number": 1,
            "delta": text,
        })),
        sse(json!({
            "type": "response.completed",
            "sequence_number": 2,
            "response": response_json("completed", vec![message], input_tokens, output_tokens),
        })),
    ]
    .concat()
}

fn truncated_handoff_sse() -> String {
    let message = json!({
        "type": "message",
        "id": "msg_trunc",
        "role": "assistant",
        "status": "incomplete",
        "content": [{ "type": "output_text", "text": "partial" }]
    });
    [
        sse(json!({
            "type": "response.created",
            "sequence_number": 0,
            "response": response_json("in_progress", vec![], 10, 40),
        })),
        sse(json!({
            "type": "response.output_text.delta",
            "item_id": "msg_trunc",
            "output_index": 0,
            "content_index": 0,
            "sequence_number": 1,
            "delta": "partial",
        })),
        sse(json!({
            "type": "response.incomplete",
            "sequence_number": 2,
            "response": response_json("incomplete", vec![message], 10, 40),
        })),
    ]
    .concat()
}

fn handoff_document_sse(document: &str) -> String {
    tool_call_sse(
        "call_handoff",
        HandoffTool::NAME,
        json!({ "document": document }),
        12,
        8,
    )
}

fn exec_command_sse(input_tokens: u64, output_tokens: u64) -> String {
    tool_call_sse(
        "call_exec",
        "exec_command",
        json!({ "cmd": "pwd" }),
        input_tokens,
        output_tokens,
    )
}

fn header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|window| window == b"\r\n\r\n")
}

fn content_length(headers: &str) -> usize {
    headers
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            (name.eq_ignore_ascii_case("content-length"))
                .then(|| value.trim().parse().ok())
                .flatten()
        })
        .unwrap_or(0)
}

fn read_http_request(stream: &mut TcpStream) -> Vec<u8> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 2048];
    loop {
        let read = match stream.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(read) => read,
        };
        buf.extend_from_slice(&chunk[..read]);
        let Some(end) = header_end(&buf) else {
            continue;
        };
        let headers = std::str::from_utf8(&buf[..end]).unwrap_or("");
        let body_start = end + 4;
        let needed = body_start + content_length(headers);
        while buf.len() < needed {
            match stream.read(&mut chunk) {
                Ok(0) | Err(_) => return buf.get(body_start..).unwrap_or_default().to_vec(),
                Ok(read) => buf.extend_from_slice(&chunk[..read]),
            }
        }
        return buf[body_start..needed].to_vec();
    }
    Vec::new()
}

fn spawn_responses_sse(bodies: Vec<String>) -> (String, thread::JoinHandle<Vec<Vec<u8>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("ephemeral listener");
    listener.set_nonblocking(true).expect("nonblocking accept");
    let addr = listener.local_addr().expect("listener address");
    let handle = thread::spawn(move || {
        let mut captured = Vec::new();
        let mut remaining: VecDeque<String> = bodies.into();
        let deadline = Instant::now() + Duration::from_secs(15);
        let mut idle_since = remaining.is_empty().then(Instant::now);
        while Instant::now() < deadline {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let _ = stream.set_nonblocking(false);
                    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
                    captured.push(read_http_request(&mut stream));
                    let sse_body = remaining.pop_front().unwrap_or_default();
                    let response = format!(
                        "HTTP/1.1 200 OK\r\n\
                         Content-Type: text/event-stream\r\n\
                         Cache-Control: no-cache\r\n\
                         Connection: close\r\n\
                         Content-Length: {}\r\n\
                         \r\n\
                         {sse_body}",
                        sse_body.len()
                    );
                    let _ = stream.write_all(response.as_bytes());
                    let _ = stream.flush();
                    if remaining.is_empty() {
                        idle_since = Some(Instant::now());
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    if idle_since.is_some_and(|since| since.elapsed() > Duration::from_millis(400))
                    {
                        break;
                    }
                    thread::sleep(Duration::from_millis(10));
                }
                Err(_) => break,
            }
        }
        captured
    });
    (format!("http://{addr}"), handle)
}

fn stub_tool(name: &'static str) -> DynamicTool {
    DynamicTool::new(
        name,
        format!("stub {name}"),
        json!({ "type": "object", "properties": { "cmd": { "type": "string" } } }),
        |_context, _args| Box::pin(async { Ok(ToolOutput::text(TOOL_RESULT)) }),
    )
}

fn test_agent(base_url: &str, hook: &ContextCompactionHook) -> rig::Agent {
    let client = openai::Client::builder()
        .api_key("test-key")
        .base_url(base_url)
        .build()
        .expect("openai responses client");
    let mut builder = client
        .agent(MODEL)
        .preamble("compaction fixture")
        .tool(hook.tool());
    for name in AGENT_TOOL_NAMES {
        builder = builder.dynamic_tool(stub_tool(name));
    }
    builder.build()
}

fn parse_request(body: &[u8]) -> JsonValue {
    serde_json::from_slice(body).unwrap_or(JsonValue::Null)
}

fn advertised_tools(request: &JsonValue) -> Vec<String> {
    request["tools"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|tool| {
            tool.get("name")
                .and_then(JsonValue::as_str)
                .map(str::to_owned)
        })
        .collect()
}

fn last_user_text(request: &JsonValue) -> String {
    let Some(input) = request["input"].as_array() else {
        return String::new();
    };
    for item in input.iter().rev() {
        if item.get("role").and_then(JsonValue::as_str) != Some("user") {
            continue;
        }
        if let Some(text) = item["content"].as_str() {
            return text.to_string();
        }
        if let Some(parts) = item["content"].as_array() {
            return parts
                .iter()
                .filter_map(|part| part.get("text").and_then(JsonValue::as_str))
                .collect::<Vec<_>>()
                .join("");
        }
    }
    String::new()
}

fn input_blob(request: &JsonValue) -> String {
    request["input"].to_string()
}

fn assert_handoff_request(request: &JsonValue) {
    assert_eq!(
        last_user_text(request),
        HANDOFF_PROMPT,
        "handoff completion must send the hidden prompt verbatim, got {}",
        last_user_text(request)
    );
    let tools = advertised_tools(request);
    assert_eq!(
        tools,
        vec![HandoffTool::NAME.to_string()],
        "handoff completion must advertise only {}, got {tools:?}",
        HandoffTool::NAME
    );
    assert_eq!(
        request["tool_choice"],
        json!("required"),
        "handoff completion must require a tool call, got {}",
        request["tool_choice"]
    );
}

fn message_contains(message: &Message, needle: &str) -> bool {
    match message {
        Message::User { content, .. } => content.iter().any(|part| match part {
            UserContent::Text(text) => text.text.contains(needle),
            UserContent::ToolResult(result) => result.content.iter().any(|block| match block {
                ToolResultContent::Text(text) => text.text.contains(needle),
                ToolResultContent::Json { value } => value.to_string().contains(needle),
                _ => false,
            }),
            _ => false,
        }),
        Message::Assistant { content, .. } => content.iter().any(|part| match part {
            AssistantContent::Text(text) => text.text.contains(needle),
            AssistantContent::ToolCall(call) => {
                call.function.name.contains(needle)
                    || call.function.arguments.to_string().contains(needle)
            }
            _ => false,
        }),
        Message::System { content } => content.contains(needle),
    }
}

fn cancelled_reason(error: StreamingError) -> String {
    match error {
        StreamingError::Prompt(error) => match *error {
            PromptError::PromptCancelled { reason, .. } => reason,
            other => other.to_string(),
        },
        other => other.to_string(),
    }
}

async fn drive(
    agent: &rig::Agent,
    hook: &ContextCompactionHook,
    prompt: Message,
    history: Vec<Message>,
) -> DriveEnd {
    let mut stream = agent
        .stream_prompt(prompt)
        .history(history)
        .max_turns(8)
        .add_hook(hook.clone())
        .await;
    let mut final_text = String::new();
    let run = async {
        while let Some(item) = stream.next().await {
            match item {
                Ok(MultiTurnStreamItem::CompletionCall(call)) => {
                    hook.record_usage(call.usage);
                }
                Ok(MultiTurnStreamItem::ToolExecutionCommitted { .. }) if hook.is_writing() => {
                    return match hook.take_summary() {
                        Some(document) => DriveEnd::Submitted(document),
                        None => DriveEnd::MissingDocument,
                    };
                }
                Ok(MultiTurnStreamItem::FinalResponse(response)) => {
                    final_text = response.output().to_string();
                }
                Ok(_) => {}
                Err(error) => {
                    let reason = cancelled_reason(error);
                    return if reason == HANDOFF_REQUESTED {
                        DriveEnd::HandoffNeeded
                    } else {
                        DriveEnd::Stopped(reason)
                    };
                }
            }
        }
        DriveEnd::Finished(final_text)
    };
    tokio::time::timeout(DRIVE_TIMEOUT, run)
        .await
        .expect("rig compaction stream timed out")
}

fn take_handoff(hook: &ContextCompactionHook) -> HandoffRequest {
    hook.take_request()
        .expect("compaction hook should stash a handoff request")
}

#[tokio::test]
async fn unsolicited_handoff_is_not_executed_or_emitted_as_a_tool_call() {
    let (base_url, server) = spawn_responses_sse(vec![handoff_document_sse(FIRST_SUMMARY)]);
    let hook = ContextCompactionHook::new(OVER_LIMIT, 0, true);
    let agent = test_agent(&base_url, &hook);
    tokio::time::timeout(DRIVE_TIMEOUT, async {
        let mut stream = agent
            .stream_prompt("normal work")
            .add_hook(crate::hooks::AgentPromptHook::new(Default::default()))
            .add_hook(hook.clone())
            .max_invalid_tool_call_retries(0)
            .await;
        let mut rejected = false;
        while let Some(item) = stream.next().await {
            match item {
                Ok(MultiTurnStreamItem::StreamAssistantItem(
                    rig::streaming::StreamedAssistantContent::ToolCall { .. },
                ))
                | Ok(MultiTurnStreamItem::ToolExecutionCommitted { .. }) => {
                    panic!("a disallowed handoff must not become a visible or executed tool call");
                }
                Err(_) => {
                    rejected = true;
                    break;
                }
                _ => {}
            }
        }
        assert!(rejected);
    })
    .await
    .expect("unsolicited handoff stream timed out");
    assert!(hook.take_summary().is_none());
    assert_eq!(server.join().unwrap().len(), 1);
}

#[tokio::test]
async fn over_budget_turn_is_replaced_by_the_hidden_handoff_prompt() {
    let (base_url, server) = spawn_responses_sse(vec![
        handoff_document_sse(FIRST_SUMMARY),
        text_sse("continued from handoff", 4, 4),
    ]);
    let hook = ContextCompactionHook::new(OVER_LIMIT, OVER_LIMIT, true);
    let agent = test_agent(&base_url, &hook);
    let history = vec![Message::user(OLD_CONTEXT)];
    let prompt = Message::user(DEFERRED_PROMPT);

    match drive(&agent, &hook, prompt.clone(), history.clone()).await {
        DriveEnd::HandoffNeeded => {}
        other => panic!("over-budget first call should stop before the model, got {other:?}"),
    }

    let request = take_handoff(&hook);
    assert_eq!(request.history, history);
    assert_eq!(request.deferred_prompt, Some(prompt.clone()));
    assert!(request.before_prompt);
    assert!(
        !request
            .history
            .iter()
            .any(|message| message_contains(message, DEFERRED_PROMPT)),
        "deferred user prompt must stay out of the handoff history"
    );

    hook.start_handoff();
    match drive(
        &agent,
        &hook,
        Message::user(HANDOFF_PROMPT),
        request.history.clone(),
    )
    .await
    {
        DriveEnd::Submitted(document) => assert_eq!(document, FIRST_SUMMARY),
        other => panic!("handoff tool should submit the document, got {other:?}"),
    }

    hook.restart();
    let summary = Message::user(context_summary_text(FIRST_SUMMARY));
    match drive(&agent, &hook, prompt.clone(), vec![summary]).await {
        DriveEnd::Finished(text) => assert_eq!(text, "continued from handoff"),
        other => panic!("fresh runner should complete the deferred prompt, got {other:?}"),
    }

    let captured = server.join().expect("responses mock thread");
    assert_eq!(
        captured.len(),
        2,
        "stop-before-model then handoff then resume, got {captured:?}"
    );

    let handoff = parse_request(&captured[0]);
    assert_handoff_request(&handoff);
    let handoff_input = input_blob(&handoff);
    assert!(handoff_input.contains(OLD_CONTEXT));
    assert!(
        !handoff_input.contains(DEFERRED_PROMPT),
        "handoff request must not include the deferred user prompt"
    );

    let resume = parse_request(&captured[1]);
    assert_eq!(
        last_user_text(&resume),
        DEFERRED_PROMPT,
        "fresh runner must send the deferred user prompt unmodified"
    );
    let resume_input = input_blob(&resume);
    assert!(resume_input.contains(FIRST_SUMMARY));
    assert!(
        !resume_input.contains(OLD_CONTEXT),
        "fresh runner must not replay pre-compaction history"
    );
    assert!(
        !resume_input.contains(HANDOFF_PROMPT),
        "fresh runner must not keep the hidden handoff prompt"
    );
    let resume_tools = advertised_tools(&resume);
    assert!(
        resume_tools.contains(&"exec_command".to_string()),
        "fresh runner should advertise agent tools again, got {resume_tools:?}"
    );
    assert!(
        !resume_tools.contains(&HandoffTool::NAME.to_string()),
        "fresh runner must not advertise the handoff tool, got {resume_tools:?}"
    );
}

#[tokio::test]
async fn mid_run_handoff_keeps_the_pending_tool_result() {
    let (base_url, server) = spawn_responses_sse(vec![
        exec_command_sse(80, 20),
        handoff_document_sse(FIRST_SUMMARY),
    ]);
    let hook = ContextCompactionHook::new(50, 0, false);
    let agent = test_agent(&base_url, &hook);
    let history = vec![Message::user(OLD_CONTEXT)];
    let prompt = Message::user("run pwd");

    match drive(&agent, &hook, prompt, history).await {
        DriveEnd::HandoffNeeded => {}
        other => panic!("usage over the limit should stop the next completion, got {other:?}"),
    }

    let request = take_handoff(&hook);
    assert!(request.deferred_prompt.is_none());
    assert!(!request.before_prompt);
    assert!(
        request
            .history
            .iter()
            .any(|message| message_contains(message, TOOL_RESULT)),
        "mid-run handoff history must include the pending tool result, got {:?}",
        request.history
    );
    assert!(
        request
            .history
            .iter()
            .any(|message| message_contains(message, OLD_CONTEXT)),
        "mid-run handoff history should still carry earlier turns"
    );

    hook.start_handoff();
    match drive(
        &agent,
        &hook,
        Message::user(HANDOFF_PROMPT),
        request.history.clone(),
    )
    .await
    {
        DriveEnd::Submitted(document) => assert_eq!(document, FIRST_SUMMARY),
        other => panic!("handoff tool should submit the document, got {other:?}"),
    }

    let captured = server.join().expect("responses mock thread");
    assert_eq!(
        captured.len(),
        2,
        "tool turn then handoff, got {captured:?}"
    );

    let tool_turn = parse_request(&captured[0]);
    let tool_turn_tools = advertised_tools(&tool_turn);
    assert!(
        tool_turn_tools.contains(&"exec_command".to_string()),
        "pre-handoff completion should advertise exec_command, got {tool_turn_tools:?}"
    );
    assert!(
        !tool_turn_tools.contains(&HandoffTool::NAME.to_string()),
        "pre-handoff completion must hide the handoff tool, got {tool_turn_tools:?}"
    );

    let handoff = parse_request(&captured[1]);
    assert_handoff_request(&handoff);
    assert!(
        input_blob(&handoff).contains(TOOL_RESULT),
        "handoff request must carry the pending tool result, got {}",
        input_blob(&handoff)
    );
}

#[tokio::test]
async fn compaction_repeats_after_restart() {
    let (base_url, server) = spawn_responses_sse(vec![
        handoff_document_sse(FIRST_SUMMARY),
        exec_command_sse(90, 20),
        handoff_document_sse(SECOND_SUMMARY),
    ]);
    let hook = ContextCompactionHook::new(OVER_LIMIT, OVER_LIMIT, true);
    let agent = test_agent(&base_url, &hook);
    let prompt = Message::user(DEFERRED_PROMPT);

    match drive(
        &agent,
        &hook,
        prompt.clone(),
        vec![Message::user(OLD_CONTEXT)],
    )
    .await
    {
        DriveEnd::HandoffNeeded => {}
        other => panic!("first over-budget call should request a handoff, got {other:?}"),
    }
    let first = take_handoff(&hook);
    hook.start_handoff();
    match drive(&agent, &hook, Message::user(HANDOFF_PROMPT), first.history).await {
        DriveEnd::Submitted(document) => assert_eq!(document, FIRST_SUMMARY),
        other => panic!("first handoff should submit, got {other:?}"),
    }

    hook.restart();
    match drive(
        &agent,
        &hook,
        prompt,
        vec![Message::user(context_summary_text(FIRST_SUMMARY))],
    )
    .await
    {
        DriveEnd::HandoffNeeded => {}
        other => panic!("usage on the fresh runner should trigger a second handoff, got {other:?}"),
    }
    let second = take_handoff(&hook);
    assert!(second.deferred_prompt.is_none());
    assert!(!second.before_prompt);
    assert!(
        second
            .history
            .iter()
            .any(|message| message_contains(message, TOOL_RESULT)),
        "second handoff should keep the pending tool result from the fresh runner"
    );
    assert!(
        !second
            .history
            .iter()
            .any(|message| message_contains(message, OLD_CONTEXT)),
        "second handoff must not revive the original pre-compaction context"
    );

    hook.start_handoff();
    match drive(&agent, &hook, Message::user(HANDOFF_PROMPT), second.history).await {
        DriveEnd::Submitted(document) => assert_eq!(document, SECOND_SUMMARY),
        other => panic!("second handoff should submit a new document, got {other:?}"),
    }

    let captured = server.join().expect("responses mock thread");
    assert_eq!(
        captured.len(),
        3,
        "handoff, tool, handoff, got {captured:?}"
    );
    assert_handoff_request(&parse_request(&captured[0]));
    assert_handoff_request(&parse_request(&captured[2]));
    assert_eq!(hook.take_summary(), None);
}

#[tokio::test]
async fn empty_handoff_document_is_rejected() {
    let (base_url, server) = spawn_responses_sse(vec![handoff_document_sse("   ")]);
    let hook = ContextCompactionHook::new(OVER_LIMIT, 0, false);
    let agent = test_agent(&base_url, &hook);
    hook.start_handoff();

    match drive(&agent, &hook, Message::user(HANDOFF_PROMPT), Vec::new()).await {
        DriveEnd::MissingDocument => {}
        other => panic!("whitespace-only document should not be accepted, got {other:?}"),
    }
    assert_eq!(hook.take_summary(), None);

    let captured = server.join().expect("responses mock thread");
    assert_eq!(captured.len(), 1);
    assert_handoff_request(&parse_request(&captured[0]));
}

#[tokio::test]
async fn truncated_handoff_turn_is_rejected() {
    let (base_url, server) = spawn_responses_sse(vec![truncated_handoff_sse()]);
    let hook = ContextCompactionHook::new(OVER_LIMIT, 0, false);
    let agent = test_agent(&base_url, &hook);
    hook.start_handoff();

    match drive(&agent, &hook, Message::user(HANDOFF_PROMPT), Vec::new()).await {
        DriveEnd::Stopped(reason) => assert_eq!(reason, HANDOFF_FAILED),
        other => panic!("truncated handoff should stop the turn, got {other:?}"),
    }
    assert_eq!(hook.take_summary(), None);
    let _ = server.join().expect("responses mock thread");
}

#[tokio::test]
async fn text_only_handoff_turn_is_rejected() {
    let (base_url, server) = spawn_responses_sse(vec![text_sse("I will summarise in prose", 8, 8)]);
    let hook = ContextCompactionHook::new(OVER_LIMIT, 0, false);
    let agent = test_agent(&base_url, &hook);
    hook.start_handoff();

    match drive(&agent, &hook, Message::user(HANDOFF_PROMPT), Vec::new()).await {
        DriveEnd::Stopped(reason) => assert_eq!(reason, HANDOFF_FAILED),
        other => panic!("a text-only handoff turn should fail, got {other:?}"),
    }
    assert_eq!(hook.take_summary(), None);
    let _ = server.join().expect("responses mock thread");
}

#[tokio::test]
async fn two_handoff_tool_calls_are_rejected() {
    let (base_url, server) = spawn_responses_sse(vec![two_tool_calls_sse()]);
    let hook = ContextCompactionHook::new(OVER_LIMIT, 0, false);
    let agent = test_agent(&base_url, &hook);
    hook.start_handoff();

    match drive(&agent, &hook, Message::user(HANDOFF_PROMPT), Vec::new()).await {
        DriveEnd::Stopped(reason) => assert_eq!(reason, HANDOFF_FAILED),
        other => panic!("two handoff tool calls should fail, got {other:?}"),
    }
    assert_eq!(hook.take_summary(), None);
    let _ = server.join().expect("responses mock thread");
}
