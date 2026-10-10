//! Rig runner context handoff against a local Responses API SSE fixture.

use std::collections::VecDeque;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::thread;
use std::time::{Duration, Instant};

use futures::StreamExt;
use rig::agent::MultiTurnStreamItem;
use rig::completion::{Message, PromptError};
use rig::message::{
    AssistantContent, CallId, Reasoning, ReasoningContent, ToolCall, ToolFunction, ToolName,
    ToolResult, ToolResultContent, UserContent,
};
use rig::providers::openai;
use rig::streaming::{Item, StreamEvent};
use rig::tool::{DynamicTool, Tool, ToolOutput};
use serde_json::{Value as JsonValue, json};

use super::{
    ContextHandoffHook, HANDOFF_PROMPT, HANDOFF_REQUESTED, HANDOFF_SUBMITTED, HandoffRequest,
    HandoffTool, context_summary_text,
};
use crate::openai::{developer_message, stateless_responses_model};
use crate::provider::{resume_context_handoff, resume_without_provider_handoff};

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
        "id": "resp_context_handoff",
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
        "exec_cmd",
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

fn stub_tool() -> DynamicTool {
    DynamicTool::new(
        "exec_cmd",
        "stub exec_cmd",
        json!({ "type": "object", "properties": { "cmd": { "type": "string" } } }),
        |_args| Box::pin(async { Ok(ToolOutput::text(TOOL_RESULT)) }),
    )
}

