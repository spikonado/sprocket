use std::collections::BTreeMap;

use rig::completion::{CompletionError, CompletionRequest, Message};
use rig::message::{AssistantContent, ToolResultContent, UserContent};

pub(crate) fn build_model_messages(
    request: &CompletionRequest,
) -> Result<serde_json::Value, CompletionError> {
    let mut messages: Vec<serde_json::Value> = Vec::new();
    let mut tool_names_by_call_id: BTreeMap<String, String> = BTreeMap::<String, String>::new();

    for message in request.chat_history.iter() {
        match message {
            Message::System { .. } => {}
            Message::User { content } => {
                let mut text_parts: Vec<String> = Vec::new();
                let mut tool_results: Vec<serde_json::Value> = Vec::new();
                for item in content.iter() {
                    match item {
                        UserContent::Text(text) => {
                            text_parts.push(text.text.clone());
                        }
                        UserContent::ToolResult(result) => {
                            let tool_call_id: &str = &result.id;
                            let output: String = result
                                .content
                                .iter()
                                .filter_map(|content| match content {
                                    ToolResultContent::Text(text) => Some(text.text.clone()),
                                    ToolResultContent::Image(_) => None,
                                })
                                .collect::<Vec<_>>()
                                .join("\n");
                            tool_results.push(serde_json::json!({
                                "type": "tool-result",
                                "toolCallId": tool_call_id,
                                "toolName": tool_names_by_call_id
                                    .get(tool_call_id)
                                    .cloned()
                                    .unwrap_or_else(|| "unknown_tool".to_string()),
                                "output": tool_result_output(&output)
                            }));
                        }
                        _ => {
                            return Err(CompletionError::ProviderError(
                                "Convex-backed Rig provider only supports text and tool results in user messages."
                                    .to_string(),
                            ));
                        }
                    }
                }

                if !text_parts.is_empty() {
                    messages.push(serde_json::json!({
                        "role": "user",
                        "content": text_parts.join("\n")
                    }));
                }
                if !tool_results.is_empty() {
                    messages.push(serde_json::json!({
                        "role": "tool",
                        "content": tool_results
                    }));
                }
            }
            Message::Assistant { content, .. } => {
                let mut parts: Vec<serde_json::Value> = Vec::new();
                for item in content.iter() {
                    match item {
                        AssistantContent::Text(text) => {
                            parts.push(serde_json::json!({
                                "type": "text",
                                "text": text.text.clone()
                            }));
                        }
                        AssistantContent::Reasoning(reasoning) => {
                            let text: String = reasoning.display_text();
                            if !text.is_empty() {
                                parts.push(serde_json::json!({
                                    "type": "text",
                                    "text": text
                                }));
                            }
                        }
                        AssistantContent::ToolCall(tool_call) => {
                            let tool_call_id: String = tool_call.id.clone();
                            tool_names_by_call_id
                                .insert(tool_call_id.clone(), tool_call.function.name.clone());
                            parts.push(serde_json::json!({
                                "type": "tool-call",
                                "toolCallId": tool_call_id,
                                "toolName": tool_call.function.name.clone(),
                                "input": tool_call.function.arguments.clone()
                            }));
                        }
                        _ => {
                            return Err(CompletionError::ProviderError(
                                "Convex-backed Rig provider only supports text and tool-call assistant content."
                                    .to_string(),
                            ));
                        }
                    }
                }
                if !parts.is_empty() {
                    messages.push(serde_json::json!({
                        "role": "assistant",
                        "content": parts
                    }));
                }
            }
        }
    }

    Ok(serde_json::Value::Array(messages))
}

fn tool_result_output(output: &str) -> serde_json::Value {
    match serde_json::from_str::<serde_json::Value>(output) {
        Ok(value) => serde_json::json!({
            "type": "json",
            "value": value
        }),
        Err(_) => serde_json::json!({
            "type": "text",
            "value": output
        }),
    }
}

pub(crate) fn normalize_convex_json_numbers(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Array(items) => {
            for item in items {
                normalize_convex_json_numbers(item);
            }
        }
        serde_json::Value::Object(map) => {
            for item in map.values_mut() {
                normalize_convex_json_numbers(item);
            }
        }
        serde_json::Value::Number(number) => {
            if let Some(float) = number.as_f64() {
                if float.is_finite() && float.fract() == 0.0 {
                    if float >= 0.0 && float <= u64::MAX as f64 {
                        *value = serde_json::Value::Number(serde_json::Number::from(float as u64));
                    } else if float >= i64::MIN as f64 && float <= i64::MAX as f64 {
                        *value = serde_json::Value::Number(serde_json::Number::from(float as i64));
                    }
                }
            }
        }
        _ => {}
    }
}

