use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use anyhow::Context;
use convex::{AuthenticationToken, ConvexClient, FunctionResult, QuerySubscription, Value};
use futures::stream;
use rig::OneOrMany;
use rig::client::{CompletionClient, ProviderClient};
use rig::completion::{
    AssistantContent, CompletionError, CompletionModel as RigCompletionModel, CompletionRequest,
    CompletionResponse, GetTokenUsage, ToolDefinition, Usage as RigUsage,
};
use rig::message::{ReasoningContent, ToolCall as RigToolCall, ToolChoice, ToolFunction};
use rig::streaming::{RawStreamingChoice, RawStreamingToolCall, StreamingCompletionResponse};
use rustls::crypto::ring::default_provider;
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, Notify};
use tokio::time::{sleep, timeout};

use crate::messages::{build_model_messages, instructions_text, normalize_convex_json_numbers};

const CONVEX_RPC_TIMEOUT: Duration = Duration::from_secs(20 * 60);
const COMPLETION_TRANSPORT_ATTEMPTS: u32 = 3;
const COMPLETION_TRANSPORT_RETRY_DELAY: Duration = Duration::from_millis(400);
const AUTH_REFRESH_CORRELATION_GRACE: Duration = Duration::from_millis(500);

pub const COMPLETION_STREAM_SUPERSEDED: &str = "SPROCKET_COMPLETION_STREAM_SUPERSEDED";

pub type AuthTokenFetcher =
    Arc<dyn Fn(bool) -> Pin<Box<dyn Future<Output = anyhow::Result<String>> + Send>> + Send + Sync>;

pub fn is_completion_stream_superseded(error: &(impl std::fmt::Display + ?Sized)) -> bool {
    error.to_string().contains(COMPLETION_STREAM_SUPERSEDED)
}

