use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use convex::{ConvexClient, FunctionResult, Value};
use futures::stream;
use rig::OneOrMany;
use rig::client::{CompletionClient, ProviderClient};
use rig::completion::{
    AssistantContent, CompletionError, CompletionModel as RigCompletionModel, CompletionRequest,
    CompletionResponse, GetTokenUsage, ToolDefinition, Usage as RigUsage,
};
use rig::message::{ToolCall as RigToolCall, ToolChoice, ToolFunction};
use rig::streaming::{RawStreamingChoice, RawStreamingToolCall, StreamingCompletionResponse};
use rustls::crypto::ring::default_provider;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use tokio::time::timeout;

use crate::messages::{build_model_messages, normalize_convex_json_numbers, system_text};

const CONVEX_RPC_TIMEOUT: Duration = Duration::from_secs(20 * 60);

#[derive(Clone)]
pub struct Client {
    pub(crate) inner: Arc<Mutex<ConvexClient>>,
    completion_action: Arc<str>,
    default_reasoning_effort: Option<Arc<str>>,
    stream_run_id: Option<Arc<str>>,
    guest_id: Option<Arc<str>>,
}

impl Client {
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
            stream_run_id: None,
            guest_id: None,
        })
    }

    pub async fn set_auth_token(&self, token: Option<String>) {
        self.inner.lock().await.set_auth(token).await;
    }

    pub async fn query(
        &self,
        function: &str,
        args: BTreeMap<String, Value>,
    ) -> anyhow::Result<FunctionResult> {
        let mut convex = self.inner.lock().await;
        timeout(CONVEX_RPC_TIMEOUT, convex.query(function, args))
            .await
            .with_context(|| format!("query timed out for {function}"))?
            .map_err(Into::into)
    }

    pub async fn mutation(
        &self,
        function: &str,
        args: BTreeMap<String, Value>,
    ) -> anyhow::Result<FunctionResult> {
        let mut convex = self.inner.lock().await;
        timeout(CONVEX_RPC_TIMEOUT, convex.mutation(function, args))
            .await
            .with_context(|| format!("mutation timed out for {function}"))?
            .map_err(Into::into)
    }

    pub fn with_reasoning_effort(mut self, reasoning_effort: impl Into<String>) -> Self {
        self.default_reasoning_effort = Some(reasoning_effort.into().into());
        self
    }

    pub fn with_stream_target(
        mut self,
        stream_run_id: Option<String>,
        guest_id: Option<String>,
    ) -> Self {
        self.stream_run_id = stream_run_id.map(Into::into);
        self.guest_id = guest_id.map(Into::into);
        self
    }
}

impl ProviderClient for Client {
    type Input = ();
    type Error = anyhow::Error;

    fn from_env() -> Result<Self, Self::Error> {
        Err(anyhow::anyhow!(
            "sprocket-convex-provider::Client cannot be constructed from environment alone"
        ))
    }

    fn from_val(_input: Self::Input) -> Result<Self, Self::Error> {
        Err(anyhow::anyhow!(
            "sprocket-convex-provider::Client requires an async deployment_url initializer"
        ))
    }
}

impl CompletionClient for Client {
    type CompletionModel = CompletionModel;
}

