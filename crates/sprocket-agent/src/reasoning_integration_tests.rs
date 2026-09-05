//! Native Rig streaming, durable transcript reload, and Responses serialization.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::thread;
use std::time::{Duration, Instant};

use futures::StreamExt;
use rig::client::CompletionClient;
use rig::completion::{CompletionModel, Message};
use rig::message::{AssistantContent, Reasoning};
use rig::providers::openai;
use rig::streaming::StreamedAssistantContent;
use serde_json::{Value as JsonValue, json};

use super::{contiguous_text_id, durable_items_json};
use crate::live::{LiveAssistantPart, LiveAssistantParts, now_ms};
use crate::reasoning::{apply_completed_reasoning, merge_provider_metadata};
use crate::transcript::{TranscriptPart, TranscriptStore, agent_history_from_parts};
use crate::types::{AgentHistoryMessage, deserialize_agent_history};

const STREAM_ID: &str = "stream";
const ITEM_ID: &str = "rs_gateway";
const ENVELOPE: &str = "gway-envelope-v1";
const DELTA_SUMMARY: &str = "partial";
const DONE_SUMMARY: &str = "full gateway summary";
const TOOL_CALL_ID: &str = "call_1";
const TOOL_NAME: &str = "exec_command";
const TEXT: &str = "done.";

#[derive(Debug, PartialEq, Eq)]
enum Observed {
    ReasoningDelta,
    ReasoningDone,
    Text,
    ToolCall,
}

fn sse(event: JsonValue) -> String {
    format!("data: {event}\n\n")
}

fn gateway_response(status: &str, output: Vec<JsonValue>) -> JsonValue {
    json!({
        "id": "resp_gateway",
        "object": "response",
        "created_at": 0,
        "status": status,
        "model": "gateway-model",
        "output": output,
        "tools": [],
        "usage": {
            "input_tokens": 1,
            "output_tokens": 1,
            "total_tokens": 2
        }
    })
}

