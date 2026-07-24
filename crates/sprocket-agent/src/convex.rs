use anyhow::{Context, anyhow};
use convex::{FunctionResult, QuerySubscription, Value};
use serde::Deserialize;
use sprocket_convex_provider::{Client as ConvexProviderClient, Usage as CompletionUsage};
use std::collections::BTreeMap;
use std::time::Duration;
use tokio::time::sleep;

use crate::types::{
    CreateRunResponse, RenewClaimResponse, RunAgentRequest, RunContextResponse, StartRunResponse,
};

const CREATE_RUN_MAX_ATTEMPTS: usize = 3;
const CREATE_RUN_INITIAL_RETRY_DELAY: Duration = Duration::from_millis(250);

#[derive(Clone)]
pub(crate) struct RuntimeClient {
    pub(crate) client: ConvexProviderClient,
}

impl RuntimeClient {
    pub(crate) async fn from_request(request: &RunAgentRequest) -> anyhow::Result<Self> {
        eprintln!(
            "sprocket-agent: initializing Convex client for thread {}",
            request.thread_id
        );
        let client = ConvexProviderClient::new(&request.deployment_url, "completion:complete")
            .await?
            .with_execution_secret(request.execution_secret.clone());
        client
            .set_auth_token_fetcher(request.auth_token_fetcher.clone())
            .await;
        eprintln!(
            "sprocket-agent: Convex client ready for thread {}",
            request.thread_id
        );
        Ok(Self { client })
    }

    pub(crate) fn completion_client(&self) -> &ConvexProviderClient {
        &self.client
    }

    pub(crate) async fn query_json<T: for<'de> Deserialize<'de>>(
        &self,
        function: &str,
        mut args: BTreeMap<String, Value>,
    ) -> anyhow::Result<T> {
        self.add_execution_secret(&mut args);
        eprintln!("sprocket-agent: query start {function}");
        let result = self.client.query(function, args).await?;
        eprintln!("sprocket-agent: query done {function}");
        decode_function_result(result, function)
    }

    pub(crate) async fn mutation_json<T: for<'de> Deserialize<'de>>(
        &self,
        function: &str,
        mut args: BTreeMap<String, Value>,
    ) -> anyhow::Result<T> {
        self.add_execution_secret(&mut args);
        eprintln!("sprocket-agent: mutation start {function}");
        let result = self.client.mutation(function, args).await?;
        eprintln!("sprocket-agent: mutation done {function}");
        decode_function_result(result, function)
    }

    pub(crate) async fn action_json<T: for<'de> Deserialize<'de>>(
        &self,
        function: &str,
        mut args: BTreeMap<String, Value>,
    ) -> anyhow::Result<T> {
        self.add_execution_secret(&mut args);
        eprintln!("sprocket-agent: action start {function}");
        let result = self.client.action(function, args).await?;
        eprintln!("sprocket-agent: action done {function}");
        decode_function_result(result, function)
    }

    pub(crate) async fn mutation_unit(
        &self,
        function: &str,
        args: BTreeMap<String, Value>,
    ) -> anyhow::Result<()> {
        let _: serde_json::Value = self.mutation_json(function, args).await?;
        Ok(())
    }

    pub(crate) async fn run_context(&self, run_id: &str) -> anyhow::Result<RunContextResponse> {
        self.query_json("agentRuntime:getContext", self.run_args(run_id))
            .await
    }

    pub(crate) async fn create_run(
        &self,
        request: &RunAgentRequest,
    ) -> anyhow::Result<CreateRunResponse> {
        let mut args = BTreeMap::new();
        args.insert(
            "submissionId".to_string(),
            request.submission_id.clone().into(),
        );
        args.insert("threadId".to_string(), request.thread_id.clone().into());
        args.insert("prompt".to_string(), request.prompt.clone().into());
        args.insert(
            "imageUploadIds".to_string(),
            Value::Array(
                request
                    .image_upload_ids
                    .iter()
                    .cloned()
                    .map(Value::from)
                    .collect(),
            ),
        );
        args.insert(
            "selectedModel".to_string(),
            request.selected_model.clone().into(),
        );
        args.insert(
            "reasoningEffort".to_string(),
            request.reasoning_effort.clone().into(),
        );
        args.insert(
            "serviceTier".to_string(),
            request.service_tier.clone().into(),
        );
        self.add_execution_secret(&mut args);

        let mut retry_delay = CREATE_RUN_INITIAL_RETRY_DELAY;
        let mut last_error = None;
        for attempt in 1..=CREATE_RUN_MAX_ATTEMPTS {
            match self
                .client
                .mutation("agentRuntime:createRun", args.clone())
                .await
            {
                Ok(result) => return decode_function_result(result, "agentRuntime:createRun"),
                Err(error) if attempt < CREATE_RUN_MAX_ATTEMPTS => {
                    eprintln!(
                        "sprocket-agent: createRun transport attempt {attempt} failed; reconciling with request {}: {error:#}",
                        request.submission_id
                    );
                    sleep(retry_delay).await;
                    retry_delay = retry_delay.saturating_mul(2);
                }
                Err(error) => last_error = Some(error),
            }
        }

        Err(last_error.expect("createRun retry loop records a final error")).with_context(|| {
            format!("agentRuntime:createRun failed after {CREATE_RUN_MAX_ATTEMPTS} attempts")
        })
    }