#[derive(Clone)]
pub struct CompletionModel {
    client: Client,
    model: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CompletionOutput {
    pub text: String,
    pub usage: Usage,
    pub message_id: Option<String>,
    #[serde(default)]
    pub tool_calls: Vec<ToolCall>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    #[serde(default, deserialize_with = "deserialize_convex_u64")]
    pub input_tokens: u64,
    #[serde(default, deserialize_with = "deserialize_convex_u64")]
    pub output_tokens: u64,
    #[serde(default, deserialize_with = "deserialize_convex_u64")]
    pub total_tokens: u64,
    #[serde(default)]
    pub input_token_details: InputTokenDetails,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputTokenDetails {
    #[serde(default, deserialize_with = "deserialize_convex_u64")]
    pub cache_read_tokens: u64,
}

impl GetTokenUsage for CompletionOutput {
    fn token_usage(&self) -> Option<RigUsage> {
        Some(RigUsage {
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
    stream_run_id: Option<String>,
    tools: Vec<ToolDefinition>,
    tool_choice: Option<ConvexToolChoice>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ToolCall {
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

impl RigCompletionModel for CompletionModel {
    type Response = CompletionOutput;
    type StreamingResponse = CompletionOutput;
    type Client = Client;

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
            stream_run_id: self.client.stream_run_id.as_deref().map(str::to_owned),
            tools: request.tools.clone(),
            tool_choice: request.tool_choice.as_ref().map(convert_tool_choice),
        };

        let value = call_completion_action(&self.client, &args).await?;
        let output = parse_completion_output(value)?;
        let usage = output.token_usage().unwrap_or_else(RigUsage::new);
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
        let mut chunks: Vec<Result<RawStreamingChoice<CompletionOutput>, CompletionError>> =
            Vec::new();
        if !completion.raw_response.text.is_empty() {
            chunks.push(Ok(RawStreamingChoice::Message(
                completion.raw_response.text.clone(),
            )));
        }
        for tool_call in &completion.raw_response.tool_calls {
            chunks.push(Ok(RawStreamingChoice::ToolCall(RawStreamingToolCall::new(
                tool_call.id.clone(),
                tool_call.name.clone(),
                tool_call.arguments.clone(),
            ))));
        }
        chunks.push(Ok(RawStreamingChoice::FinalResponse(
            completion.raw_response.clone(),
        )));
        let stream = stream::iter(chunks);
        Ok(StreamingCompletionResponse::stream(Box::pin(stream)))
    }
}

async fn call_completion_action(
    client: &Client,
    args: &ConvexActionArgs,
) -> Result<Value, CompletionError> {
    let mut convex = client.inner.lock().await;
    eprintln!(
        "sprocket-convex-provider: action start {}",
        client.completion_action
    );
    let stream_run_id = args.stream_run_id.as_ref().ok_or_else(|| {
        CompletionError::ProviderError(
            "streamRunId is required for completion:complete".to_string(),
        )
    })?;
    let result = convex.action(&client.completion_action, action_args(args, stream_run_id));
    let result = timeout(CONVEX_RPC_TIMEOUT, result)
        .await
        .map_err(|error| {
            CompletionError::ProviderError(format!(
                "timed out calling {}: {error}",
                client.completion_action
            ))
        })?
        .map_err(to_completion_error)?;
    eprintln!(
        "sprocket-convex-provider: action done {}",
        client.completion_action
    );

    match result {
        FunctionResult::Value(value) => Ok(value),
        FunctionResult::ErrorMessage(message) => Err(CompletionError::ProviderError(message)),
        FunctionResult::ConvexError(error) => Err(CompletionError::ProviderError(error.message)),
    }
}

fn action_args(args: &ConvexActionArgs, stream_run_id: &str) -> BTreeMap<String, Value> {
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
    payload.insert("streamRunId".to_string(), stream_run_id.to_string().into());
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

fn parse_completion_output(value: Value) -> Result<CompletionOutput, CompletionError> {
    let json_value: serde_json::Value = value.into();
    let mut output: CompletionOutput = serde_json::from_value(json_value).map_err(|error| {
        CompletionError::ProviderError(format!("invalid Convex completion payload: {error}"))
    })?;

    for tool_call in &mut output.tool_calls {
        normalize_convex_json_numbers(&mut tool_call.arguments);
    }

    eprintln!(
        "sprocket-convex-provider: completion output text_len={} tool_calls={}",
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

fn completion_choice(output: &CompletionOutput) -> OneOrMany<AssistantContent> {
    let mut parts = Vec::new();
    if !output.text.is_empty() {
        parts.push(AssistantContent::text(output.text.clone()));
    }
    parts.extend(output.tool_calls.iter().map(|tool_call| {
        AssistantContent::ToolCall(RigToolCall::new(
            tool_call.id.clone(),
            ToolFunction::new(tool_call.name.clone(), tool_call.arguments.clone()),
        ))
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

fn to_completion_error(error: anyhow::Error) -> CompletionError {
    CompletionError::ProviderError(error.to_string())
}

fn deserialize_convex_u64<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<f64>::deserialize(deserializer)?;
    let Some(value) = value else {
        return Ok(0);
    };

    if !value.is_finite() || value < 0.0 || value.fract() != 0.0 {
        return Err(serde::de::Error::custom(format!(
            "expected a non-negative integer-compatible Convex number, got {value}"
        )));
    }

    Ok(value as u64)
}