fn test_agent(base_url: &str, hook: &ContextHandoffHook) -> rig::Agent {
    let model = stateless_responses_model(
        openai::OpenAIConfig::new("test-key")
            .with_base_url(base_url)
            .with_instructions("context handoff fixture"),
        MODEL,
    );
    rig::AgentBuilder::new(model)
        .tool(hook.tool())
        .dynamic_tool(stub_tool())
        .build()
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
    let last = request["input"]
        .as_array()
        .expect("handoff input")
        .last()
        .unwrap();
    assert_eq!(
        last["content"][0]["text"], HANDOFF_PROMPT,
        "handoff completion must send the hidden prompt verbatim"
    );
    assert_eq!(last["role"], "developer");
    let tools = advertised_tools(request);
    assert!(
        tools.contains(&HandoffTool::NAME.to_string()) && tools.contains(&"exec_cmd".to_string()),
        "handoff completion must advertise the handoff and ordinary tools, got {tools:?}"
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

fn cancelled_reason(error: PromptError) -> String {
    match error {
        PromptError::Cancelled { reason, .. } => reason,
        other => other.to_string(),
    }
}

async fn drive(
    agent: &rig::Agent,
    hook: &ContextHandoffHook,
    prompt: Message,
    history: Vec<Message>,
) -> DriveEnd {
    let mut stream = agent
        .prompt(prompt)
        .history(history)
        .max_turns(8)
        .add_hook(hook.clone())
        .stream();
    let mut final_text = String::new();
    let run = async {
        while let Some(item) = stream.next().await {
            match item {
                Ok(MultiTurnStreamItem::CompletionCall(call)) => {
                    hook.record_usage(call.usage);
                }
                Ok(MultiTurnStreamItem::ToolExecutionCommitted { .. }) if hook.is_writing() => {
                    return DriveEnd::MissingDocument;
                }
                Ok(MultiTurnStreamItem::FinalResponse(response)) => {
                    final_text = response.output().to_string();
                }
                Ok(_) => {}
                Err(error) => {
                    let reason = cancelled_reason(error);
                    return if reason == HANDOFF_REQUESTED {
                        DriveEnd::HandoffNeeded
                    } else if reason == HANDOFF_SUBMITTED {
                        DriveEnd::Submitted(
                            hook.take_summary().expect("submitted handoff document"),
                        )
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
        .expect("rig context handoff stream timed out")
}

fn take_handoff(hook: &ContextHandoffHook) -> HandoffRequest {
    hook.take_request()
        .expect("context handoff hook should stash a handoff request")
}

#[tokio::test]
async fn unsolicited_handoff_is_not_executed_or_emitted_as_a_tool_call() {
    assert_unsolicited_handoff_rejected(handoff_document_sse(FIRST_SUMMARY)).await;
}

#[tokio::test]
async fn unsolicited_handoff_name_repair_keeps_the_pending_request_gate() {
    assert_unsolicited_handoff_rejected(
        handoff_document_sse(FIRST_SUMMARY).replace("handoff_context", "handoff-context"),
    )
    .await;
}

async fn assert_unsolicited_handoff_rejected(body: String) {
    let (base_url, server) = spawn_responses_sse(vec![body]);
    let hook = ContextHandoffHook::new(OVER_LIMIT, 0, true);
    let agent = test_agent(&base_url, &hook);
    tokio::time::timeout(DRIVE_TIMEOUT, async {
        let mut stream = agent
            .prompt("normal work")
            .add_hook(hook.clone())
            .add_hook(crate::hooks::AgentPromptHook::new(
                crate::hooks::ToolCallTracker::new("test-run", "test-claim"),
            ))
            .max_invalid_tool_call_retries(0)
            .stream();
        let mut rejected = false;
        while let Some(item) = stream.next().await {
            match item {
                Ok(MultiTurnStreamItem::StreamAssistantItem(Item::Event(StreamEvent::End {
                    content: AssistantContent::ToolCall(_),
                    ..
                })))
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
async fn accepted_handoff_ends_without_a_tool_result_or_followup_completion() {
    let (base_url, server) = spawn_responses_sse(vec![handoff_document_sse(FIRST_SUMMARY)]);
    let hook = ContextHandoffHook::new(OVER_LIMIT, 0, false);
    let agent = test_agent(&base_url, &hook);
    hook.start_handoff();
    let mut stream = agent
        .prompt(developer_message(HANDOFF_PROMPT))
        .add_hook(hook.clone())
        .stream();
    let mut completion_calls = 0;
    let mut stopped = false;
    tokio::time::timeout(DRIVE_TIMEOUT, async {
        while let Some(item) = stream.next().await {
            match item {
                Ok(MultiTurnStreamItem::CompletionCall(_)) => completion_calls += 1,
                Ok(MultiTurnStreamItem::ToolExecutionCommitted { .. })
                | Ok(MultiTurnStreamItem::StreamUserItem(_))
                | Ok(MultiTurnStreamItem::FinalResponse(_)) => {
                    panic!(
                        "an accepted handoff must stop before committing or emitting its result"
                    );
                }
                Err(PromptError::Cancelled {
                    reason,
                    chat_history,
                }) => {
                    assert_eq!(reason, HANDOFF_SUBMITTED);
                    assert!(!chat_history.iter().any(|message| matches!(
                        message,
                        Message::User { content, .. }
                            if content.iter().any(|part| matches!(part, UserContent::ToolResult(_)))
                    )));
                    stopped = true;
                }
                Err(error) => panic!("unexpected handoff error: {error}"),
                _ => {}
            }
        }
    })
    .await
    .expect("handoff termination timed out");
    assert!(stopped);
    assert_eq!(completion_calls, 1);
    assert_eq!(hook.take_summary().as_deref(), Some(FIRST_SUMMARY));
    let captured = server.join().expect("responses mock thread");
    assert_eq!(captured.len(), 1);
    let request = parse_request(&captured[0]);
    assert_handoff_request(&request);
    assert!(request["tool_choice"].is_null());
}

#[tokio::test]
async fn provider_switch_hands_off_with_the_old_model_before_resuming_on_the_new_model() {
    const INITIAL_CONTEXT: &str = "Workspace instructions shared by both providers.";
    const ENCRYPTED_REASONING: &str = "  old-provider-encrypted+reasoning/=\n  ";
    const REASONING_SUMMARY: &str = "Checked the arm bus before running pwd.";
    const OLD_ASSISTANT_TEXT: &str = "The firmware workspace is ready.";
    const OLD_CALL_ID: &str = "call_old_provider_exec";
    const TARGET_MODEL: &str = "new-provider-model";

    let (old_url, old_server) = spawn_responses_sse(vec![handoff_document_sse(FIRST_SUMMARY)]);
    let (new_url, new_server) =
        spawn_responses_sse(vec![text_sse("continued on the new provider", 4, 4)]);
    let hook = ContextHandoffHook::new(OVER_LIMIT, 0, true);
    let mut agent = test_agent(&old_url, &hook);
    let initial_context = Message::user(INITIAL_CONTEXT);
    let history = vec![
        initial_context.clone(),
        Message::user(OLD_CONTEXT),
        Message::Assistant {
            id: None,
            content: vec![
                AssistantContent::Reasoning(
                    Reasoning {
                        id: Some("rs_old_provider".to_string()),
                        content: vec![
                            ReasoningContent::Summary(REASONING_SUMMARY.to_string()),
                            ReasoningContent::Encrypted(ENCRYPTED_REASONING.to_string()),
                        ],
                    }
                    .sealed("openai"),
                ),
                AssistantContent::ToolCall(ToolCall {
                    id: CallId::from_wire(OLD_CALL_ID),
                    function: ToolFunction {
                        name: ToolName::new("exec_cmd").expect("fixture tool name"),
                        arguments: json!({ "cmd": "pwd" }),
                    },
                    signature: None,
                    additional_params: None,
                }),
            ],
        },
        Message::User {
            content: vec![UserContent::ToolResult(ToolResult {
                call: CallId::from_wire(OLD_CALL_ID),
                name: ToolName::new("exec_cmd").expect("fixture tool name"),
                content: vec![ToolResultContent::text(TOOL_RESULT)],
            })],
        },
        Message::assistant(OLD_ASSISTANT_TEXT),
    ];
    let pending_prompt = Message::user(DEFERRED_PROMPT);

    hook.start_handoff();
    let summary = match drive(&agent, &hook, developer_message(HANDOFF_PROMPT), history).await {
        DriveEnd::Submitted(document) => document,
        other => panic!("old provider should submit the handoff, got {other:?}"),
    };
    assert_eq!(summary, FIRST_SUMMARY);

    let saved_summary = std::cell::RefCell::new(None);
    let failed_transition = resume_context_handoff(
        &mut agent,
        std::slice::from_ref(&initial_context),
        &summary,
        Some(pending_prompt.clone()),
        async {
            *saved_summary.borrow_mut() = Some(summary.clone());
            Ok(true)
        },
        async {
            assert_eq!(saved_summary.borrow().as_deref(), Some(FIRST_SUMMARY));
            Err(anyhow::anyhow!("new provider temporarily unavailable"))
        },
    )
    .await;
    assert!(failed_transition.is_err());
    assert_eq!(saved_summary.borrow().as_deref(), Some(FIRST_SUMMARY));

    let target_model = stateless_responses_model(
        openai::OpenAIConfig::new("test-key")
            .with_base_url(&new_url)
            .with_instructions("context handoff fixture"),
        TARGET_MODEL,
    );
    let (history, prompt) = resume_context_handoff(
        &mut agent,
        std::slice::from_ref(&initial_context),
        &summary,
        Some(pending_prompt),
        async {
            assert_eq!(saved_summary.borrow().as_deref(), Some(FIRST_SUMMARY));
            Ok(true)
        },
        async { Ok(Some(target_model)) },
    )
    .await
    .expect("retry the saved handoff")
    .expect("active run");
    hook.restart();
    match drive(&agent, &hook, prompt, history).await {
        DriveEnd::Finished(text) => assert_eq!(text, "continued on the new provider"),
        other => panic!("new provider should answer the pending user prompt, got {other:?}"),
    }

    let old_requests = old_server.join().expect("old provider mock thread");
    let new_requests = new_server.join().expect("new provider mock thread");
    assert_eq!(
        old_requests.len(),
        1,
        "old provider only writes the handoff"
    );
    assert_eq!(new_requests.len(), 1, "new provider only resumes the work");
    let handoff = parse_request(&old_requests[0]);
    assert_eq!(handoff["model"], MODEL);
    let input = handoff["input"].as_array().expect("old provider input");
    let reasoning = input
        .iter()
        .find(|item| item["type"] == "reasoning")
        .expect("old provider receives encrypted history");
    assert_eq!(reasoning["encrypted_content"], ENCRYPTED_REASONING);
    assert!(input_blob(&handoff).contains(OLD_CONTEXT));
    assert!(input_blob(&handoff).contains(HANDOFF_PROMPT));
    assert!(!input_blob(&handoff).contains(DEFERRED_PROMPT));
    assert!(advertised_tools(&handoff).contains(&HandoffTool::NAME.to_string()));

    let resume = parse_request(&new_requests[0]);
    assert_eq!(resume["model"], TARGET_MODEL);
    assert_eq!(
        resume["input"],
        json!([
            { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": INITIAL_CONTEXT }] },
            { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": context_summary_text(&summary) }] },
            { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": DEFERRED_PROMPT }] }
        ]),
        "new provider must receive only initial context, the handoff summary, and the pending prompt"
    );
}

#[tokio::test]
async fn failed_provider_switch_continues_on_the_new_provider_without_reasoning() {
    const INITIAL_CONTEXT: &str = "Workspace instructions shared by both providers.";
    const ENCRYPTED_REASONING: &str = "sgr1.old-provider-envelope";
    const REASONING_SUMMARY: &str = "Checked the arm bus before running pwd.";
    const OLD_ASSISTANT_TEXT: &str = "The firmware workspace is ready.";
    const THOUGHT_SIGNATURE: &str = "old-provider-thought-signature";
    const OLD_CALL_ID: &str = "call_old_provider_exec";
    const TARGET_MODEL: &str = "new-provider-model";

    let (new_url, new_server) =
        spawn_responses_sse(vec![text_sse("continued without a handoff", 4, 4)]);
    let hook = ContextHandoffHook::new(OVER_LIMIT, 0, true);
    let mut agent = test_agent("http://127.0.0.1:1", &hook);
    let history = vec![
        Message::user(INITIAL_CONTEXT),
        Message::user(OLD_CONTEXT),
        Message::Assistant {
            id: None,
            content: vec![
                AssistantContent::Reasoning(
                    Reasoning {
                        id: Some("rs_old_provider".to_string()),
                        content: vec![
                            ReasoningContent::Summary(REASONING_SUMMARY.to_string()),
                            ReasoningContent::Encrypted(ENCRYPTED_REASONING.to_string()),
                        ],
                    }
                    .sealed("openai"),
                ),
                AssistantContent::Text(rig::message::Text {
                    text: OLD_ASSISTANT_TEXT.to_string(),
                    additional_params: None,
                }),
                AssistantContent::ToolCall(ToolCall {
                    id: CallId::from_wire(OLD_CALL_ID),
                    function: ToolFunction {
                        name: ToolName::new("exec_cmd").expect("fixture tool name"),
                        arguments: json!({ "cmd": "pwd" }),
                    },
                    signature: Some(THOUGHT_SIGNATURE.to_string()),
                    additional_params: None,
                }),
            ],
        },
        Message::User {
            content: vec![UserContent::ToolResult(ToolResult {
                call: CallId::from_wire(OLD_CALL_ID),
                name: ToolName::new("exec_cmd").expect("fixture tool name"),
                content: vec![ToolResultContent::text(TOOL_RESULT)],
            })],
        },
    ];
    let pending_prompt = Message::user(DEFERRED_PROMPT);
    let target_model = stateless_responses_model(
        openai::OpenAIConfig::new("test-key")
            .with_base_url(&new_url)
            .with_instructions("context handoff fixture"),
        TARGET_MODEL,
    );
    let (history, prompt) = resume_without_provider_handoff(
        &mut agent,
        history,
        pending_prompt,
        async { Ok(true) },
        async { Ok(target_model) },
    )
    .await
    .expect("failed handoff falls back to the selected provider")
    .expect("active run");

    hook.restart();
    match drive(&agent, &hook, prompt, history).await {
        DriveEnd::Finished(text) => assert_eq!(text, "continued without a handoff"),
        other => panic!("new provider should answer the pending user prompt, got {other:?}"),
    }

    let new_requests = new_server.join().expect("new provider mock thread");
    assert_eq!(new_requests.len(), 1);
    let resume = parse_request(&new_requests[0]);
    assert_eq!(resume["model"], TARGET_MODEL);
    let blob = input_blob(&resume);
    assert!(blob.contains(OLD_CONTEXT));
    assert!(blob.contains(OLD_ASSISTANT_TEXT));
    assert!(blob.contains(TOOL_RESULT));
    assert!(blob.contains(DEFERRED_PROMPT));
    assert!(!blob.contains(ENCRYPTED_REASONING));
    assert!(!blob.contains("rs_old_provider"));
    assert!(!blob.contains(REASONING_SUMMARY));
    assert!(!blob.contains(THOUGHT_SIGNATURE));
    assert!(!blob.contains(HANDOFF_PROMPT));
    assert!(
        resume["input"]
            .as_array()
            .expect("new provider input")
            .iter()
            .all(|item| item["type"] != "reasoning")
    );
}

#[tokio::test]
async fn over_budget_turn_is_replaced_by_the_hidden_handoff_prompt() {
    let (base_url, server) = spawn_responses_sse(vec![
        handoff_document_sse(FIRST_SUMMARY),
        text_sse("continued from handoff", 4, 4),
    ]);
    let hook = ContextHandoffHook::new(OVER_LIMIT, OVER_LIMIT, true);
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
        developer_message(HANDOFF_PROMPT),
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
        "fresh runner must not replay pre-handoff history"
    );
    assert!(
        !resume_input.contains(HANDOFF_PROMPT),
        "fresh runner must not keep the hidden handoff prompt"
    );
    let resume_tools = advertised_tools(&resume);
    assert!(
        resume_tools.contains(&"exec_cmd".to_string()),
        "fresh runner should advertise agent tools again, got {resume_tools:?}"
    );
    assert!(
        resume_tools.contains(&HandoffTool::NAME.to_string()),
        "fresh runner must keep advertising the handoff tool, got {resume_tools:?}"
    );
    assert_eq!(handoff["tools"], resume["tools"]);
    assert_eq!(handoff["tool_choice"], resume["tool_choice"]);
    assert_eq!(handoff["instructions"], resume["instructions"]);
}

#[tokio::test]
async fn mid_run_handoff_keeps_the_pending_tool_result() {
    let (base_url, server) = spawn_responses_sse(vec![
        exec_command_sse(80, 20),
        handoff_document_sse(FIRST_SUMMARY),
    ]);
    let hook = ContextHandoffHook::new(50, 0, false);
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
        developer_message(HANDOFF_PROMPT),
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
        tool_turn_tools.contains(&"exec_cmd".to_string()),
        "pre-handoff completion should advertise exec_cmd, got {tool_turn_tools:?}"
    );
    assert!(
        tool_turn_tools.contains(&HandoffTool::NAME.to_string()),
        "pre-handoff completion must advertise the handoff tool, got {tool_turn_tools:?}"
    );

    let handoff = parse_request(&captured[1]);
    assert_handoff_request(&handoff);
    assert_eq!(tool_turn["tools"], handoff["tools"]);
    assert_eq!(tool_turn["tool_choice"], handoff["tool_choice"]);
    assert_eq!(tool_turn["instructions"], handoff["instructions"]);
    let original_input = tool_turn["input"].as_array().expect("original input");
    let handoff_input = handoff["input"].as_array().expect("handoff input");
    assert_eq!(&handoff_input[..original_input.len()], original_input);
    assert!(
        input_blob(&handoff).contains(TOOL_RESULT),
        "handoff request must carry the pending tool result, got {}",
        input_blob(&handoff)
    );
}

#[tokio::test]
async fn context_handoff_repeats_after_restart() {
    let (base_url, server) = spawn_responses_sse(vec![
        handoff_document_sse(FIRST_SUMMARY),
        exec_command_sse(90, 20),
        handoff_document_sse(SECOND_SUMMARY),
    ]);
    let hook = ContextHandoffHook::new(OVER_LIMIT, OVER_LIMIT, true);
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
    match drive(
        &agent,
        &hook,
        developer_message(HANDOFF_PROMPT),
        first.history,
    )
    .await
    {
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
        "second handoff must not revive the original pre-handoff context"
    );

    hook.start_handoff();
    match drive(
        &agent,
        &hook,
        developer_message(HANDOFF_PROMPT),
        second.history,
    )
    .await
    {
        DriveEnd::Submitted(document) => assert_eq!(document, SECOND_SUMMARY),
        other => panic!("second handoff should submit a new document, got {other:?}"),
    }

    let captured = server.join().expect("responses mock thread");
    assert_eq!(
        captured.len(),
        3,
        "handoff, tool, handoff, got {captured:?}"
    );
    let first_handoff = parse_request(&captured[0]);
    let ordinary = parse_request(&captured[1]);
    let second_handoff = parse_request(&captured[2]);
    assert_handoff_request(&first_handoff);
    assert_handoff_request(&second_handoff);
    assert_eq!(first_handoff["tools"], ordinary["tools"]);
    assert_eq!(first_handoff["tools"], second_handoff["tools"]);
    assert_eq!(first_handoff["tool_choice"], ordinary["tool_choice"]);
    assert_eq!(first_handoff["tool_choice"], second_handoff["tool_choice"]);
    assert_eq!(hook.take_summary(), None);
}

#[tokio::test]
async fn empty_handoff_document_is_rejected() {
    let (base_url, server) = spawn_responses_sse(vec![handoff_document_sse("   ")]);
    let hook = ContextHandoffHook::new(OVER_LIMIT, 0, false);
    let agent = test_agent(&base_url, &hook);
    hook.start_handoff();

    match drive(&agent, &hook, developer_message(HANDOFF_PROMPT), Vec::new()).await {
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
    let hook = ContextHandoffHook::new(OVER_LIMIT, 0, false);
    let agent = test_agent(&base_url, &hook);
    hook.start_handoff();

    match drive(&agent, &hook, developer_message(HANDOFF_PROMPT), Vec::new()).await {
        DriveEnd::Stopped(reason) => assert_eq!(reason, HANDOFF_FAILED),
        other => panic!("truncated handoff should stop the turn, got {other:?}"),
    }
    assert_eq!(hook.take_summary(), None);
    let _ = server.join().expect("responses mock thread");
}

#[tokio::test]
async fn text_only_handoff_turn_is_rejected() {
    let (base_url, server) = spawn_responses_sse(vec![text_sse("I will summarise in prose", 8, 8)]);
    let hook = ContextHandoffHook::new(OVER_LIMIT, 0, false);
    let agent = test_agent(&base_url, &hook);
    hook.start_handoff();

    match drive(&agent, &hook, developer_message(HANDOFF_PROMPT), Vec::new()).await {
        DriveEnd::Stopped(reason) => assert_eq!(reason, HANDOFF_FAILED),
        other => panic!("a text-only handoff turn should fail, got {other:?}"),
    }
    assert_eq!(hook.take_summary(), None);
    let _ = server.join().expect("responses mock thread");
}

#[tokio::test]
async fn two_handoff_tool_calls_are_rejected() {
    let (base_url, server) = spawn_responses_sse(vec![two_tool_calls_sse()]);
    let hook = ContextHandoffHook::new(OVER_LIMIT, 0, false);
    let agent = test_agent(&base_url, &hook);
    hook.start_handoff();

    match drive(&agent, &hook, developer_message(HANDOFF_PROMPT), Vec::new()).await {
        DriveEnd::Stopped(reason) => assert_eq!(reason, HANDOFF_FAILED),
        other => panic!("two handoff tool calls should fail, got {other:?}"),
    }
    assert_eq!(hook.take_summary(), None);
    let _ = server.join().expect("responses mock thread");
}

#[tokio::test]
async fn handoff_turn_only_accepts_the_handoff_tool_even_with_other_tools_advertised() {
    let (base_url, server) = spawn_responses_sse(vec![exec_command_sse(4, 4)]);
    let hook = ContextHandoffHook::new(OVER_LIMIT, 0, false);
    let agent = test_agent(&base_url, &hook);
    hook.start_handoff();

    match drive(&agent, &hook, developer_message(HANDOFF_PROMPT), Vec::new()).await {
        DriveEnd::Stopped(reason) => assert_eq!(reason, HANDOFF_FAILED),
        other => panic!("handoff turn must reject an ordinary tool call, got {other:?}"),
    }
    assert!(hook.take_summary().is_none());
    let captured = server.join().expect("responses mock thread");
    assert_eq!(captured.len(), 1);
    assert_handoff_request(&parse_request(&captured[0]));
}

#[tokio::test]
async fn handoff_typos_cannot_bypass_single_call_validation_through_repair() {
    let body = two_tool_calls_sse().replace("handoff_context", "handoff-context");
    let (base_url, server) = spawn_responses_sse(vec![body]);
    let hook = ContextHandoffHook::new(OVER_LIMIT, 0, false);
    hook.start_handoff();
    let agent = test_agent(&base_url, &hook);
    let mut stream = agent
        .prompt("write the handoff")
        .add_hook(hook.clone())
        .add_hook(crate::hooks::AgentPromptHook::new(
            crate::hooks::ToolCallTracker::new("run", "claim"),
        ))
        .stream();
    let mut failed = false;
    while let Some(item) = stream.next().await {
        match item {
            Ok(MultiTurnStreamItem::ToolExecutionCommitted { .. }) => {
                panic!("invalid handoff must not execute")
            }
            Err(_) => {
                failed = true;
                break;
            }
            _ => {}
        }
    }
    assert!(failed);
    assert!(hook.take_summary().is_none());
    assert_eq!(server.join().unwrap().len(), 1);
}