    pub(crate) async fn start_run(
        &self,
        run_id: &str,
        claim_id: &str,
    ) -> anyhow::Result<StartRunResponse> {
        self.mutation_json(
            "agentRuntime:start",
            self.run_args_with_claim(run_id, claim_id),
        )
        .await
    }

    pub(crate) async fn finalize_failed_start(
        &self,
        request: &RunAgentRequest,
        text: &str,
        last_error: &str,
    ) -> anyhow::Result<bool> {
        let mut args = BTreeMap::new();
        args.insert(
            "submissionId".to_string(),
            request.submission_id.clone().into(),
        );
        args.insert("threadId".to_string(), request.thread_id.clone().into());
        args.insert("prompt".to_string(), request.prompt.clone().into());
        args.insert(
            "imageUploadIds".to_string(),
            Value::Array(
                request
                    .image_upload_ids
                    .iter()
                    .cloned()
                    .map(Value::from)
                    .collect(),
            ),
        );
        args.insert(
            "selectedModel".to_string(),
            request.selected_model.clone().into(),
        );
        args.insert(
            "reasoningEffort".to_string(),
            request.reasoning_effort.clone().into(),
        );
        args.insert(
            "serviceTier".to_string(),
            request.service_tier.clone().into(),
        );
        args.insert("text".to_string(), text.to_string().into());
        args.insert("lastError".to_string(), last_error.to_string().into());
        self.mutation_json("agentRuntime:finalizeFailedStart", args)
            .await
    }

    pub(crate) async fn finalize_claim_failure(
        &self,
        run_id: &str,
        claim_id: &str,
        text: &str,
        last_error: &str,
    ) -> anyhow::Result<bool> {
        let mut args = self.run_args_with_claim(run_id, claim_id);
        args.insert("text".to_string(), text.to_string().into());
        args.insert("lastError".to_string(), last_error.to_string().into());
        self.mutation_json("agentRuntime:finalizeClaimFailure", args)
            .await
    }

    pub(crate) async fn renew_claim(
        &self,
        run_id: &str,
        claim_id: &str,
    ) -> anyhow::Result<RenewClaimResponse> {
        self.mutation_json(
            "agentRuntime:renewClaim",
            self.run_args_with_claim(run_id, claim_id),
        )
        .await
    }

    pub(crate) async fn record_context_usage(
        &self,
        run_id: &str,
        claim_id: &str,
        context_tokens: u64,
        processed_tokens: u64,
    ) -> anyhow::Result<bool> {
        let mut args = self.run_args_with_claim(run_id, claim_id);
        args.insert(
            "contextTokens".to_string(),
            Value::Float64(context_tokens as f64),
        );
        args.insert(
            "processedTokens".to_string(),
            Value::Float64(processed_tokens as f64),
        );
        self.mutation_json("agentRuntime:recordContextUsage", args)
            .await
    }

    pub(crate) async fn save_context_compaction(
        &self,
        run_id: &str,
        claim_id: &str,
        summary: &str,
        processed_tokens: u64,
        persist_for_future_runs: bool,
    ) -> anyhow::Result<bool> {
        let mut args = self.run_args_with_claim(run_id, claim_id);
        args.insert("summary".to_string(), summary.to_string().into());
        args.insert(
            "processedTokens".to_string(),
            Value::Float64(processed_tokens as f64),
        );
        args.insert(
            "persistForFutureRuns".to_string(),
            Value::Boolean(persist_for_future_runs),
        );
        self.mutation_json("agentRuntime:saveContextCompaction", args)
            .await
    }

    pub(crate) async fn summarize(
        &self,
        run_id: &str,
        claim_id: &str,
        model_id: &str,
        reasoning_effort: &str,
        service_tier: &str,
        messages_json: &str,
    ) -> anyhow::Result<SummarizeResponse> {
        let mut args = self.run_args_with_claim(run_id, claim_id);
        args.insert("modelId".to_string(), model_id.to_string().into());
        args.insert(
            "reasoningEffort".to_string(),
            reasoning_effort.to_string().into(),
        );
        args.insert("serviceTier".to_string(), service_tier.to_string().into());
        args.insert("messagesJson".to_string(), messages_json.to_string().into());
        self.action_json("completion:summarize", args).await
    }

    pub(crate) async fn begin_assistant_message(&self, run_id: &str) -> anyhow::Result<()> {
        self.mutation_unit("agentRuntime:beginAssistantMessage", self.run_args(run_id))
            .await
    }

    pub(crate) async fn run_finished(&self, run_id: &str) -> anyhow::Result<bool> {
        self.query_json("agentRuntime:isFinished", self.run_args(run_id))
            .await
    }

