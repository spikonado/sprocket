use std::collections::BTreeMap;

use rig::completion::{CompletionError, CompletionRequest, Message};
use rig::message::{
    AssistantContent, DocumentSourceKind, Image, MimeType, ReasoningContent, ToolResultContent,
    UserContent,
};

pub(crate) fn build_model_messages(
    request: &CompletionRequest,
) -> Result<serde_json::Value, CompletionError> {
    completion_messages_json(request.chat_history.iter())
}

/// Serializes Rig messages into the AI SDK model-message JSON accepted by the
/// Convex completion actions.
pub fn completion_messages_json<'a>(
    history: impl IntoIterator<Item = &'a Message>,
) -> Result<serde_json::Value, CompletionError> {
    let mut messages: Vec<serde_json::Value> = Vec::new();
    let mut tool_names_by_call_id: BTreeMap<String, String> = BTreeMap::new();

    for message in history {
        match message {
            Message::System { .. } => {}
            Message::User { content } => {
                let mut user_parts: Vec<serde_json::Value> = Vec::new();
                let mut tool_results: Vec<serde_json::Value> = Vec::new();
                for item in content.iter() {
                    match item {
                        UserContent::Text(text) => {
                            user_parts.push(serde_json::json!({
                                "type": "text",
                                "text": text.text.clone()
                            }));
                        }
                        UserContent::Image(image) => {
                            user_parts.push(serde_json::json!({
                                "type": "image",
                                "image": image_url(image)?
                            }));
                        }
                        UserContent::ToolResult(result) => {
                            let tool_call_id: &str = result.wire_call_id();
                            let output: String = result
                                .content
                                .iter()
                                .filter_map(|content| match content {
                                    ToolResultContent::Text(text) => Some(text.text.clone()),
                                    ToolResultContent::Json { value } => Some(value.to_string()),
                                    ToolResultContent::Image(_) => None,
                                })
                                .collect::<Vec<_>>()
                                .join("\n");
                            tool_results.push(serde_json::json!({
                                "type": "tool-result",
                                "toolCallId": tool_call_id,
                                "toolName": tool_result_name(&tool_names_by_call_id, result),
                                "output": tool_result_output(&output)
                            }));
                        }
                        _ => {
                            return Err(CompletionError::ProviderError(
                                "Convex-backed Rig provider only supports text, images, and tool results in user messages."
                                    .to_string(),
                            ));
                        }
                    }
                }

                if !user_parts.is_empty() {
                    messages.push(serde_json::json!({
                        "role": "user",
                        "content": user_parts
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
                            let mut part = serde_json::json!({
                                "type": "text",
                                "text": text.text.clone()
                            });
                            if let Some(provider_options) = &text.additional_params {
                                part["providerOptions"] = provider_options.clone().into_value();
                            }
                            parts.push(part);
                        }
                        AssistantContent::Reasoning(reasoning) => {
                            let encrypted = reasoning.content.iter().find_map(|content| {
                                if let ReasoningContent::Encrypted(value) = content {
                                    Some(value.clone())
                                } else {
                                    None
                                }
                            });
                            let mut openai = serde_json::Map::new();
                            if let Some(id) = &reasoning.id {
                                openai.insert("itemId".to_string(), id.clone().into());
                            }
                            if let Some(encrypted) = encrypted {
                                openai.insert(
                                    "reasoningEncryptedContent".to_string(),
                                    encrypted.into(),
                                );
                            }
                            let text = reasoning.display_text();
                            if !text.is_empty() || !openai.is_empty() {
                                let mut part = serde_json::json!({
                                    "type": "reasoning",
                                    "text": text
                                });
                                if !openai.is_empty() {
                                    part["providerOptions"] =
                                        serde_json::json!({ "openai": openai });
                                }
                                parts.push(part);
                            }
                        }
                        AssistantContent::ToolCall(tool_call) => {
                            let tool_call_id = tool_call.wire_call_id().to_string();
                            tool_names_by_call_id
                                .insert(tool_call_id.clone(), tool_call.function.name.clone());
                            let mut part = serde_json::json!({
                                "type": "tool-call",
                                "toolCallId": tool_call_id,
                                "toolName": tool_call.function.name.clone(),
                                "input": tool_call.function.arguments.clone()
                            });
                            if let Some(provider_options) = &tool_call.additional_params {
                                part["providerOptions"] = provider_options.clone();
                            }
                            parts.push(part);
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

fn tool_result_name<'a>(
    tool_names_by_call_id: &'a BTreeMap<String, String>,
    result: &'a rig::message::ToolResult,
) -> &'a str {
    // The call-id map wins so a result's name always matches the name its
    // tool call is replayed with — Convex history restores results with an
    // empty name, and a repaired call keeps its originally persisted name.
    tool_names_by_call_id
        .get(result.wire_call_id())
        .filter(|name| !name.is_empty())
        .map_or_else(
            || (!result.name.is_empty()).then_some(result.name.as_str()),
            |name| Some(name.as_str()),
        )
        .unwrap_or("unknown_tool")
}

fn image_url(image: &Image) -> Result<String, CompletionError> {
    match &image.data {
        DocumentSourceKind::Url(url) => Ok(url.clone()),
        DocumentSourceKind::Base64(data) => {
            let Some(media_type) = &image.media_type else {
                return Err(CompletionError::ProviderError(
                    "A media type is required to create a valid base64-encoded image URL"
                        .to_string(),
                ));
            };
            Ok(format!("data:{};base64,{data}", media_type.to_mime_type()))
        }
        other => Err(CompletionError::ProviderError(format!(
            "Convex-backed Rig provider only supports URL or base64 images, got {other:?}"
        ))),
    }
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

pub(crate) fn instructions_text(request: &CompletionRequest) -> Option<String> {
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
    use rig::completion::{CompletionRequest, Message};
    use rig::message::{AdditionalParams, AssistantContent, ImageMediaType, Text, UserContent};

    use super::{build_model_messages, instructions_text, normalize_convex_json_numbers};

    fn completion_request(chat_history: Vec<Message>) -> CompletionRequest {
        CompletionRequest {
            model: None,
            preamble: None,
            chat_history,
            documents: vec![],
            tools: vec![],
            temperature: None,
            max_tokens: None,
            tool_choice: None,
            additional_params: None,
            output_schema: None,
            record_telemetry_content: false,
        }
    }

    #[test]
    fn builds_structured_messages_and_extracts_instructions() {
        let messages = vec![
            Message::System {
                content: "You are precise.".to_string(),
            },
            Message::user("Inspect src/lib.rs"),
            Message::assistant("I found the relevant module."),
        ];

        let structured: serde_json::Value =
            build_model_messages(&completion_request(messages.clone())).expect("structured");
        let array = structured.as_array().expect("array");
        assert_eq!(array.len(), 2);
        assert_eq!(array[0]["role"], "user");
        assert_eq!(array[0]["content"][0]["type"], "text");
        assert_eq!(array[0]["content"][0]["text"], "Inspect src/lib.rs");
        assert_eq!(array[1]["role"], "assistant");
        assert_eq!(array[1]["content"][0]["type"], "text");
        assert_eq!(
            array[1]["content"][0]["text"],
            "I found the relevant module."
        );
        assert_eq!(
            instructions_text(&completion_request(messages)),
            Some("You are precise.".to_string())
        );
    }

    #[test]
    fn preserves_images_in_user_messages() {
        let messages = vec![Message::User {
            content: vec![
                UserContent::text("Describe this image"),
                UserContent::image_url(
                    "https://example.com/robot.png",
                    Some(ImageMediaType::PNG),
                    None,
                ),
            ],
        }];

        let structured = build_model_messages(&completion_request(messages)).expect("structured");

        assert_eq!(structured[0]["content"][0]["type"], "text");
        assert_eq!(structured[0]["content"][1]["type"], "image");
        assert_eq!(
            structured[0]["content"][1]["image"],
            "https://example.com/robot.png"
        );
    }

    #[test]
    fn preserves_tool_protocol_shape_for_follow_up_turns() {
        let messages = vec![
            Message::user("Inspect src/lib.rs"),
            Message::Assistant {
                id: None,
                content: vec![AssistantContent::tool_call(
                    "tool_call_1",
                    "exec_command",
                    serde_json::json!({
                        "cmd": "cat src/lib.rs"
                    }),
                )],
            },
            Message::User {
                content: vec![UserContent::tool_result(
                    "tool_call_1",
                    "exec_command",
                    vec![rig::completion::message::ToolResultContent::text(
                        "{\"path\":\"src/lib.rs\",\"contents\":\"fn main() {}\"}",
                    )],
                )],
            },
        ];

        let structured: serde_json::Value =
            build_model_messages(&completion_request(messages)).expect("structured");

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
    fn preserves_assistant_text_provider_options() {
        let messages = vec![Message::Assistant {
            id: None,
            content: vec![AssistantContent::Text(Text {
                text: "Grounded answer".to_string(),
                additional_params: AdditionalParams::from_entries([(
                    "openai",
                    serde_json::json!({ "itemId": "msg_123" }),
                )]),
            })],
        }];

        let structured = build_model_messages(&completion_request(messages)).expect("structured");

        assert_eq!(
            structured[0]["content"][0]["providerOptions"],
            serde_json::json!({ "openai": { "itemId": "msg_123" } })
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
