use super::*;
use rig::completion::{Effort, GenerationOptions, ToolDefinition};
use rig::message::ToolName;
use rig::wire::Body;

fn encode(
    host: &MessagesHost,
    model: &str,
    anthropic_model: Option<&str>,
) -> (http::HeaderMap, Value) {
    let wire = claude_messages(
        host,
        "key".to_string(),
        model,
        anthropic_model,
        "Be brief.",
        Some("1h"),
    );
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
        panic!("Messages uses JSON");
    };
    (headers, serde_json::from_slice(&bytes).unwrap())
}

#[test]
fn requests_carry_instructions_summarized_thinking_and_claude_safe_tool_schemas() {
    let (headers, body) = encode(&ANTHROPIC, "claude-opus-5-5", None);
    assert_eq!(headers["x-api-key"], "key");
    assert_eq!(body["system"][0]["text"], "Be brief.");
    assert_eq!(body["thinking"]["type"], "adaptive");
    assert_eq!(body["thinking"]["display"], "summarized");
    assert_eq!(body["cache_control"]["ttl"], "1h");
    assert_eq!(body["max_tokens"], 128_000);
    assert_eq!(
        body["tools"][0]["input_schema"],
        json!({
            "type": "object",
            "properties": {"cmd": {"type": "string"}},
            "not": {"not": {"anyOf": [{"required": ["cmd"]}]}},
        })
    );
}

#[test]
fn openrouter_takes_its_key_as_a_bearer_token_for_its_model_id() {
    let (headers, body) = encode(
        &OPENROUTER,
        "anthropic/claude-opus-5.5",
        Some("claude-opus-5-5"),
    );
    assert!(!headers.contains_key("x-api-key"));
    assert_eq!(headers[http::header::AUTHORIZATION], "Bearer key");
    assert_eq!(body["model"], "anthropic/claude-opus-5.5");
    assert_eq!(body["max_tokens"], 128_000);
    assert_eq!(body["thinking"]["type"], "adaptive");
}
