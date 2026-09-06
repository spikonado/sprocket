use anyhow::Context;
use convex::{FunctionResult, QuerySubscription, Value};
use serde::Deserialize;
use sprocket_convex::{Client as ConvexRpcClient, decode_function_result};
use std::collections::BTreeMap;
use std::time::Duration;
use tokio::time::sleep;

use crate::types::{
    CreateRunResponse, GatewayCredential, RenewClaimResponse, RunAgentRequest, RunContextResponse,
    StartRunResponse,
};

const CREATE_RUN_MAX_ATTEMPTS: usize = 3;
const CREATE_RUN_INITIAL_RETRY_DELAY: Duration = Duration::from_millis(250);

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum FailedStartCleanup {
    Finalized,
    Pending,
    StandDown,
}

#[derive(Clone)]
pub(crate) struct RuntimeClient {
    pub(crate) client: ConvexRpcClient,
    execution_secret: String,
}

impl RuntimeClient {
    pub(crate) async fn from_request(request: &RunAgentRequest) -> anyhow::Result<Self> {
        eprintln!(
            "sprocket-agent: initializing Convex client for thread {}",
            request.thread_id
        );
        let client = ConvexRpcClient::new(&request.deployment_url).await?;
        client
            .set_auth_token_fetcher(request.auth_token_fetcher.clone())
            .await;
        eprintln!(
            "sprocket-agent: Convex client ready for thread {}",
            request.thread_id
        );
        Ok(Self {
            client,
            execution_secret: request.execution_secret.clone(),
        })
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
        let mut args = self.run_args(run_id);
        args.insert("attachmentsAsPaths".into(), true.into());
        self.query_json("agentRuntime:getContext", args).await
    }

    pub(crate) async fn transcript_state_for_run(
        &self,
        run_id: &str,
    ) -> anyhow::Result<crate::transcript::RemoteTranscriptState> {
        self.query_json("transcript:getStateForRun", self.run_args(run_id))
            .await
    }

