use std::sync::Arc;

use super::*;
use rig::completion::{Effort, GenerationOptions, ToolDefinition};
use rig::message::ToolName;
use rig::wire::Body;

fn encode(gateway: ResponsesGateway) -> (http::HeaderMap, Value) {
    let wire = gateway_responses(
        gateway,
        "key".to_string(),
        "anthropic/claude-opus-5.5",
        true,
        Some("1h"),
        "Be brief.",
        "thread-1",
    )
    .unwrap();
    let mut request = CompletionRequest::new("next");
    request.options = GenerationOptions::default().reasoning(Effort::High);
    request.tools.push(Arc::new(ToolDefinition::new(
        ToolName::new("exec").unwrap(),
        "Run a command.",
        json!({
            "type": "object",
            "properties": {"cmd": {"type": "string"}},
            "anyOf": [{"required": ["cmd"]}],
        }),
    )));
    let encoded = wire.encode(request, Mode::Streaming).unwrap();
    let headers = encoded.request.headers().clone();
    let Body::Bytes(bytes) = encoded.request.into_body() else {
        panic!("Responses uses JSON");
    };
    (headers, serde_json::from_slice(&bytes).unwrap())
}

#[test]
fn vercel_claude_requests_ask_for_summarized_thinking_and_anchored_caching() {
    let (headers, body) = encode(ResponsesGateway::Vercel);
    assert_eq!(headers["http-referer"], APP_URL);
    assert_eq!(headers["x-title"], APP_TITLE);
    assert_eq!(body["store"], false);
    assert_eq!(body["reasoning"]["effort"], "high");
    assert_eq!(
        body["providerOptions"],
        json!({"anthropic": {
            "thinking": {"type": "adaptive", "display": "summarized"},
            "effort": "high",
        }})
    );
    assert_eq!(body["caching"], "auto");
    assert_eq!(body["cache_ttl"], "1h");
    assert_eq!(body["cache_anchor_items"], 1);
    assert_eq!(
        body["tools"][0]["parameters"]["not"],
        json!({"not": {"anyOf": [{"required": ["cmd"]}]}})
    );
}

#[test]
fn openrouter_claude_requests_cache_without_asking_for_ciphertext() {
    let (headers, body) = encode(ResponsesGateway::Openrouter);
    assert_eq!(headers[http::header::AUTHORIZATION], "Bearer key");
    assert_eq!(headers["http-referer"], APP_URL);
    assert_eq!(body["model"], "anthropic/claude-opus-5.5");
    assert_eq!(body["reasoning"]["effort"], "high");
    assert_eq!(
        body["cache_control"],
        json!({"type": "ephemeral", "ttl": "1h"})
    );
    assert!(body.get("include").is_none());
}

#[test]
fn opencode_go_requests_carry_the_thread_as_session() {
    let (headers, _) = encode(ResponsesGateway::OpencodeGo);
    assert_eq!(headers["x-opencode-session"], "thread-1");
}

#[test]
fn gateway_reasoning_events_take_their_spec_types() {
    let frame = spec_reasoning_event(WireFrame::Text(
        json!({"type": "response.reasoning.delta", "delta": "plan"}).to_string(),
    ));
    let event: Value = serde_json::from_str(&frame.as_str()).unwrap();
    assert_eq!(event["type"], "response.reasoning_text.delta");
    assert_eq!(event["delta"], "plan");
}