#[derive(Clone)]
pub struct Client {
    pub(crate) inner: Arc<Mutex<ConvexClient>>,
    auth_refresh_generation: Arc<AtomicU32>,
    auth_refresh_notify: Arc<Notify>,
    active_completion_actions: Arc<AtomicU32>,
    completion_overlap_generation: Arc<AtomicU32>,
    completion_action: Arc<str>,
    default_reasoning_effort: Option<Arc<str>>,
    default_service_tier: Option<Arc<str>>,
    stream_run_id: Option<Arc<str>>,
    claim_id: Option<Arc<str>>,
    attempt_counter: Arc<AtomicU32>,
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
            auth_refresh_generation: Arc::new(AtomicU32::new(0)),
            auth_refresh_notify: Arc::new(Notify::new()),
            active_completion_actions: Arc::new(AtomicU32::new(0)),
            completion_overlap_generation: Arc::new(AtomicU32::new(0)),
            completion_action: completion_action.into().into(),
            default_reasoning_effort: None,
            default_service_tier: None,
            stream_run_id: None,
            claim_id: None,
            attempt_counter: Arc::new(AtomicU32::new(0)),
        })
    }

    pub async fn set_auth_token_fetcher(&self, fetcher: AuthTokenFetcher) {
        let auth_refresh_generation = self.auth_refresh_generation.clone();
        let auth_refresh_notify = self.auth_refresh_notify.clone();
        let convex_fetcher: convex::AuthTokenFetcher = Box::new(move |force_refresh| {
            let fetcher = fetcher.clone();
            if force_refresh {
                auth_refresh_generation.fetch_add(1, Ordering::Release);
                auth_refresh_notify.notify_waiters();
            }
            Box::pin(async move { fetcher(force_refresh).await.map(AuthenticationToken::User) })
        });
        self.inner
            .lock()
            .await
            .set_auth_callback(Some(convex_fetcher))
            .await;
    }

    pub async fn query(
        &self,
        function: &str,
        args: BTreeMap<String, Value>,
    ) -> anyhow::Result<FunctionResult> {
        let mut convex = clone_locked(&self.inner).await;
        timeout(CONVEX_RPC_TIMEOUT, convex.query(function, args))
            .await
            .with_context(|| format!("query timed out for {function}"))?
            .map_err(Into::into)
    }

    pub async fn subscribe(
        &self,
        function: &str,
        args: BTreeMap<String, Value>,
    ) -> anyhow::Result<QuerySubscription> {
        let mut convex = clone_locked(&self.inner).await;
        timeout(CONVEX_RPC_TIMEOUT, convex.subscribe(function, args))
            .await
            .with_context(|| format!("subscription timed out for {function}"))?
            .map_err(Into::into)
    }

    pub async fn mutation(
        &self,
        function: &str,
        args: BTreeMap<String, Value>,
    ) -> anyhow::Result<FunctionResult> {
        let mut convex = clone_locked(&self.inner).await;
        timeout(CONVEX_RPC_TIMEOUT, convex.mutation(function, args))
            .await
            .with_context(|| format!("mutation timed out for {function}"))?
            .map_err(Into::into)
    }

    pub async fn action(
        &self,
        function: &str,
        args: BTreeMap<String, Value>,
    ) -> anyhow::Result<FunctionResult> {
        let mut convex = clone_locked(&self.inner).await;
        timeout(CONVEX_RPC_TIMEOUT, convex.action(function, args))
            .await
            .with_context(|| format!("action timed out for {function}"))?
            .map_err(Into::into)
    }

    pub fn with_reasoning_effort(mut self, reasoning_effort: impl Into<String>) -> Self {
        self.default_reasoning_effort = Some(reasoning_effort.into().into());
        self
    }

    pub fn with_service_tier(mut self, service_tier: impl Into<String>) -> Self {
        self.default_service_tier = Some(service_tier.into().into());
        self
    }

    pub fn with_completion_scope(mut self, stream_run_id: String, claim_id: String) -> Self {
        self.stream_run_id = Some(stream_run_id.into());
        self.claim_id = Some(claim_id.into());
        self.attempt_counter = Arc::new(AtomicU32::new(0));
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
    #[serde(default)]
    pub stream_events: Vec<CompletionStreamEvent>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CompletionStreamEvent {
    Text {
        id: String,
        text: String,
        #[serde(default)]
        turn_id: Option<String>,
        #[serde(default)]
        provider_metadata: Option<serde_json::Value>,
    },
    Reasoning {
        id: String,
        text: String,
        #[serde(default)]
        provider_reasoning_id: Option<String>,
        #[serde(default)]
        provider_metadata: Option<serde_json::Value>,
    },
    ToolCall {
        part_id: String,
        call_id: String,
        name: String,
        input: serde_json::Value,
        #[serde(default)]
        provider_metadata: Option<serde_json::Value>,
    },
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
    #[serde(default)]
    pub output_token_details: OutputTokenDetails,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputTokenDetails {
    #[serde(default, deserialize_with = "deserialize_convex_u64")]
    pub cache_read_tokens: u64,
    #[serde(default, deserialize_with = "deserialize_convex_u64")]
    pub cache_write_tokens: u64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputTokenDetails {
    #[serde(default, deserialize_with = "deserialize_convex_u64")]
    pub reasoning_tokens: u64,
}

impl GetTokenUsage for CompletionOutput {
    fn token_usage(&self) -> RigUsage {
        RigUsage {
            input_tokens: self.usage.input_tokens,
            output_tokens: self.usage.output_tokens,
            total_tokens: self.usage.total_tokens,
            cached_input_tokens: self.usage.input_token_details.cache_read_tokens,
            cache_creation_input_tokens: self.usage.input_token_details.cache_write_tokens,
            tool_use_prompt_tokens: 0,
            reasoning_tokens: self.usage.output_token_details.reasoning_tokens,
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct ConvexActionArgs {
    model_id: String,
    reasoning_effort: Option<String>,
    service_tier: Option<String>,
    instructions: Option<String>,
    prompt: Option<String>,
    messages_json: String,
    stream_run_id: Option<String>,
    claim_id: Option<String>,
    tools: Vec<ToolDefinition>,
    tool_choice: Option<ConvexToolChoice>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: serde_json::Value,
    #[serde(default)]
    pub provider_metadata: Option<serde_json::Value>,
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
        let instructions = instructions_text(&request);
        let messages = build_model_messages(&request)?;
        let args = ConvexActionArgs {
            model_id: self.model.clone(),
            reasoning_effort: self
                .client
                .default_reasoning_effort
                .as_deref()
                .map(str::to_owned),
            service_tier: self
                .client
                .default_service_tier
                .as_deref()
                .map(str::to_owned),
            instructions,
            prompt: None,
            messages_json: messages.to_string(),
            stream_run_id: self.client.stream_run_id.as_deref().map(str::to_owned),
            claim_id: self.client.claim_id.as_deref().map(str::to_owned),
            tools: request.tools.clone(),
            tool_choice: request.tool_choice.as_ref().map(convert_tool_choice),
        };

        let value = call_completion_action(&self.client, &args).await?;
        let output = parse_completion_output(value)?;
        let usage = output.token_usage();
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
        if completion.raw_response.stream_events.is_empty() {
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
                    .with_call_id(tool_call.id.clone())
                    .with_additional_params(tool_call.provider_metadata.clone()),
                )));
            }
        } else {
            for event in &completion.raw_response.stream_events {
                match event {
                    CompletionStreamEvent::Text {
                        text,
                        provider_metadata,
                        ..
                    } => chunks.extend(
                        text_stream_choices(text, provider_metadata)
                            .into_iter()
                            .map(Ok),
                    ),
                    CompletionStreamEvent::Reasoning {
                        text,
                        provider_reasoning_id,
                        provider_metadata,
                        ..
                    } => chunks.extend(
                        reasoning_stream_choices(
                            text,
                            provider_reasoning_id.as_deref(),
                            provider_metadata,
                        )
                        .into_iter()
                        .map(Ok),
                    ),
                    CompletionStreamEvent::ToolCall {
                        call_id,
                        name,
                        input,
                        provider_metadata,
                        ..
                    } => chunks.push(Ok(RawStreamingChoice::ToolCall(
                        RawStreamingToolCall::new(call_id.clone(), name.clone(), input.clone())
                            .with_call_id(call_id.clone())
                            .with_additional_params(provider_metadata.clone()),
                    ))),
                }
            }
        }
        chunks.push(Ok(RawStreamingChoice::FinalResponse(
            completion.raw_response.clone(),
        )));
        let stream = stream::iter(chunks);
        Ok(StreamingCompletionResponse::stream(Box::pin(stream)))
    }
}

fn text_stream_choices(
    text: &str,
    provider_metadata: &Option<serde_json::Value>,
) -> [RawStreamingChoice<CompletionOutput>; 2] {
    [
        RawStreamingChoice::TextStart {
            additional_params: provider_metadata.clone(),
        },
        RawStreamingChoice::Message(text.to_owned()),
    ]
}

fn reasoning_stream_choices(
    text: &str,
    provider_reasoning_id: Option<&str>,
    provider_metadata: &Option<serde_json::Value>,
) -> Vec<RawStreamingChoice<CompletionOutput>> {
    let id = provider_reasoning_id.map(str::to_owned).or_else(|| {
        provider_metadata
            .as_ref()
            .and_then(|metadata| metadata.pointer("/openai/itemId"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
    });
    let encrypted = provider_metadata
        .as_ref()
        .and_then(|metadata| metadata.pointer("/openai/reasoningEncryptedContent"))
        .and_then(serde_json::Value::as_str);
    let mut choices = Vec::new();

    // ID-only stored reasoning still needs a chunk so Rig retains its replay reference.
    if !text.is_empty() || (id.is_some() && encrypted.is_none()) {
        choices.push(RawStreamingChoice::Reasoning {
            id: id.clone(),
            content: ReasoningContent::Text {
                text: text.to_owned(),
                signature: None,
            },
        });
    }
    if let Some(encrypted) = encrypted {
        choices.push(RawStreamingChoice::Reasoning {
            id,
            content: ReasoningContent::Encrypted(encrypted.to_owned()),
        });
    }

    choices
}

/// Clone `T` under a brief mutex hold so callers can await work on the clone
/// without serializing concurrent RPCs on the shared lock.
async fn clone_locked<T: Clone>(inner: &Mutex<T>) -> T {
    inner.lock().await.clone()
}

struct CompletionConcurrencyGuard<'a> {
    active: &'a AtomicU32,
    overlap_generation: &'a AtomicU32,
    generation_before_start: u32,
    overlapped_on_start: bool,
}

impl<'a> CompletionConcurrencyGuard<'a> {
    fn new(active: &'a AtomicU32, overlap_generation: &'a AtomicU32) -> Self {
        // Snapshot before becoming active so a concurrently starting action
        // either observes us or advances the generation that we later check.
        let generation_before_start = overlap_generation.load(Ordering::Acquire);
        let overlapped_on_start = active.fetch_add(1, Ordering::AcqRel) > 0;
        if overlapped_on_start {
            overlap_generation.fetch_add(1, Ordering::AcqRel);
        }
        Self {
            active,
            overlap_generation,
            generation_before_start,
            overlapped_on_start,
        }
    }

    fn remained_exclusive(&self) -> bool {
        !self.overlapped_on_start
            && self.overlap_generation.load(Ordering::Acquire) == self.generation_before_start
    }
}

impl Drop for CompletionConcurrencyGuard<'_> {
    fn drop(&mut self) {
        let previous = self.active.fetch_sub(1, Ordering::AcqRel);
        debug_assert!(previous > 0, "completion action count underflowed");
    }
}

async fn call_completion_action(
    client: &Client,
    args: &ConvexActionArgs,
) -> Result<Value, CompletionError> {
    let stream_run_id = args.stream_run_id.as_ref().ok_or_else(|| {
        CompletionError::ProviderError(
            "streamRunId is required for completion:complete".to_string(),
        )
    })?;
    let claim_id = args.claim_id.as_ref().ok_or_else(|| {
        CompletionError::ProviderError("claimId is required for completion:complete".to_string())
    })?;
    let completion_concurrency = CompletionConcurrencyGuard::new(
        &client.active_completion_actions,
        &client.completion_overlap_generation,
    );

    let mut retry_delay = COMPLETION_TRANSPORT_RETRY_DELAY;
    let mut superseded_stream_ids: Vec<String> = Vec::new();
    let mut attempt = 0u32;
    loop {
        attempt += 1;
        // Fresh attempt_seq fences orphaned reconnect replays; prior stream
        // ids let the backend drop their partial output on the next try.
        let attempt_seq = client.attempt_counter.fetch_add(1, Ordering::Relaxed) + 1;
        let stream_id = uuid::Uuid::new_v4().to_string();
        let mut convex = clone_locked(&client.inner).await;
        // Register before taking the generation snapshot so a refresh starting
        // while this action is in flight cannot be missed by the grace wait.
        let auth_refresh_started = client.auth_refresh_notify.notified();
        let auth_refresh_generation = client.auth_refresh_generation.load(Ordering::Acquire);
        eprintln!(
            "sprocket-convex-provider: action start {} attempt {attempt_seq}",
            client.completion_action
        );
        let result = match timeout(
            CONVEX_RPC_TIMEOUT,
            convex.action(
                &client.completion_action,
                action_args(
                    args,
                    stream_run_id,
                    claim_id,
                    attempt_seq,
                    &stream_id,
                    &superseded_stream_ids,
                ),
            ),
        )
        .await
        {
            Ok(result) => result,
            Err(error) => {
                // Timeouts are retryable: a reconnect can stall the action
                // future until the RPC deadline instead of returning Err.
                if attempt >= COMPLETION_TRANSPORT_ATTEMPTS {
                    return Err(CompletionError::ProviderError(format!(
                        "timed out calling {}: {error}",
                        client.completion_action
                    )));
                }
                eprintln!(
                    "sprocket-convex-provider: timed out calling {}; retrying: {error}",
                    client.completion_action
                );
                backoff_completion_retry(&mut superseded_stream_ids, stream_id, &mut retry_delay)
                    .await;
                continue;
            }
        };

        let (provider_error, is_error_message) = match result {
            Ok(FunctionResult::Value(value)) => {
                eprintln!(
                    "sprocket-convex-provider: action done {}",
                    client.completion_action
                );
                return Ok(value);
            }
            Ok(FunctionResult::ErrorMessage(message)) => (message, true),
            Ok(FunctionResult::ConvexError(error)) => (error.message, false),
            Err(error) => {
                if attempt >= COMPLETION_TRANSPORT_ATTEMPTS {
                    return Err(to_completion_error(error));
                }
                eprintln!(
                    "sprocket-convex-provider: transport failure calling {}; retrying: {error:#}",
                    client.completion_action
                );
                backoff_completion_retry(&mut superseded_stream_ids, stream_id, &mut retry_delay)
                    .await;
                continue;
            }
        };
        if should_retry_superseded_completion(&provider_error, attempt) {
            // A takeover changes the claim id, so the backend rejects these retries
            // before their attempt sequence can supersede the new owner.
            eprintln!(
                "sprocket-convex-provider: action {} transport attempt {attempt} was superseded; retrying with a fresh stream",
                client.completion_action,
            );
            backoff_completion_retry(&mut superseded_stream_ids, stream_id, &mut retry_delay).await;
            continue;
        }
        let auth_refresh_started = if attempt < COMPLETION_TRANSPORT_ATTEMPTS
            && is_error_message
            && is_redacted_convex_server_error(&provider_error)
            && completion_concurrency.remained_exclusive()
        {
            auth_refresh_observed(
                &client.auth_refresh_generation,
                auth_refresh_generation,
                auth_refresh_started,
                AUTH_REFRESH_CORRELATION_GRACE,
            )
            .await
        } else {
            false
        };
        if should_retry_transient_server_error(
            &provider_error,
            is_error_message,
            auth_refresh_started,
            completion_concurrency.remained_exclusive(),
            attempt,
        ) {
            // An expired identity interrupts in-flight actions with Convex's
            // redacted server error. If a forced refresh began during the
            // attempt, replay through the same stream-fencing path as transport
            // failures. Requiring that correlation avoids retrying developer
            // errors, which Convex redacts to the same text in production.
            eprintln!(
                "sprocket-convex-provider: action {} attempt {attempt} was interrupted by auth refresh; retrying with a fresh stream: {provider_error}",
                client.completion_action,
            );
            backoff_completion_retry(&mut superseded_stream_ids, stream_id, &mut retry_delay).await;
            continue;
        }
        return Err(CompletionError::ProviderError(provider_error));
    }
}

fn should_retry_superseded_completion(message: &str, attempt: u32) -> bool {
    attempt < COMPLETION_TRANSPORT_ATTEMPTS && is_completion_stream_superseded(message)
}

fn should_retry_transient_server_error(
    message: &str,
    is_error_message: bool,
    auth_refresh_started: bool,
    completion_was_exclusive: bool,
    attempt: u32,
) -> bool {
    attempt < COMPLETION_TRANSPORT_ATTEMPTS
        && is_error_message
        && auth_refresh_started
        && completion_was_exclusive
        && is_redacted_convex_server_error(message)
}

async fn auth_refresh_observed(
    generation: &AtomicU32,
    generation_at_start: u32,
    refresh_started: impl Future<Output = ()>,
    grace: Duration,
) -> bool {
    if generation.load(Ordering::Acquire) != generation_at_start {
        return true;
    }

    // Convex can deliver the action error immediately before its background
    // worker starts the reconnect auth callback. Give that callback one short
    // reconnect window, then preserve redacted developer errors as fatal.
    let _ = timeout(grace, refresh_started).await;
    generation.load(Ordering::Acquire) != generation_at_start
}

/// Convex production failures are redacted to this exact shape. This alone
/// does not distinguish infrastructure failures from developer errors; callers
/// must also correlate the response with a forced authentication refresh.
fn is_redacted_convex_server_error(message: &str) -> bool {
    let Some((request_id, suffix)) = message
        .trim()
        .strip_prefix("[Request ID: ")
        .and_then(|rest| rest.split_once(']'))
    else {
        return false;
    };
    !request_id.is_empty() && suffix == " Server Error"
}

async fn backoff_completion_retry(
    superseded_stream_ids: &mut Vec<String>,
    stream_id: String,
    retry_delay: &mut Duration,
) {
    superseded_stream_ids.push(stream_id);
    sleep(*retry_delay).await;
    *retry_delay = retry_delay.saturating_mul(2);
}

fn action_args(
    args: &ConvexActionArgs,
    stream_run_id: &str,
    claim_id: &str,
    attempt_seq: u32,
    stream_id: &str,
    superseded_stream_ids: &[String],
) -> BTreeMap<String, Value> {
    let mut payload = BTreeMap::new();
    payload.insert("modelId".to_string(), args.model_id.clone().into());
    payload.insert("claimId".to_string(), claim_id.to_string().into());
    payload.insert(
        "attemptSeq".to_string(),
        Value::Float64(f64::from(attempt_seq)),
    );
    payload.insert("streamId".to_string(), stream_id.to_string().into());
    if !superseded_stream_ids.is_empty() {
        payload.insert(
            "supersededStreamIds".to_string(),
            Value::Array(
                superseded_stream_ids
                    .iter()
                    .cloned()
                    .map(Value::from)
                    .collect(),
            ),
        );
    }
    if let Some(prompt) = &args.prompt {
        payload.insert("prompt".to_string(), prompt.clone().into());
    }
    payload.insert(
        "messagesJson".to_string(),
        args.messages_json.clone().into(),
    );
    payload.insert("streamRunId".to_string(), stream_run_id.to_string().into());
    if let Some(instructions) = &args.instructions {
        payload.insert("instructions".to_string(), instructions.clone().into());
    }
    if let Some(reasoning_effort) = &args.reasoning_effort {
        payload.insert(
            "reasoningEffort".to_string(),
            reasoning_effort.clone().into(),
        );
    }
    if let Some(service_tier) = &args.service_tier {
        payload.insert("serviceTier".to_string(), service_tier.clone().into());
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
    for event in &mut output.stream_events {
        if let CompletionStreamEvent::ToolCall { input, .. } = event {
            normalize_convex_json_numbers(input);
        }
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
        AssistantContent::ToolCall(RigToolCall {
            id: tool_call.id.clone(),
            call_id: Some(tool_call.id.clone()),
            function: ToolFunction::new(tool_call.name.clone(), tool_call.arguments.clone()),
            signature: None,
            additional_params: tool_call.provider_metadata.clone(),
        })
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

#[cfg(test)]
mod tests {
    use super::{
        COMPLETION_STREAM_SUPERSEDED, COMPLETION_TRANSPORT_ATTEMPTS, CompletionConcurrencyGuard,
        CompletionOutput, CompletionStreamEvent, InputTokenDetails, ToolCall, Usage,
        auth_refresh_observed, clone_locked, completion_choice, is_completion_stream_superseded,
        is_redacted_convex_server_error, reasoning_stream_choices,
        should_retry_superseded_completion, should_retry_transient_server_error,
        text_stream_choices,
    };
    use rig::completion::{CompletionError, GetTokenUsage};
    use rig::message::AssistantContent;
    use rig::streaming::RawStreamingChoice;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::time::Duration;
    use tokio::sync::Mutex;
    use tokio::time::timeout;

    #[tokio::test]
    async fn clone_locked_releases_mutex_before_await() {
        let inner = Arc::new(Mutex::new(0u64));
        let cloned = clone_locked(&inner).await;
        assert_eq!(cloned, 0);

        let inner_for_slow = Arc::clone(&inner);
        let slow = async move {
            let _value = cloned;
            // Simulate a long RPC holding only the clone, not the mutex.
            tokio::time::sleep(Duration::from_secs(30)).await;
        };

        let concurrent = async {
            timeout(Duration::from_millis(100), inner_for_slow.lock())
                .await
                .expect("mutex should be free while clone is used across an await")
        };

        tokio::select! {
            _ = slow => panic!("slow clone consumer should not finish first"),
            mut guard = concurrent => {
                *guard += 1;
            }
        }

        assert_eq!(*inner.lock().await, 1);
    }

    #[tokio::test]
    async fn observes_auth_refresh_when_notification_is_lost() {
        let generation = AtomicU32::new(0);
        let refresh_started = std::future::poll_fn(|_| {
            // Simulate a refresh starting after the first generation check but
            // before the notification future registers its waiter.
            generation.fetch_add(1, Ordering::Release);
            std::task::Poll::<()>::Pending
        });

        assert!(
            auth_refresh_observed(&generation, 0, refresh_started, Duration::from_millis(1),).await
        );
    }

    #[test]
    fn concurrent_completion_overlap_remains_sticky() {
        let active = AtomicU32::new(0);
        let overlap_generation = AtomicU32::new(0);
        let first = CompletionConcurrencyGuard::new(&active, &overlap_generation);
        assert!(first.remained_exclusive());

        {
            let second = CompletionConcurrencyGuard::new(&active, &overlap_generation);
            assert!(!first.remained_exclusive());
            assert!(!second.remained_exclusive());
        }

        // The first action must remain ineligible even after its overlap ends.
        assert!(!first.remained_exclusive());
        drop(first);

        let later = CompletionConcurrencyGuard::new(&active, &overlap_generation);
        assert!(later.remained_exclusive());
    }

    #[test]
    fn deserializes_and_streams_typescript_text_metadata() {
        let event: CompletionStreamEvent = serde_json::from_value(serde_json::json!({
            "type": "text",
            "id": "turn-1:text:output-1",
            "text": "hello",
            "turnId": "turn-1",
            "providerMetadata": { "openai": { "itemId": "msg_123" } }
        }))
        .expect("TypeScript text stream event should deserialize");

        let CompletionStreamEvent::Text {
            text,
            turn_id,
            provider_metadata,
            ..
        } = event
        else {
            panic!("expected text event");
        };
        assert_eq!(turn_id.as_deref(), Some("turn-1"));

        let choices = text_stream_choices(&text, &provider_metadata);
        let RawStreamingChoice::TextStart { additional_params } = &choices[0] else {
            panic!("expected text-start event before text");
        };
        assert_eq!(
            additional_params.as_ref().unwrap()["openai"]["itemId"],
            "msg_123"
        );
        assert!(matches!(&choices[1], RawStreamingChoice::Message(value) if value == "hello"));
    }

    #[test]
    fn streams_id_only_reasoning_for_openai_replay() {
        let choices = reasoning_stream_choices(
            "",
            None,
            &Some(serde_json::json!({
                "openai": {
                    "itemId": "rs_123",
                    "reasoningEncryptedContent": null
                }
            })),
        );

        assert!(matches!(
            choices.as_slice(),
            [RawStreamingChoice::Reasoning {
                id: Some(id),
                content: rig::message::ReasoningContent::Text { text, .. }
            }] if id == "rs_123" && text.is_empty()
        ));
    }

    #[test]
    fn deserializes_typescript_tool_call_stream_event() {
        let event: CompletionStreamEvent = serde_json::from_value(serde_json::json!({
            "type": "toolCall",
            "partId": "turn-1:tool:call_123",
            "callId": "call_123",
            "name": "exec_command",
            "input": { "cmd": "pwd" },
            "turnId": "turn-1",
            "providerMetadata": { "openai": { "itemId": "fc_123" } }
        }))
        .expect("TypeScript stream event should deserialize");

        match event {
            CompletionStreamEvent::ToolCall {
                part_id,
                call_id,
                provider_metadata,
                ..
            } => {
                assert_eq!(part_id, "turn-1:tool:call_123");
                assert_eq!(call_id, "call_123");
                assert_eq!(provider_metadata.unwrap()["openai"]["itemId"], "fc_123");
            }
            other => panic!("expected tool-call event, got {other:?}"),
        }
    }

    #[test]
    fn completion_choice_preserves_provider_call_id() {
        let output = CompletionOutput {
            text: String::new(),
            usage: Usage::default(),
            message_id: None,
            tool_calls: vec![ToolCall {
                id: "call_123".to_string(),
                name: "exec_command".to_string(),
                arguments: serde_json::json!({ "cmd": "pwd" }),
                provider_metadata: None,
            }],
            stream_events: Vec::new(),
        };

        let choice = completion_choice(&output);
        let AssistantContent::ToolCall(tool_call) = choice.first() else {
            panic!("expected tool call");
        };
        assert_eq!(tool_call.id, "call_123");
        assert_eq!(tool_call.call_id.as_deref(), Some("call_123"));
    }

    #[test]
    fn preserves_provider_cache_usage() {
        let output = CompletionOutput {
            text: String::new(),
            usage: Usage {
                input_token_details: InputTokenDetails {
                    cache_read_tokens: 120,
                    cache_write_tokens: 80,
                },
                ..Usage::default()
            },
            message_id: None,
            tool_calls: Vec::new(),
            stream_events: Vec::new(),
        };

        let usage = output.token_usage();
        assert_eq!(usage.cached_input_tokens, 120);
        assert_eq!(usage.cache_creation_input_tokens, 80);
    }

    #[test]
    fn recognizes_superseded_stream_signal_inside_provider_errors() {
        let error = CompletionError::ProviderError(format!(
            "completion:complete failed: {COMPLETION_STREAM_SUPERSEDED}"
        ));

        assert!(is_completion_stream_superseded(&error));
    }

    #[test]
    fn retries_superseded_replays_until_the_transport_attempt_limit() {
        let error = format!("completion:complete failed: {COMPLETION_STREAM_SUPERSEDED}");

        assert!(should_retry_superseded_completion(
            &error,
            COMPLETION_TRANSPORT_ATTEMPTS - 1,
        ));
        assert!(!should_retry_superseded_completion(
            &error,
            COMPLETION_TRANSPORT_ATTEMPTS,
        ));
        assert!(!should_retry_superseded_completion("provider failed", 1));
    }

    #[test]
    fn recognizes_redacted_convex_server_errors() {
        assert!(is_redacted_convex_server_error(
            "[Request ID: b79af67f8bcd57b2] Server Error"
        ));
        assert!(is_redacted_convex_server_error(
            " [Request ID: abc] Server Error "
        ));

        // Other error formats must stay fatal. Even the matching redacted
        // shape is retried only when correlated with a forced auth refresh.
        assert!(!is_redacted_convex_server_error("Server Error"));
        assert!(!is_redacted_convex_server_error(
            "[Request ID: ] Server Error"
        ));
        assert!(!is_redacted_convex_server_error(
            "[Request ID: abc] Uncaught Error: insufficient credits"
        ));
        assert!(!is_redacted_convex_server_error(
            "Server Error: something specific"
        ));
        assert!(!is_redacted_convex_server_error("rate limited"));
    }

    #[test]
    fn retries_redacted_server_errors_until_the_transport_attempt_limit() {
        let message = "[Request ID: b79af67f8bcd57b2] Server Error";

        assert!(should_retry_transient_server_error(
            message,
            true,
            true,
            true,
            COMPLETION_TRANSPORT_ATTEMPTS - 1,
        ));
        assert!(!should_retry_transient_server_error(
            message,
            true,
            true,
            true,
            COMPLETION_TRANSPORT_ATTEMPTS,
        ));
        // ConvexError results are application data, never retried as transient.
        assert!(!should_retry_transient_server_error(
            message, false, true, true, 1
        ));
        // The same redacted text can represent a developer error in prod.
        assert!(!should_retry_transient_server_error(
            message, true, false, true, 1
        ));
        // A shared connection refresh is ambiguous while actions overlap.
        assert!(!should_retry_transient_server_error(
            message, true, true, false, 1
        ));
        assert!(!should_retry_transient_server_error(
            "insufficient credits",
            true,
            true,
            true,
            1,
        ));
    }
}
