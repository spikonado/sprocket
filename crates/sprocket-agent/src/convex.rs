use anyhow::{Context, anyhow};
use convex::{FunctionResult, QuerySubscription, Value};
use serde::Deserialize;
use sprocket_convex_provider::Client as ConvexProviderClient;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::time::sleep;

use crate::types::{
    CreateRunResponse, RenewClaimResponse, RunAgentRequest, RunContextResponse, StartRunResponse,
};

const CREATE_RUN_MAX_ATTEMPTS: usize = 3;
const CREATE_RUN_INITIAL_RETRY_DELAY: Duration = Duration::from_millis(250);

pub async fn authenticated_user_id(
    deployment_url: &str,
    auth_token: String,
) -> anyhow::Result<String> {
    let client = ConvexProviderClient::new(deployment_url, "completion:complete").await?;
    client
        .set_auth_token_fetcher(Arc::new(move |_| {
            let auth_token = auth_token.clone();
            Box::pin(async move { Ok(auth_token) })
        }))
        .await;
    let result = client
        .query("agentRuntime:authenticatedUserId", BTreeMap::new())
        .await?;
    decode_function_result(result, "agentRuntime:authenticatedUserId")
}

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
        let client =
            ConvexProviderClient::new(&request.deployment_url, "completion:complete").await?;
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
        args: BTreeMap<String, Value>,
    ) -> anyhow::Result<T> {
        eprintln!("sprocket-agent: query start {function}");
        let result = self.client.query(function, args).await?;
        eprintln!("sprocket-agent: query done {function}");
        decode_function_result(result, function)
    }

    pub(crate) async fn mutation_json<T: for<'de> Deserialize<'de>>(
        &self,
        function: &str,
        args: BTreeMap<String, Value>,
    ) -> anyhow::Result<T> {
        eprintln!("sprocket-agent: mutation start {function}");
        let result = self.client.mutation(function, args).await?;
        eprintln!("sprocket-agent: mutation done {function}");
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
        self.client
            .subscribe("agentRuntime:isFinished", self.run_args(run_id))
            .await
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
        self.mutation_json("agentRuntime:finalizeRun", args).await
    }

    fn run_args(&self, run_id: &str) -> BTreeMap<String, Value> {
        let mut args = BTreeMap::new();
        args.insert("runId".to_string(), run_id.to_string().into());
        args
    }

    fn run_args_with_claim(&self, run_id: &str, claim_id: &str) -> BTreeMap<String, Value> {
        let mut args = self.run_args(run_id);
        args.insert("claimId".to_string(), claim_id.to_string().into());
        args
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
