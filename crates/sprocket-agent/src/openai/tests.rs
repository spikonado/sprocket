use super::*;
use rig::message::Message;
use serde_json::json;

#[test]
fn stateless_requests_keep_developer_messages_and_request_encrypted_reasoning() {
    let mut request = CompletionRequest::new("next");
    request
        .chat_history
        .insert(0, Message::system("Mid-run rule."));
    request.additional_params = Some(json!({
        "store": true,
        "include": ["message.output_text.logprobs"],
    }));
    let encoded = StatelessResponses(Responses::new(OpenAIConfig::new("test"), "gpt-5"))
        .encode(request, Mode::Streaming)
        .unwrap();
    let Body::Bytes(bytes) = encoded.request.into_body() else {
        panic!("Responses uses JSON");
    };
    let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(body["store"], false);
    assert_eq!(body["input"][0]["role"], "developer");
    assert_eq!(body["input"][0]["content"][0]["text"], "Mid-run rule.");
    assert_eq!(
        body["include"],
        json!([
            "message.output_text.logprobs",
            "reasoning.encrypted_content",
        ])
    );
}