/// Gateway wire order: empty encrypted reasoning item, summary delta, then
/// authoritative completed reasoning, then function call, then text.
fn gateway_sse_body() -> String {
    let empty_reasoning = json!({
        "type": "reasoning",
        "id": ITEM_ID,
        "summary": [],
        "content": [],
        "encrypted_content": "",
        "status": "in_progress"
    });
    let completed_reasoning = json!({
        "type": "reasoning",
        "id": ITEM_ID,
        "summary": [{ "type": "summary_text", "text": DONE_SUMMARY }],
        "encrypted_content": ENVELOPE,
        "status": "completed"
    });
    let function_call = json!({
        "type": "function_call",
        "id": "fc_1",
        "call_id": TOOL_CALL_ID,
        "name": TOOL_NAME,
        "arguments": "{\"cmd\":\"pwd\"}",
        "status": "completed"
    });
    let message = json!({
        "type": "message",
        "id": "msg_1",
        "role": "assistant",
        "status": "completed",
        "content": [{ "type": "output_text", "text": TEXT }]
    });

    [
        sse(json!({
            "type": "response.created",
            "sequence_number": 0,
            "response": gateway_response("in_progress", vec![]),
        })),
        sse(json!({
            "type": "response.output_item.added",
            "item_id": ITEM_ID,
            "output_index": 0,
            "sequence_number": 1,
            "item": empty_reasoning,
        })),
        sse(json!({
            "type": "response.reasoning_summary_text.delta",
            "item_id": ITEM_ID,
            "output_index": 0,
            "summary_index": 0,
            "sequence_number": 2,
            "delta": DELTA_SUMMARY,
        })),
        sse(json!({
            "type": "response.output_item.done",
            "item_id": ITEM_ID,
            "output_index": 0,
            "sequence_number": 3,
            "item": completed_reasoning.clone(),
        })),
        sse(json!({
            "type": "response.output_item.added",
            "item_id": "fc_1",
            "output_index": 1,
            "sequence_number": 4,
            "item": function_call.clone(),
        })),
        sse(json!({
            "type": "response.output_item.done",
            "item_id": "fc_1",
            "output_index": 1,
            "sequence_number": 5,
            "item": function_call.clone(),
        })),
        sse(json!({
            "type": "response.output_text.delta",
            "item_id": "msg_1",
            "output_index": 2,
            "content_index": 0,
            "sequence_number": 6,
            "delta": TEXT,
        })),
        sse(json!({
            "type": "response.completed",
            "sequence_number": 7,
            "response": gateway_response(
                "completed",
                vec![completed_reasoning, function_call, message],
            ),
        })),
    ]
    .concat()
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

fn spawn_gateway_sse(sse_body: String) -> (String, thread::JoinHandle<Vec<Vec<u8>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("ephemeral listener");
    listener.set_nonblocking(true).expect("nonblocking accept");
    let addr = listener.local_addr().expect("listener address");
    let handle = thread::spawn(move || {
        let mut captured = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(8);
        let mut idle_since = None;
        while Instant::now() < deadline {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let _ = stream.set_nonblocking(false);
                    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
                    captured.push(read_http_request(&mut stream));
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
                    idle_since = Some(Instant::now());
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    if idle_since.is_some_and(|since| since.elapsed() > Duration::from_millis(250))
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

fn live_reasoning_text(parts: &[LiveAssistantPart]) -> Option<&str> {
    parts.iter().find_map(|part| match part {
        LiveAssistantPart::Reasoning { text, .. } => Some(text.as_str()),
        _ => None,
    })
}

async fn durable_history_from_parts(
    parts: &[LiveAssistantPart],
    provider_metadata: &HashMap<String, JsonValue>,
) -> Vec<AgentHistoryMessage> {
    let items = durable_items_json(parts, provider_metadata, true);
    let part: TranscriptPart = serde_json::from_value(json!({
        "number": 0,
        "sourceKey": "completion:test",
        "kind": "completion",
        "runId": "run",
        "completion": { "streamId": STREAM_ID, "items": items }
    }))
    .expect("transcript fixture");
    let tool_result: TranscriptPart = serde_json::from_value(json!({
        "number": 1,
        "sourceKey": "tool:test:finished",
        "kind": "tool",
        "runId": "run",
        "tool": {
            "toolInvocationId": "test",
            "callId": TOOL_CALL_ID,
            "name": TOOL_NAME,
            "output": "/workspace",
            "status": "completed"
        }
    }))
    .expect("tool result fixture");
    let dir = std::env::temp_dir().join(format!("sprocket-native-replay-{}", uuid::Uuid::new_v4()));
    let store = TranscriptStore::new(dir.clone());
    store
        .append_parts("user", "thread", &[part, tool_result])
        .await
        .unwrap();
    let loaded = store.read_parts("user", "thread", &[0, 1]).await.unwrap();
    let state = store.load_state("user", "thread").await.unwrap();
    let history = agent_history_from_parts(&state, &loaded, None);
    tokio::fs::remove_dir_all(dir).await.unwrap();
    history
}

fn first_index(events: &[Observed], kind: Observed) -> Option<usize> {
    events.iter().position(|event| *event == kind)
}

#[tokio::test]
async fn gateway_responses_stream_completes_reasoning_before_text_and_tools() {
    let (base_url, server) = spawn_gateway_sse(gateway_sse_body());
    let client = openai::Client::builder()
        .api_key("test-key")
        .base_url(&base_url)
        .build()
        .expect("openai responses client");
    let model = client.completion_model("gateway-model");
    let request = model.completion_request("hello").build();
    let mut stream = model
        .stream(request)
        .await
        .expect("mocked responses stream");

    let mut parts = LiveAssistantParts::default();
    let mut provider_metadata = HashMap::new();
    let mut observed = Vec::new();
    let mut completed: Option<Reasoning> = None;

    while let Some(item) = stream.next().await {
        match item.expect("stream item") {
            StreamedAssistantContent::ReasoningDelta { id, reasoning, .. } => {
                observed.push(Observed::ReasoningDelta);
                parts.apply_text_delta(
                    "reasoning",
                    format!("{STREAM_ID}:{id}"),
                    &reasoning,
                    Some(STREAM_ID.to_string()),
                    now_ms(),
                );
                let text = live_reasoning_text(&parts.parts).expect("live reasoning after delta");
                assert_eq!(text, DELTA_SUMMARY);
                assert!(
                    !text.contains(ENVELOPE),
                    "deltas must not surface ciphertext"
                );
            }
            StreamedAssistantContent::Reasoning { reasoning, id } => {
                observed.push(Observed::ReasoningDone);
                assert_eq!(reasoning.id.as_deref(), Some(ITEM_ID));
                assert_eq!(reasoning.display_text(), DONE_SUMMARY);
                assert_eq!(reasoning.encrypted_content(), Some(ENVELOPE));
                assert!(
                    !reasoning.display_text().contains(ENVELOPE),
                    "completed live summary must not include envelope bytes"
                );
                apply_completed_reasoning(
                    &mut parts,
                    &mut provider_metadata,
                    STREAM_ID,
                    &id,
                    &reasoning,
                );
                completed = Some(reasoning);
            }
            StreamedAssistantContent::Text(text) => {
                observed.push(Observed::Text);
                parts.apply_text_delta(
                    "text",
                    contiguous_text_id(&parts.parts, STREAM_ID),
                    &text.text,
                    Some(STREAM_ID.to_string()),
                    now_ms(),
                );
            }
            StreamedAssistantContent::ToolCall { tool_call, .. } => {
                observed.push(Observed::ToolCall);
                parts.apply_tool_call(
                    Some(tool_call.id.as_str().to_string()),
                    tool_call.wire_call_id().to_string(),
                    tool_call.function.name,
                    tool_call.function.arguments,
                    Some(STREAM_ID.to_string()),
                    now_ms(),
                );
            }
            StreamedAssistantContent::ToolCallDelta { .. }
            | StreamedAssistantContent::Final(_)
            | StreamedAssistantContent::Unknown(_) => {}
        }
    }

    let reasoning_delta = first_index(&observed, Observed::ReasoningDelta)
        .expect("gateway summary delta must stream");
    let reasoning_done = first_index(&observed, Observed::ReasoningDone)
        .expect("gateway done item must yield completed reasoning");
    let text = first_index(&observed, Observed::Text).expect("gateway text must stream");
    let tool =
        first_index(&observed, Observed::ToolCall).expect("gateway function call must stream");
    assert!(
        reasoning_delta < reasoning_done,
        "summary delta must precede the authoritative done item, got {observed:?}"
    );
    assert!(
        reasoning_done < text && reasoning_done < tool,
        "gateway completes reasoning before text/tool, got {observed:?}"
    );
    assert_ne!(
        text, tool,
        "function call and text must both appear as distinct stream events: {observed:?}"
    );
    assert_eq!(
        observed
            .iter()
            .filter(|event| **event == Observed::ReasoningDone)
            .count(),
        1,
        "empty added item must not yield a second completed reasoning, got {observed:?}"
    );

    let completed = completed.expect("completed reasoning");
    let reasoning_part = parts
        .parts
        .iter()
        .find(|part| matches!(part, LiveAssistantPart::Reasoning { .. }))
        .expect("live reasoning part");
    let live_text = live_reasoning_text(&parts.parts).expect("live reasoning text");
    assert_eq!(live_text, DONE_SUMMARY);
    assert!(!live_text.contains(ENVELOPE));
    assert_ne!(live_text, DELTA_SUMMARY, "done summary is authoritative");
    assert!(
        parts
            .parts
            .iter()
            .any(|part| matches!(part, LiveAssistantPart::Text { text, .. } if text == TEXT))
    );
    assert!(parts.parts.iter().any(|part| {
        matches!(
            part,
            LiveAssistantPart::ToolCall {
                call_id,
                name,
                ..
            } if call_id == TOOL_CALL_ID && name == TOOL_NAME
        )
    }));

    let reasoning_key = match reasoning_part {
        LiveAssistantPart::Reasoning { id, .. } => format!("reasoning:{id}"),
        _ => panic!("expected reasoning part"),
    };
    assert_eq!(
        provider_metadata[&reasoning_key],
        json!({
            "openai": {
                "itemId": ITEM_ID,
                "reasoningEncryptedContent": ENVELOPE
            }
        })
    );
    for value in provider_metadata.values() {
        if let Some(encrypted) = value.pointer("/openai/reasoningEncryptedContent") {
            assert_eq!(encrypted, ENVELOPE);
        }
    }
    let durable = merge_provider_metadata(reasoning_part, provider_metadata.get(&reasoning_key));
    assert_eq!(durable["text"], DONE_SUMMARY);
    assert_eq!(
        durable["providerMetadata"]["openai"]["reasoningEncryptedContent"],
        ENVELOPE
    );
    assert_eq!(completed.encrypted_content(), Some(ENVELOPE));

    let history = deserialize_agent_history(
        durable_history_from_parts(&parts.parts, &provider_metadata).await,
    )
    .expect("durable history conversion");
    match &history[0] {
        Message::Assistant { content, .. } => {
            let reasoning = content.iter().find_map(|part| match part {
                AssistantContent::Reasoning(reasoning) => Some(reasoning),
                _ => None,
            });
            let reasoning = reasoning.expect("durable reasoning");
            assert_eq!(reasoning.id.as_deref(), Some(ITEM_ID));
            assert_eq!(reasoning.display_text(), DONE_SUMMARY);
            assert_eq!(reasoning.encrypted_content(), Some(ENVELOPE));
            assert_eq!(content.len(), 3);
            assert!(content.iter().any(|part| matches!(
                part,
                AssistantContent::ToolCall(call)
                    if call.wire_call_id() == TOOL_CALL_ID
                        && call.function.name == TOOL_NAME
                        && call.function.arguments == json!({ "cmd": "pwd" })
            )));
            assert!(content.iter().any(|part| matches!(
                part, AssistantContent::Text(text) if text.text == TEXT
            )));
        }
        other => panic!("expected assistant history, got {other:?}"),
    }

    let replay = openai::responses_api::CompletionRequest::try_from((
        "gateway-model".to_string(),
        model
            .completion_request(Message::user("next"))
            .messages(std::iter::once(Message::user("hello")).chain(history))
            .additional_params(json!({ "reasoning": { "effort": "medium" } }))
            .build(),
    ))
    .expect("native responses replay request");
    let replay = serde_json::to_value(&replay).expect("serialize replay");
    let reasoning_input = replay["input"]
        .as_array()
        .expect("replay input")
        .iter()
        .find(|item| item.get("type").and_then(JsonValue::as_str) == Some("reasoning"))
        .expect("replay should carry the native reasoning item");
    assert_eq!(reasoning_input["id"], ITEM_ID);
    assert_eq!(reasoning_input["encrypted_content"], ENVELOPE);
    assert_eq!(
        reasoning_input["summary"],
        json!([{ "type": "summary_text", "text": DONE_SUMMARY }])
    );
    let inputs = replay["input"].as_array().unwrap();
    assert_eq!(inputs.len(), 6);
    assert_eq!(inputs[1]["type"], "reasoning");
    let (text_index, tool_index) = if text < tool { (2, 3) } else { (3, 2) };
    assert_eq!(inputs[tool_index]["type"], "function_call");
    assert_eq!(inputs[tool_index]["call_id"], TOOL_CALL_ID);
    assert_eq!(inputs[tool_index]["name"], TOOL_NAME);
    assert_eq!(inputs[text_index]["role"], "assistant");
    assert_eq!(inputs[text_index]["content"], TEXT);
    assert_eq!(inputs[4]["type"], "function_call_output");
    assert_eq!(inputs[4]["call_id"], TOOL_CALL_ID);
    assert!(inputs[4]["output"].to_string().contains("/workspace"));

    let after_compaction = durable_items_json(&parts.parts, &provider_metadata, false);
    assert!(
        after_compaction
            .iter()
            .all(|item| item["providerMetadata"].is_null())
    );
    assert_eq!(after_compaction[0]["text"], DONE_SUMMARY);

    let requests = server.join().expect("gateway mock thread");
    assert!(
        requests.iter().any(|body| {
            let Ok(value) = serde_json::from_slice::<JsonValue>(body) else {
                return false;
            };
            value.get("stream") == Some(&json!(true))
                && value.get("model") == Some(&json!("gateway-model"))
        }),
        "mocked Responses POST should be a stream request, got {requests:?}"
    );
}