pub(crate) fn system_text(request: &CompletionRequest) -> Option<String> {
    request
        .chat_history
        .iter()
        .find_map(|message| match message {
            Message::System { content } => Some(content.clone()),
            _ => None,
        })
}

#[cfg(test)]
mod tests {
    use rig::OneOrMany;
    use rig::completion::{CompletionRequest, Message};
    use rig::message::{AssistantContent, UserContent};

    use super::{build_model_messages, normalize_convex_json_numbers, system_text};

    #[test]
    fn builds_structured_messages_and_extracts_system_prompt() {
        let messages: OneOrMany<Message> = OneOrMany::many(vec![
            Message::System {
                content: "You are precise.".to_string(),
            },
            Message::user("Inspect src/lib.rs"),
            Message::assistant("I found the relevant module."),
        ])
        .expect("messages");

        let structured: serde_json::Value = build_model_messages(&CompletionRequest {
            model: None,
            preamble: None,
            chat_history: messages.clone(),
            documents: vec![],
            tools: vec![],
            temperature: None,
            max_tokens: None,
            tool_choice: None,
            additional_params: None,
            output_schema: None,
        })
        .expect("structured");
        let array = structured.as_array().expect("array");
        assert_eq!(array.len(), 2);
        assert_eq!(array[0]["role"], "user");
        assert_eq!(array[0]["content"], "Inspect src/lib.rs");
        assert_eq!(array[1]["role"], "assistant");
        assert_eq!(array[1]["content"][0]["type"], "text");
        assert_eq!(
            array[1]["content"][0]["text"],
            "I found the relevant module."
        );
        assert_eq!(
            system_text(&CompletionRequest {
                model: None,
                preamble: None,
                chat_history: messages,
                documents: vec![],
                tools: vec![],
                temperature: None,
                max_tokens: None,
                tool_choice: None,
                additional_params: None,
                output_schema: None,
            }),
            Some("You are precise.".to_string())
        );
    }

    #[test]
    fn preserves_tool_protocol_shape_for_follow_up_turns() {
        let messages: OneOrMany<Message> = OneOrMany::many(vec![
            Message::user("Inspect src/lib.rs"),
            Message::Assistant {
                id: None,
                content: OneOrMany::many(vec![AssistantContent::tool_call(
                    "tool_call_1",
                    "exec_command",
                    serde_json::json!({
                        "cmd": "cat src/lib.rs"
                    }),
                )])
                .expect("assistant content"),
            },
            Message::User {
                content: OneOrMany::many(vec![UserContent::tool_result(
                    "tool_call_1",
                    rig::OneOrMany::one(rig::completion::message::ToolResultContent::text(
                        "{\"path\":\"src/lib.rs\",\"contents\":\"fn main() {}\"}",
                    )),
                )])
                .expect("user content"),
            },
        ])
        .expect("messages");

        let structured: serde_json::Value = build_model_messages(&CompletionRequest {
            model: None,
            preamble: None,
            chat_history: messages,
            documents: vec![],
            tools: vec![],
            temperature: None,
            max_tokens: None,
            tool_choice: None,
            additional_params: None,
            output_schema: None,
        })
        .expect("structured");

        let array: &Vec<serde_json::Value> = structured.as_array().expect("array");
        assert_eq!(array.len(), 3);
        assert_eq!(array[1]["role"], "assistant");
        assert_eq!(array[1]["content"][0]["type"], "tool-call");
        assert_eq!(array[1]["content"][0]["toolCallId"], "tool_call_1");
        assert_eq!(array[1]["content"][0]["toolName"], "exec_command");
        assert_eq!(array[1]["content"][0]["input"]["cmd"], "cat src/lib.rs");
        assert_eq!(array[2]["role"], "tool");
        assert_eq!(array[2]["content"][0]["type"], "tool-result");
        assert_eq!(array[1]["content"][0]["toolCallId"], "tool_call_1");
        assert_eq!(array[2]["content"][0]["toolName"], "exec_command");
        assert_eq!(array[2]["content"][0]["output"]["type"], "json");
        assert_eq!(
            array[2]["content"][0]["output"]["value"]["contents"],
            "fn main() {}"
        );
    }

    #[test]
    fn normalizes_integer_like_convex_numbers_in_tool_arguments() {
        let mut value = serde_json::json!({
            "path": "src/lib.rs",
            "startLine": 1.0,
            "maxLines": 50.0,
            "nested": {
                "line": 2.0
            }
        });

        normalize_convex_json_numbers(&mut value);

        assert_eq!(value["path"], "src/lib.rs");
        assert_eq!(value["startLine"], 1);
        assert_eq!(value["maxLines"], 50);
        assert_eq!(value["nested"]["line"], 2);
    }
}