    pub(crate) async fn run_finished_subscription(
        &self,
        run_id: &str,
    ) -> anyhow::Result<QuerySubscription> {
        let mut args = self.run_args(run_id);
        self.add_execution_secret(&mut args);
        self.client.subscribe("agentRuntime:isFinished", args).await
    }

    pub(crate) fn decode_run_finished_update(result: FunctionResult) -> anyhow::Result<bool> {
        decode_function_result(result, "agentRuntime:isFinished")
    }

    pub(crate) async fn finalize_run(
        &self,
        run_id: &str,
        claim_id: &str,
        text: &str,
        status: &str,
        last_error: Option<&str>,
    ) -> anyhow::Result<bool> {
        self.finalize_run_with_expectations(run_id, text, status, last_error, Some(claim_id), None)
            .await
    }

    pub(crate) async fn finalize_queued_run(
        &self,
        run_id: &str,
        text: &str,
        status: &str,
        last_error: Option<&str>,
    ) -> anyhow::Result<bool> {
        self.finalize_run_with_expectations(run_id, text, status, last_error, None, Some("queued"))
            .await
    }

    async fn finalize_run_with_expectations(
        &self,
        run_id: &str,
        text: &str,
        status: &str,
        last_error: Option<&str>,
        expected_claim_id: Option<&str>,
        expected_status: Option<&str>,
    ) -> anyhow::Result<bool> {
        let mut args = self.run_args(run_id);
        if let Some(expected_claim_id) = expected_claim_id {
            args.insert(
                "expectedClaimId".to_string(),
                expected_claim_id.to_string().into(),
            );
        }
        if let Some(expected_status) = expected_status {
            args.insert(
                "expectedStatus".to_string(),
                expected_status.to_string().into(),
            );
        }
        args.insert("text".to_string(), text.to_string().into());
        args.insert("status".to_string(), status.to_string().into());
        if let Some(last_error) = last_error {
            args.insert("lastError".to_string(), last_error.to_string().into());
        }
        self.mutation_json("agentRuntime:finalizeExecutorRun", args)
            .await
    }

    fn run_args(&self, run_id: &str) -> BTreeMap<String, Value> {
        let mut args = BTreeMap::new();
        args.insert("runId".to_string(), run_id.to_string().into());
        args
    }

    fn add_execution_secret(&self, args: &mut BTreeMap<String, Value>) {
        args.insert(
            "executionSecret".to_string(),
            self.client
                .execution_secret()
                .expect("runtime client has an execution secret")
                .to_string()
                .into(),
        );
    }

    fn run_args_with_claim(&self, run_id: &str, claim_id: &str) -> BTreeMap<String, Value> {
        let mut args = self.run_args(run_id);
        args.insert("claimId".to_string(), claim_id.to_string().into());
        args
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SummarizeResponse {
    pub(crate) summary: String,
    pub(crate) usage: CompletionUsage,
}

impl SummarizeResponse {
    pub(crate) fn processed_tokens(&self) -> u64 {
        // Prefer `input_tokens` when it already includes cache details; otherwise add them.
        let cache_tokens = self
            .usage
            .input_token_details
            .cache_read_tokens
            .saturating_add(self.usage.input_token_details.cache_write_tokens);
        let input = if self.usage.input_tokens >= cache_tokens {
            self.usage.input_tokens
        } else {
            self.usage.input_tokens.saturating_add(cache_tokens)
        };
        input.saturating_add(self.usage.output_tokens)
    }
}

fn decode_function_result<T: for<'de> Deserialize<'de>>(
    result: FunctionResult,
    function: &str,
) -> anyhow::Result<T> {
    match result {
        FunctionResult::Value(value) => {
            let json_value = convex_value_to_plain_json(value);
            serde_json::from_value(json_value.clone()).with_context(|| {
                format!(
                    "failed to decode response from {function}; payload: {}",
                    json_value
                )
            })
        }
        FunctionResult::ErrorMessage(message) => Err(anyhow!("{function} failed: {message}")),
        FunctionResult::ConvexError(error) => Err(anyhow!("{function} failed: {}", error.message)),
    }
}

fn convex_value_to_plain_json(value: Value) -> serde_json::Value {
    match value {
        Value::Null => serde_json::Value::Null,
        Value::Int64(number) => serde_json::json!(number),
        Value::Float64(number) => serde_json::json!(number),
        Value::Boolean(boolean) => serde_json::json!(boolean),
        Value::String(text) => serde_json::json!(text),
        Value::Bytes(bytes) => serde_json::json!(bytes),
        Value::Array(values) => serde_json::Value::Array(
            values
                .into_iter()
                .map(convex_value_to_plain_json)
                .collect::<Vec<_>>(),
        ),
        Value::Object(fields) => serde_json::Value::Object(
            fields
                .into_iter()
                .map(|(key, value)| (key, convex_value_to_plain_json(value)))
                .collect(),
        ),
    }
}
