use std::collections::BTreeMap;
use std::time::Duration;

use anyhow::{Context, anyhow};
use convex::{FunctionResult, Value};
use serde::Deserialize;
use tokio::time::timeout;

use crate::completion::ConvexRigClient;
use crate::types::{RunAgentRequest, RunContextResponse};

const CONVEX_RPC_TIMEOUT: Duration = Duration::from_secs(20 * 60);

#[derive(Clone)]
pub(crate) struct RuntimeClient {
    pub(crate) client: ConvexRigClient,
    guest_id: Option<String>,
}

impl RuntimeClient {
    pub(crate) async fn from_request(request: &RunAgentRequest) -> anyhow::Result<Self> {
        eprintln!(
            "sprocket-rig: initializing Convex client for run {}",
            request.run_id
        );
        let client = ConvexRigClient::new(&request.deployment_url, "completion:complete").await?;
        client.set_auth_token(request.auth_token.clone()).await;
        eprintln!(
            "sprocket-rig: Convex client ready for run {}",
            request.run_id
        );
        Ok(Self {
            client,
            guest_id: request.guest_id.clone(),
        })
    }

    pub(crate) async fn query_json<T: for<'de> Deserialize<'de>>(
        &self,
        function: &str,
        args: BTreeMap<String, Value>,
    ) -> anyhow::Result<T> {
        eprintln!("sprocket-rig: query start {function}");
        let mut convex = self.client.inner.lock().await;
        let result = timeout(CONVEX_RPC_TIMEOUT, convex.query(function, args))
            .await
            .with_context(|| format!("query timed out for {function}"))??;
        eprintln!("sprocket-rig: query done {function}");
        decode_function_result(result, function)
    }

    pub(crate) async fn mutation_json<T: for<'de> Deserialize<'de>>(
        &self,
        function: &str,
        args: BTreeMap<String, Value>,
    ) -> anyhow::Result<T> {
        eprintln!("sprocket-rig: mutation start {function}");
        let mut convex = self.client.inner.lock().await;
        let result = timeout(CONVEX_RPC_TIMEOUT, convex.mutation(function, args))
            .await
            .with_context(|| format!("mutation timed out for {function}"))??;
        eprintln!("sprocket-rig: mutation done {function}");
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

    pub(crate) async fn start_run(&self, run_id: &str) -> anyhow::Result<()> {
        self.mutation_unit("agentRuntime:start", self.run_args(run_id))
            .await
    }

    pub(crate) async fn begin_assistant_message(&self, run_id: &str) -> anyhow::Result<String> {
        let assistant_message: serde_json::Value = self
            .mutation_json("agentRuntime:beginAssistantMessage", self.run_args(run_id))
            .await?;

        assistant_message
            .get("_id")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| anyhow!("beginAssistantMessage did not return a message id"))
    }

    pub(crate) async fn finish_assistant_message(
        &self,
        message_id: &str,
        text: &str,
        status: &str,
    ) -> anyhow::Result<()> {
        let mut args = self.args_with_actor();
        args.insert("messageId".to_string(), message_id.to_string().into());
        args.insert("text".to_string(), text.to_string().into());
        args.insert("status".to_string(), status.to_string().into());
        self.mutation_unit("agentRuntime:finishAssistantMessage", args)
            .await
    }

    pub(crate) async fn run_finished(&self, run_id: &str) -> anyhow::Result<bool> {
        self.query_json("agentRuntime:isFinished", self.run_args(run_id))
            .await
    }

    pub(crate) async fn finish_run(
        &self,
        run_id: &str,
        status: &str,
        last_error: Option<&str>,
    ) -> anyhow::Result<()> {
        let mut args = self.run_args(run_id);
        args.insert("status".to_string(), status.to_string().into());
        if let Some(last_error) = last_error {
            args.insert("lastError".to_string(), last_error.to_string().into());
        }
        self.mutation_unit("agentRuntime:finishRun", args).await
    }

    pub(crate) fn args_with_actor(&self) -> BTreeMap<String, Value> {
        let mut args = BTreeMap::new();
        if let Some(guest_id) = &self.guest_id {
            args.insert("guestId".to_string(), guest_id.clone().into());
        }
        args
    }

    fn run_args(&self, run_id: &str) -> BTreeMap<String, Value> {
        let mut args = self.args_with_actor();
        args.insert("runId".to_string(), run_id.to_string().into());
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
