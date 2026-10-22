use rig::agent::CompletionCallEvent;
use rig::completion::{Message, Usage};
use serde_json::json;

use super::{
    GenerationCall, MAX_CONTENT_BYTES, analytics_id, bounded, generation_properties, input_delta,
};
use crate::types::CompletionProvider;

#[test]
fn input_delta_sends_new_messages_without_the_previous_output() {
    let first_prompt = Message::user("list the files");
    let earlier = vec![
        Message::user("earlier"),
        Message::assistant("earlier reply"),
    ];
    let first = CompletionCallEvent {
        prompt: &first_prompt,
        history: &earlier,
        turn: 1,
    };
    assert_eq!(input_delta(first, 0), json!([first_prompt]));

    let tool_result = Message::user("README.md");
    let mut history = earlier.clone();
    history.extend([first_prompt.clone(), Message::assistant("calling ls")]);
    let second = CompletionCallEvent {
        prompt: &tool_result,
        history: &history,
        turn: 2,
    };
    assert_eq!(input_delta(second, earlier.len() + 1), json!([tool_result]));
}

#[test]
fn bounded_replaces_oversized_content() {
    let small = json!(["hello"]);
    assert_eq!(bounded(small.clone()), small);

    let large = json!(["x".repeat(MAX_CONTENT_BYTES)]);
    let size = large.to_string().len();
    assert_eq!(bounded(large), json!(format!("[{size} bytes omitted]")));
}

#[test]
fn generation_properties_describe_the_call() {
    let mut usage = Usage::default();
    usage.input_tokens = Some(120);
    usage.output_tokens = Some(30);
    let call = GenerationCall {
        turn: 1,
        provider: CompletionProvider::Spikonado,
        model: "gpt-5",
        usage,
        finish_reason: None,
        context_handoff: true,
        provider_fallback: false,
    };

    let properties = generation_properties("run-1", "thread-1", &call, None);

    assert_eq!(properties["$ai_provider"], "spikonado");
    assert_eq!(properties["$ai_input_tokens"], 120);
    assert_eq!(properties["$ai_output_tokens"], 30);
    assert_eq!(properties["$ai_span_name"], "context_handoff");
    assert!(!properties.contains_key("$ai_cache_read_input_tokens"));
    assert!(!properties.contains_key("$ai_input"));
}

#[test]
fn analytics_id_matches_convex() {
    assert_eq!(
        analytics_id("thread-1"),
        "4b0a5fefc328e6b9257bc535e3c5d26fec36b52f92e277618bf5b30fc3885e58"
    );
}