    pub(crate) async fn transcript_parts_for_run(
        &self,
        run_id: &str,
        numbers: &[u32],
    ) -> anyhow::Result<Vec<crate::transcript::TranscriptPart>> {
        let mut args = self.run_args(run_id);
        args.insert(
            "numbers".to_string(),
            Value::Array(
                numbers
                    .iter()
                    .map(|number| Value::Float64(*number as f64))
                    .collect(),
            ),
        );
        let value: serde_json::Value = self.query_json("transcript:getPartsForRun", args).await?;
        crate::transcript::parse_remote_parts(value)
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
        if !request.thread_id.is_empty() {
            args.insert("threadId".to_string(), request.thread_id.clone().into());
        }
        if let Some(repository_key) = &request.repository_key {
            args.insert("repositoryKey".to_string(), repository_key.clone().into());
        }
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
        args.insert(
            "agentVersion".to_string(),
            env!("CARGO_PKG_VERSION").to_string().into(),
        );
        args.insert(
            "machineId".to_string(),
            request.installation_id.clone().into(),
        );
        if let Some(continuation_of_run_id) = &request.continuation_of_run_id {
            args.insert(
                "continuationOfRunId".to_string(),
                continuation_of_run_id.clone().into(),
            );
        }
        self.add_execution_secret(&mut args);

        let mut retry_delay = CREATE_RUN_INITIAL_RETRY_DELAY;
        let mut last_error = None;
        for attempt in 1..=CREATE_RUN_MAX_ATTEMPTS {
            match self
                .client
                .action("agentRuntime:createGatewayRun", args.clone())
                .await
            {
                Ok(result) => {
                    return decode_function_result(result, "agentRuntime:createGatewayRun");
                }
                Err(error) if attempt < CREATE_RUN_MAX_ATTEMPTS => {
                    eprintln!(
                        "sprocket-agent: createGatewayRun transport attempt {attempt} failed; \
                         reconciling with request {}: {error:#}",
                        request.submission_id
                    );
                    sleep(retry_delay).await;
                    retry_delay = retry_delay.saturating_mul(2);
                }
                Err(error) => last_error = Some(error),
            }
        }

        Err(last_error.expect("createGatewayRun retry loop records a final error")).with_context(
            || {
                format!(
                    "agentRuntime:createGatewayRun failed after {CREATE_RUN_MAX_ATTEMPTS} attempts"
                )
            },
        )
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

    pub(crate) async fn issue_gateway_credential(
        &self,
        run_id: &str,
        claim_id: &str,
    ) -> anyhow::Result<GatewayCredential> {
        self.mutation_json(
            "agentRuntime:issueGatewayCredential",
            self.run_args_with_claim(run_id, claim_id),
        )
        .await
    }

    pub(crate) async fn register_completion_attempt(
        &self,
        run_id: &str,
        claim_id: &str,
        attempt_seq: u64,
    ) -> anyhow::Result<()> {
        let mut args = self.run_args_with_claim(run_id, claim_id);
        args.insert("attemptSeq".to_string(), Value::Float64(attempt_seq as f64));
        self.mutation_unit("agentRuntime:registerCompletionAttempt", args)
            .await
    }

    pub(crate) async fn finalize_completion_call(
        &self,
        run_id: &str,
        claim_id: &str,
        attempt_seq: u64,
        stream_id: &str,
        items: Vec<serde_json::Value>,
    ) -> anyhow::Result<()> {
        let mut args = self.run_args_with_claim(run_id, claim_id);
        args.insert("attemptSeq".to_string(), Value::Float64(attempt_seq as f64));
        args.insert("streamId".to_string(), stream_id.to_string().into());
        args.insert(
            "items".to_string(),
            Value::try_from(serde_json::Value::Array(items))?,
        );
        let _: serde_json::Value = self
            .mutation_json("agentRuntime:finalizeCompletionCall", args)
            .await?;
        Ok(())
    }

    pub(crate) async fn finalize_failed_start(
        &self,
        request: &RunAgentRequest,
        text: &str,
        last_error: &str,
    ) -> anyhow::Result<FailedStartCleanup> {
        let mut args = BTreeMap::new();
        args.insert(
            "submissionId".to_string(),
            request.submission_id.clone().into(),
        );
        if !request.thread_id.is_empty() {
            args.insert("threadId".to_string(), request.thread_id.clone().into());
        }
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

    pub(crate) async fn save_context_handoff(
        &self,
        run_id: &str,
        claim_id: &str,
        summary: &str,
        completion_attempt_seq: u64,
        before_prompt: bool,
    ) -> anyhow::Result<bool> {
        let mut args = self.run_args_with_claim(run_id, claim_id);
        args.insert("summary".to_string(), summary.to_string().into());
        args.insert(
            "completionAttemptSeq".to_string(),
            Value::Float64(completion_attempt_seq as f64),
        );
        args.insert("beforePrompt".to_string(), Value::Boolean(before_prompt));
        self.mutation_json("agentRuntime:saveContextHandoff", args)
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

    pub(crate) async fn subscribe(
        &self,
        function: &str,
        mut args: BTreeMap<String, Value>,
    ) -> anyhow::Result<QuerySubscription> {
        self.add_execution_secret(&mut args);
        self.client.subscribe(function, args).await
    }

    pub(crate) fn decode_subscription_update<T: for<'de> Deserialize<'de>>(
        result: FunctionResult,
        function: &str,
    ) -> anyhow::Result<T> {
        decode_function_result(result, function)
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
            self.execution_secret.clone().into(),
        );
    }

    fn run_args_with_claim(&self, run_id: &str, claim_id: &str) -> BTreeMap<String, Value> {
        let mut args = self.run_args(run_id);
        args.insert("claimId".to_string(), claim_id.to_string().into());
        args
    }
}
