use super::*;
use rig::completion::{Effort, GenerationOptions, ToolDefinition};
use rig::message::ToolName;
use rig::wire::Body;

#[test]
fn requests_carry_instructions_summarized_thinking_and_claude_safe_tool_schemas() {
    let wire = claude_messages(
        AnthropicConfig::new("key"),
        "claude-opus-5-5",
        "Be brief.",
        Some("1h"),
        None,
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
    assert_eq!(encoded.request.headers()["x-api-key"], "key");
    let Body::Bytes(bytes) = encoded.request.into_body() else {
        panic!("Messages uses JSON");
    };
    let body: Value = serde_json::from_slice(&bytes).unwrap();
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
fn vertex_requests_name_the_model_and_version_where_vertex_reads_them() {
    let mut config = AnthropicConfig::new("").with_version(VERTEX_ANTHROPIC_VERSION);
    config.addressing = Addressing::Url;
    let models_url = "https://aiplatform.googleapis.com/v1/projects/p/locations/global/publishers/anthropic/models";
    let wire = claude_messages(
        config,
        "claude-opus-5-5",
        "Be brief.",
        Some("1h"),
        Some(models_url.to_string()),
    );
    let encoded = wire
        .encode(CompletionRequest::new("next"), Mode::Streaming)
        .unwrap();
    assert_eq!(
        encoded.request.uri().to_string(),
        format!("{models_url}/claude-opus-5-5:streamRawPredict")
    );
    assert!(!encoded.request.headers().contains_key("x-api-key"));
    let Body::Bytes(bytes) = encoded.request.into_body() else {
        panic!("Messages uses JSON");
    };
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(body["anthropic_version"], VERTEX_ANTHROPIC_VERSION);
    assert_eq!(body.get("model"), None);
    assert_eq!(body["stream"], true);
    assert_eq!(body["cache_control"]["ttl"], "1h");
}
