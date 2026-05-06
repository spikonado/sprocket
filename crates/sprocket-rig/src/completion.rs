use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use convex::{ConvexClient, FunctionResult, Value};
use futures::stream;
use rig::OneOrMany;
use rig::client::CompletionClient;
use rig::completion::{
    AssistantContent, CompletionError, CompletionModel, CompletionRequest, CompletionResponse,
    GetTokenUsage, Message, ToolDefinition, Usage,
};
use rig::message::{ToolCall, ToolChoice, ToolFunction};
use rig::streaming::{RawStreamingChoice, RawStreamingToolCall, StreamingCompletionResponse};
use rustls::crypto::ring::default_provider;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use tokio::time::timeout;

use crate::types::deserialize_convex_u64;

const CONVEX_RPC_TIMEOUT: Duration = Duration::from_secs(20 * 60);

#[derive(Clone)]
pub struct ConvexRigClient {
    pub(crate) inner: Arc<Mutex<ConvexClient>>,
    completion_action: Arc<str>,
    default_reasoning_effort: Option<Arc<str>>,
    stream_message_id: Option<Arc<str>>,
    guest_id: Option<Arc<str>>,
}

impl ConvexRigClient {
    pub async fn new(
        deployment_url: &str,
        completion_action: impl Into<String>,
    ) -> anyhow::Result<Self> {
        let _ = default_provider().install_default();
        let client = ConvexClient::new(deployment_url)
            .await
            .context("failed to initialize Convex client")?;
        Ok(Self {
            inner: Arc::new(Mutex::new(client)),
            completion_action: completion_action.into().into(),
            default_reasoning_effort: None,
            stream_message_id: None,
            guest_id: None,
        })
    }

    pub async fn set_auth_token(&self, token: Option<String>) {
        self.inner.lock().await.set_auth(token).await;
    }

    pub fn with_reasoning_effort(mut self, reasoning_effort: impl Into<String>) -> Self {
        self.default_reasoning_effort = Some(reasoning_effort.into().into());
        self
    }

    pub fn with_stream_target(
        mut self,
        stream_message_id: Option<String>,
        guest_id: Option<String>,
    ) -> Self {
        self.stream_message_id = stream_message_id.map(Into::into);
        self.guest_id = guest_id.map(Into::into);
        self
    }
}

impl CompletionClient for ConvexRigClient {
    type CompletionModel = ConvexCompletionModel;
}

