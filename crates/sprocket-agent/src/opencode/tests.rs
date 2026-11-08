use super::*;
use rig::providers::openai::wire::OPENCODE_GO;

#[test]
fn go_chat_requests_carry_the_session_and_instructions_first() {
    let wire = OpencodeWire::new(
        OpenAIConfig::with_key(&OPENCODE_GO, "key").chat("deepseek-v4.1-flash"),
        HeaderValue::from_static("thread-1"),
        Some("Be brief.".to_string()),
    );
    let encoded = wire
        .encode(CompletionRequest::new("next"), Mode::Streaming)
        .unwrap();
    assert_eq!(
        encoded.request.uri().to_string(),
        "https://opencode.ai/inference/go/openai/v1/chat/completions"
    );
    assert_eq!(encoded.request.headers()[SESSION_HEADER], "thread-1");
    let rig::wire::Body::Bytes(bytes) = encoded.request.into_body() else {
        panic!("Chat Completions uses JSON");
    };
    let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(body["messages"][0]["role"], "system");
    assert_eq!(body["messages"][0]["content"][0]["text"], "Be brief.");
}
