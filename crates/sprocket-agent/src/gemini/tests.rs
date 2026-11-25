use super::*;
use rig::completion::{Effort, GenerationOptions};
use rig::wire::Body;
use serde_json::Value;

fn encode(wire: &GeminiContent) -> (String, Value) {
    let mut request = CompletionRequest::new("next");
    request.options = GenerationOptions::default().reasoning(Effort::High);
    let encoded = wire.encode(request, Mode::Streaming).unwrap();
    let uri = encoded.request.uri().to_string();
    let Body::Bytes(bytes) = encoded.request.into_body() else {
        panic!("GenerateContent uses JSON");
    };
    (uri, serde_json::from_slice(&bytes).unwrap())
}

#[test]
fn requests_carry_instructions_and_ask_for_thought_summaries() {
    let wire = gemini_content(
        GeminiConfig::new("key"),
        "gemini-3.8-flash",
        "Be brief.",
        None,
    );
    let (uri, body) = encode(&wire);
    assert!(uri.contains("/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse"));
    assert_eq!(body["systemInstruction"]["parts"][0]["text"], "Be brief.");
    assert_eq!(
        body["generationConfig"]["thinkingConfig"],
        serde_json::json!({"thinkingLevel": "high", "includeThoughts": true})
    );
}

#[test]
fn vertex_requests_go_to_the_project_without_an_api_key() {
    let models_url =
        "https://aiplatform.googleapis.com/v1/projects/p/locations/global/publishers/google/models";
    let wire = gemini_content(
        GeminiConfig::new(""),
        "gemini-3.8-flash",
        "Be brief.",
        Some(models_url.to_string()),
    );
    let (uri, _) = encode(&wire);
    assert_eq!(
        uri,
        format!("{models_url}/gemini-3.8-flash:streamGenerateContent?alt=sse")
    );
}