#[derive(Clone)]
pub struct ConvexCompletionModel {
    client: ConvexRigClient,
    model: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ConvexCompletionOutput {
    pub text: String,
    pub usage: ConvexUsage,
    pub message_id: Option<String>,
    #[serde(default)]
    pub tool_calls: Vec<ConvexToolCall>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvexUsage {
    #[serde(default, deserialize_with = "deserialize_convex_u64")]
    pub input_tokens: u64,
    #[serde(default, deserialize_with = "deserialize_convex_u64")]
    pub output_tokens: u64,
    #[serde(default, deserialize_with = "deserialize_convex_u64")]
    pub total_tokens: u64,
    #[serde(default)]
    pub input_token_details: ConvexInputTokenDetails,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvexInputTokenDetails {
    #[serde(default, deserialize_with = "deserialize_convex_u64")]
    pub cache_read_tokens: u64,
}

impl GetTokenUsage for ConvexCompletionOutput {
    fn token_usage(&self) -> Option<Usage> {
        Some(Usage {
            input_tokens: self.usage.input_tokens,
            output_tokens: self.usage.output_tokens,
            total_tokens: self.usage.total_tokens,
            cached_input_tokens: self.usage.input_token_details.cache_read_tokens,
            cache_creation_input_tokens: 0,
        })
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct ConvexActionArgs {
    model_id: String,
    reasoning_effort: Option<String>,
    system: Option<String>,
    prompt: Option<String>,
    messages_json: String,
    guest_id: Option<String>,
    stream_message_id: Option<String>,
    tools: Vec<ToolDefinition>,
    tool_choice: Option<ConvexToolChoice>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ConvexToolCall {
    pub id: String,
    pub name: String,
    pub arguments: serde_json::Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum ConvexToolChoice {
    Auto,
    None,
    Required,
    Tool { tool_name: String },
}

impl CompletionModel for ConvexCompletionModel {
    type Response = ConvexCompletionOutput;
    type StreamingResponse = ConvexCompletionOutput;
    type Client = ConvexRigClient;

    fn make(client: &Self::Client, model: impl Into<String>) -> Self {
        Self {
            client: client.clone(),
            model: model.into(),
        }
    }

    async fn completion(
        &self,
        request: CompletionRequest,
    ) -> Result<CompletionResponse<Self::Response>, CompletionError> {
        let system = system_text(&request);
        let messages = build_model_messages(&request)?;
        let args = ConvexActionArgs {
            model_id: self.model.clone(),
            reasoning_effort: self
                .client
                .default_reasoning_effort
                .as_deref()
                .map(str::to_owned),
            system,
            prompt: None,
            messages_json: messages.to_string(),
            guest_id: self.client.guest_id.as_deref().map(str::to_owned),
            stream_message_id: self.client.stream_message_id.as_deref().map(str::to_owned),
            tools: request.tools.clone(),
            tool_choice: request.tool_choice.as_ref().map(convert_tool_choice),
        };

        let value = call_completion_action(&self.client, &args).await?;
        let output = parse_completion_output(value)?;
        let usage = output.token_usage().unwrap_or_else(Usage::new);
        let choice = completion_choice(&output);

        Ok(CompletionResponse {
            choice,
            usage,
            raw_response: output.clone(),
            message_id: output.message_id.clone(),
        })
    }

    async fn stream(
        &self,
        request: CompletionRequest,
    ) -> Result<StreamingCompletionResponse<Self::StreamingResponse>, CompletionError> {
        let completion = self.completion(request).await?;
        let mut chunks: Vec<Result<RawStreamingChoice<ConvexCompletionOutput>, CompletionError>> =
            Vec::new();
        if !completion.raw_response.text.is_empty() {
            chunks.push(Ok(RawStreamingChoice::Message(
                completion.raw_response.text.clone(),
            )));
        }
        for tool_call in &completion.raw_response.tool_calls {
            chunks.push(Ok(RawStreamingChoice::ToolCall(
                RawStreamingToolCall::new(
                    tool_call.id.clone(),
                    tool_call.name.clone(),
                    tool_call.arguments.clone(),
                )
                .with_call_id(tool_call.id.clone()),
            )));
        }
        chunks.push(Ok(RawStreamingChoice::FinalResponse(
            completion.raw_response.clone(),
        )));
        let stream = stream::iter(chunks);
        Ok(StreamingCompletionResponse::stream(Box::pin(stream)))
    }
}

async fn call_completion_action(
    client: &ConvexRigClient,
    args: &ConvexActionArgs,
) -> Result<Value, CompletionError> {
    let mut convex = client.inner.lock().await;
    eprintln!("sprocket-rig: action start {}", client.completion_action);
    let result = convex.action(&client.completion_action, action_args(args));
    let result = timeout(CONVEX_RPC_TIMEOUT, result)
        .await
        .map_err(|error| {
            CompletionError::ProviderError(format!(
                "timed out calling {}: {error}",
                client.completion_action
            ))
        })?
        .map_err(to_completion_error)?;
    eprintln!("sprocket-rig: action done {}", client.completion_action);

    match result {
        FunctionResult::Value(value) => Ok(value),
        FunctionResult::ErrorMessage(message) => Err(CompletionError::ProviderError(message)),
        FunctionResult::ConvexError(error) => Err(CompletionError::ProviderError(error.message)),
    }
}

fn action_args(args: &ConvexActionArgs) -> BTreeMap<String, Value> {
    let mut payload = BTreeMap::new();
    payload.insert("modelId".to_string(), args.model_id.clone().into());
    if let Some(prompt) = &args.prompt {
        payload.insert("prompt".to_string(), prompt.clone().into());
    }
    payload.insert(
        "messagesJson".to_string(),
        args.messages_json.clone().into(),
    );
    if let Some(guest_id) = &args.guest_id {
        payload.insert("guestId".to_string(), guest_id.clone().into());
    }
    if let Some(stream_message_id) = &args.stream_message_id {
        payload.insert(
            "streamMessageId".to_string(),
            stream_message_id.clone().into(),
        );
    }
    if let Some(system) = &args.system {
        payload.insert("system".to_string(), system.clone().into());
    }
    if let Some(reasoning_effort) = &args.reasoning_effort {
        payload.insert(
            "reasoningEffort".to_string(),
            reasoning_effort.clone().into(),
        );
    }
    if !args.tools.is_empty() {
        payload.insert(
            "tools".to_string(),
            Value::try_from(serde_json::Value::Array(
                args.tools
                    .iter()
                    .map(|tool| {
                        serde_json::json!({
                            "name": tool.name,
                            "description": tool.description,
                            "parametersJson": tool.parameters.to_string(),
                        })
                    })
                    .collect(),
            ))
            .unwrap_or_else(|_| Value::Array(Vec::new())),
        );
    }
    if let Some(tool_choice) = &args.tool_choice {
        payload.insert(
            "toolChoiceJson".to_string(),
            serde_json::to_value(tool_choice)
                .map(|value| value.to_string().into())
                .unwrap_or(Value::Null),
        );
    }
    payload
}

fn parse_completion_output(value: Value) -> Result<ConvexCompletionOutput, CompletionError> {
    let json_value: serde_json::Value = value.into();
    let mut output: ConvexCompletionOutput =
        serde_json::from_value(json_value).map_err(|error| {
            CompletionError::ProviderError(format!("invalid Convex completion payload: {error}"))
        })?;

    for tool_call in &mut output.tool_calls {
        normalize_convex_json_numbers(&mut tool_call.arguments);
    }

    eprintln!(
        "sprocket-rig: completion output text_len={} tool_calls={}",
        output.text.len(),
        output
            .tool_calls
            .iter()
            .map(|tool_call| format!(
                "{}#{} {}",
                tool_call.name, tool_call.id, tool_call.arguments
            ))
            .collect::<Vec<_>>()
            .join(", ")
    );

    Ok(output)
}

fn completion_choice(output: &ConvexCompletionOutput) -> OneOrMany<AssistantContent> {
    let mut parts = Vec::new();
    if !output.text.is_empty() {
        parts.push(AssistantContent::text(output.text.clone()));
    }
    parts.extend(output.tool_calls.iter().map(|tool_call| {
        AssistantContent::ToolCall(
            ToolCall::new(
                tool_call.id.clone(),
                ToolFunction::new(tool_call.name.clone(), tool_call.arguments.clone()),
            )
            .with_call_id(tool_call.id.clone()),
        )
    }));

    OneOrMany::many(parts).unwrap_or_else(|_| OneOrMany::one(AssistantContent::text(String::new())))
}

fn convert_tool_choice(choice: &ToolChoice) -> ConvexToolChoice {
    match choice {
        ToolChoice::Auto => ConvexToolChoice::Auto,
        ToolChoice::None => ConvexToolChoice::None,
        ToolChoice::Required => ConvexToolChoice::Required,
        ToolChoice::Specific { function_names } => ConvexToolChoice::Tool {
            tool_name: function_names.first().cloned().unwrap_or_default(),
        },
    }
}

pub(crate) fn build_model_messages(
    request: &CompletionRequest,
) -> Result<serde_json::Value, CompletionError> {
    let mut messages = Vec::new();
    let mut tool_names_by_call_id = BTreeMap::<String, String>::new();

    if !request.documents.is_empty() {
        messages.push(serde_json::json!({
            "role": "user",
            "content": request
                .documents
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join("\n\n")
        }));
    }

    for message in request.chat_history.iter() {
        match message {
            Message::System { .. } => {}
            Message::User { content } => {
                let mut text_parts = Vec::new();
                let mut tool_results = Vec::new();
                for item in content.iter() {
                    match item {
                        rig::completion::message::UserContent::Text(text) => {
                            text_parts.push(text.text.clone());
                        }
                        rig::completion::message::UserContent::Document(document) => {
                            text_parts.push(document.data.to_string());
                        }
                        rig::completion::message::UserContent::ToolResult(result) => {
                            let tool_call_id =
                                require_tool_call_id(result.call_id.as_deref(), "tool result")?;
                            let output = result
                                .content
                                .iter()
                                .filter_map(|content| match content {
                                    rig::completion::message::ToolResultContent::Text(text) => {
                                        Some(text.text.clone())
                                    }
                                    rig::completion::message::ToolResultContent::Image(_) => None,
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
                                "Convex-backed Rig provider only supports text, documents, and tool results in user messages."
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
                let mut parts = Vec::new();
                for item in content.iter() {
                    match item {
                        rig::completion::message::AssistantContent::Text(text) => {
                            parts.push(serde_json::json!({
                                "type": "text",
                                "text": text.text.clone()
                            }));
                        }
                        rig::completion::message::AssistantContent::Reasoning(reasoning) => {
                            let text = reasoning.display_text();
                            if !text.is_empty() {
                                parts.push(serde_json::json!({
                                    "type": "text",
                                    "text": text
                                }));
                            }
                        }
                        rig::completion::message::AssistantContent::ToolCall(tool_call) => {
                            let tool_call_id =
                                require_tool_call_id(tool_call.call_id.as_deref(), "tool call")?
                                    .to_string();
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

fn require_tool_call_id<'a>(
    call_id: Option<&'a str>,
    what: &str,
) -> Result<&'a str, CompletionError> {
    call_id.ok_or_else(|| {
        CompletionError::ProviderError(format!("{what} is missing call_id in agent history"))
    })
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
    if let Some(preamble) = &request.preamble {
        return Some(preamble.clone());
    }

    request
        .chat_history
        .iter()
        .find_map(|message| match message {
            Message::System { content } => Some(content.clone()),
            _ => None,
        })
}

pub(crate) fn to_completion_error(error: anyhow::Error) -> CompletionError {
    CompletionError::ProviderError(error.to_string())
}

#[cfg(test)]
mod tests {
    use rig::OneOrMany;
    use rig::completion::{
        Message,
        message::{AssistantContent, UserContent},
    };

    use super::{build_model_messages, normalize_convex_json_numbers, system_text};

    #[test]
    fn builds_structured_messages_and_extracts_system_prompt() {
        let messages = OneOrMany::many(vec![
            Message::System {
                content: "You are precise.".to_string(),
            },
            Message::user("Inspect src/lib.rs"),
            Message::assistant("I found the relevant module."),
        ])
        .expect("messages");

        let structured = build_model_messages(&rig::completion::CompletionRequest {
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
            system_text(&rig::completion::CompletionRequest {
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
        let messages = OneOrMany::many(vec![
            Message::user("Inspect src/lib.rs"),
            Message::Assistant {
                id: None,
                content: OneOrMany::many(vec![AssistantContent::tool_call_with_call_id(
                    "tool_call_1",
                    "call_1".to_string(),
                    "read_file",
                    serde_json::json!({
                        "path": "src/lib.rs",
                        "startLine": 1,
                        "maxLines": 50
                    }),
                )])
                .expect("assistant content"),
            },
            Message::User {
                content: OneOrMany::many(vec![UserContent::tool_result_with_call_id(
                    "tool_call_1",
                    "call_1".to_string(),
                    rig::OneOrMany::one(rig::completion::message::ToolResultContent::text(
                        "{\"path\":\"src/lib.rs\",\"contents\":\"fn main() {}\"}",
                    )),
                )])
                .expect("user content"),
            },
        ])
        .expect("messages");

        let structured = build_model_messages(&rig::completion::CompletionRequest {
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

        let array = structured.as_array().expect("array");
        assert_eq!(array.len(), 3);
        assert_eq!(array[1]["role"], "assistant");
        assert_eq!(array[1]["content"][0]["type"], "tool-call");
        assert_eq!(array[1]["content"][0]["toolCallId"], "call_1");
        assert_eq!(array[1]["content"][0]["toolName"], "read_file");
        assert_eq!(array[1]["content"][0]["input"]["path"], "src/lib.rs");
        assert_eq!(array[2]["role"], "tool");
        assert_eq!(array[2]["content"][0]["type"], "tool-result");
        assert_eq!(array[2]["content"][0]["toolCallId"], "call_1");
        assert_eq!(array[2]["content"][0]["toolName"], "read_file");
        assert_eq!(array[2]["content"][0]["output"]["type"], "json");
        assert_eq!(
            array[2]["content"][0]["output"]["value"]["path"],
            "src/lib.rs"
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
