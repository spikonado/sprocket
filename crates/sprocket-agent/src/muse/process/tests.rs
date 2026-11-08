use serde_json::{Value, json};

use super::*;

fn feed(translator: &mut Translator, notifications: &[(&str, Value)]) -> Vec<Value> {
    notifications
        .iter()
        .flat_map(|(method, params)| translator.notification(method, params))
        .map(|event| match event {
            Event::Stream(event) => event,
            Event::TurnEnd { .. } => json!({ "type": "turn_end" }),
            Event::Exited(reason) => panic!("unexpected exit: {reason}"),
        })
        .collect()
}

fn item(method: &str, id: &str, kind: &str) -> (&'static str, Value) {
    let method = if method == "started" {
        "item/started"
    } else {
        "item/completed"
    };
    (method, json!({ "item": { "itemId": id, "kind": kind } }))
}

fn delta(id: &str, field: &str, text: &str) -> (&'static str, Value) {
    (
        "item/delta",
        json!({ "itemId": id, "field": field, "delta": text }),
    )
}

fn kinds(events: &[Value]) -> Vec<String> {
    events
        .iter()
        .map(|event| {
            let kind = event["type"].as_str().unwrap_or_default();
            match event["delta"]["type"].as_str() {
                Some(delta) if kind == "content_block_delta" => delta.to_string(),
                _ => kind.to_string(),
            }
        })
        .collect()
}

#[test]
fn a_turn_streams_signed_thinking_text_and_usage() {
    let mut translator = Translator::new("muse-wonder-full-1.0".to_string());
    let events = feed(
        &mut translator,
        &[
            item("started", "r", "reasoning"),
            delta("r", "summary.0", "Plan"),
            delta("r", "summary.1", "Check"),
            item("completed", "r", "reasoning"),
            item("started", "m", "agentMessage"),
            delta("m", "text", "Hi"),
            item("completed", "m", "agentMessage"),
            (
                "session/tokenUsage",
                json!({ "usage": { "inputTokens": 1200, "cacheReadTokens": 200, "outputTokens": 34 } }),
            ),
            ("turn/completed", json!({ "terminal": "completed" })),
        ],
    );
    assert_eq!(
        kinds(&events),
        [
            "message_start",
            "content_block_start",
            "thinking_delta",
            "thinking_delta",
            "signature_delta",
            "content_block_stop",
            "content_block_start",
            "text_delta",
            "content_block_stop",
            "message_delta",
            "message_stop",
            "turn_end",
        ]
    );
    assert_eq!(events[0]["message"]["model"], "muse-wonder-full-1.0");
    assert_eq!(events[3]["delta"]["thinking"], "\n\nCheck");
    assert_eq!(events[6]["index"], 1);
    assert_eq!(events[9]["delta"]["stop_reason"], "end_turn");
    assert_eq!(events[9]["usage"]["input_tokens"], 1000);
    assert_eq!(events[9]["usage"]["cache_read_input_tokens"], 200);
}

#[test]
fn tool_calls_end_the_step_and_the_next_step_opens_a_new_message() {
    let mut translator = Translator::new("muse-wonder-full-1.0".to_string());
    let mut events = feed(
        &mut translator,
        &[
            item("started", "m", "agentMessage"),
            delta("m", "text", "Looking."),
        ],
    );
    for event in translator
        .tool_use("toolu_1", "exec_cmd", &json!({ "cmd": "ls" }))
        .into_iter()
        .chain(translator.end_step("tool_use"))
    {
        let Event::Stream(event) = event else {
            panic!("a tool step only streams");
        };
        events.push(event);
    }
    events.extend(feed(
        &mut translator,
        &[
            (
                "item/completed",
                json!({ "item": { "itemId": "m", "kind": "agentMessage", "text": "Looking." } }),
            ),
            item("started", "n", "agentMessage"),
            delta("n", "text", "Done."),
        ],
    ));
    assert_eq!(
        kinds(&events),
        [
            "message_start",
            "content_block_start",
            "text_delta",
            "content_block_stop",
            "content_block_start",
            "input_json_delta",
            "content_block_stop",
            "message_delta",
            "message_stop",
            "message_start",
            "content_block_start",
            "text_delta",
        ]
    );
    assert_eq!(events[4]["content_block"]["id"], "toolu_1");
    assert_eq!(events[5]["delta"]["partial_json"], r#"{"cmd":"ls"}"#);
    assert_eq!(events[7]["delta"]["stop_reason"], "tool_use");
    assert_eq!(events[10]["index"], 0);
}

#[test]
fn a_failed_turn_ends_with_its_error() {
    let mut translator = Translator::new("muse-wonder-full-1.0".to_string());
    let events = translator.notification(
        "turn/completed",
        &json!({ "terminal": "failed", "error": { "message": "upstream timed out" } }),
    );
    let [Event::TurnEnd { error }] = events.as_slice() else {
        panic!("expected one turn end, got {events:?}");
    };
    assert_eq!(error["error"]["message"], "upstream timed out");
}
