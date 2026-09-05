use std::collections::{BTreeMap, HashSet};
use std::time::Duration;

use convex::Value;
use futures::StreamExt;
use rig::tool::ToolExecutionError;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sprocket_workspace::WorkspaceCancellation;
use tokio::time::{Instant, sleep};

use super::context::{AgentToolContext, cancelled_error, tool_error, tool_failure};
use super::job::execute_tool_job;
use crate::convex::RuntimeClient;

pub(super) const DEFAULT_ASK_QUESTION_YIELD_MS: u64 = 10 * 60 * 1000;
pub(super) const DEFAULT_ASK_QUESTION_TIMEOUT_MS: u64 = 30 * 60 * 1000;
pub(super) const DEFAULT_AWAIT_QUESTION_YIELD_MS: u64 = 5_000;
pub(super) const MAX_QUESTION_CHARS: usize = 2000;
pub(super) const MAX_OPTION_ID_CHARS: usize = 20;
pub(super) const MAX_OPTION_LABEL_CHARS: usize = 200;
pub(super) const MIN_AGENT_OPTIONS: usize = 1;
pub(super) const MAX_AGENT_OPTIONS: usize = 4;
pub(super) const AGENT_DECIDE_OPTION_ID: &str = "agent_decide";
const GET_QUESTION_FUNCTION: &str = "agentQuestions:getForExecutor";

#[derive(Clone)]
pub(crate) struct AskQuestionTool(pub(super) AgentToolContext);

#[derive(Clone)]
pub(crate) struct AwaitQuestionTool(pub(super) AgentToolContext);

fn default_ask_question_yield_ms() -> u64 {
    DEFAULT_ASK_QUESTION_YIELD_MS
}

fn default_ask_question_timeout_ms() -> u64 {
    DEFAULT_ASK_QUESTION_TIMEOUT_MS
}

fn default_await_question_yield_ms() -> u64 {
    DEFAULT_AWAIT_QUESTION_YIELD_MS
}

fn is_default_ask_question_yield_ms(yield_time_ms: &u64) -> bool {
    *yield_time_ms == DEFAULT_ASK_QUESTION_YIELD_MS
}

fn is_default_ask_question_timeout_ms(timeout_ms: &u64) -> bool {
    *timeout_ms == DEFAULT_ASK_QUESTION_TIMEOUT_MS
}

fn is_default_await_question_yield_ms(yield_time_ms: &u64) -> bool {
    *yield_time_ms == DEFAULT_AWAIT_QUESTION_YIELD_MS
}

fn ask_question_parameters() -> serde_json::Value {
    let mut schema = json!(schemars::schema_for!(AskQuestionArgs));
    schema["properties"]["yieldTimeMs"]["default"] = json!(DEFAULT_ASK_QUESTION_YIELD_MS);
    schema["properties"]["timeoutMs"]["default"] = json!(DEFAULT_ASK_QUESTION_TIMEOUT_MS);
    schema
}

fn await_question_parameters() -> serde_json::Value {
    let mut schema = json!(schemars::schema_for!(AwaitQuestionArgs));
    schema["properties"]["yieldTimeMs"]["default"] = json!(DEFAULT_AWAIT_QUESTION_YIELD_MS);
    schema
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
pub(crate) struct AskQuestionOption {
    /// Stable option identifier returned with the user's answer.
    pub(crate) id: String,
    /// Option text shown to the user.
    pub(crate) label: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
pub(crate) struct AskQuestionArgs {
    /// Question shown above the composer.
    pub(crate) question: String,
    /// Answer choices. Provide 1-4 options; a "Let me (the agent) decide" option is appended automatically.
    pub(crate) options: Vec<AskQuestionOption>,
    /// Wait for an answer before yielding a questionId, in milliseconds. Use 0 to return immediately.
    #[serde(
        rename = "yieldTimeMs",
        default = "default_ask_question_yield_ms",
        skip_serializing_if = "is_default_ask_question_yield_ms"
    )]
    #[schemars(default = "default_ask_question_yield_ms")]
    pub(crate) yield_time_ms: u64,
    /// Expire the unanswered question after this many milliseconds.
    #[serde(
        rename = "timeoutMs",
        default = "default_ask_question_timeout_ms",
        skip_serializing_if = "is_default_ask_question_timeout_ms"
    )]
    #[schemars(default = "default_ask_question_timeout_ms")]
    pub(crate) timeout_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
pub(crate) struct AwaitQuestionArgs {
    /// Question identifier returned by ask_question when still pending.
    #[serde(rename = "questionId")]
    pub(crate) question_id: String,
    /// Wait for an answer or timeout, in milliseconds.
    #[serde(
        rename = "yieldTimeMs",
        default = "default_await_question_yield_ms",
        skip_serializing_if = "is_default_await_question_yield_ms"
    )]
    #[schemars(default = "default_await_question_yield_ms")]
    pub(crate) yield_time_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct QuestionAnswer {
    #[serde(skip_serializing_if = "Option::is_none")]
    option_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    option_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QuestionSnapshot {
    question_id: String,
    question: String,
    options: Vec<AskQuestionOption>,
    status: String,
    answer: Option<QuestionAnswer>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateQuestionResponse {
    question_id: String,
    question: String,
    options: Vec<AskQuestionOption>,
}

impl rig::tool::Tool for AskQuestionTool {
    const NAME: &'static str = "ask_question";
    type Error = ToolExecutionError;
    type Args = AskQuestionArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        format!(
            "Ask the user a multiple-choice question above the composer. Waits up to yieldTimeMs for an answer, otherwise returns a questionId for await_question."
        )
    }

    fn parameters(&self) -> serde_json::Value {
        ask_question_parameters()
    }

    async fn call(
        &self,
        _context: &mut rig::tool::ToolContext,
        args: Self::Args,
    ) -> Result<Self::Output, Self::Error> {
        let prepared = prepare_ask_question(&args)?;
        let payload = serde_json::to_value(&args).map_err(|e| tool_error(e.into()))?;
        execute_tool_job(
            &self.0.runtime,
            &self.0.run_id,
            &self.0.claim_id,
            Self::NAME,
            &self.0.tool_call_tracker,
            payload,
            |cancellation| {
                let runtime = self.0.runtime.clone();
                let run_id = self.0.run_id.clone();
                let claim_id = self.0.claim_id.clone();
                async move {
                    let created = create_agent_question(
                        &runtime,
                        &run_id,
                        &claim_id,
                        &prepared.question,
                        &prepared.options,
                        args.timeout_ms,
                    )
                    .await?;
                    observe_question(
                        &runtime,
                        &run_id,
                        &created.question_id,
                        &created.question,
                        &created.options,
                        args.yield_time_ms,
                        cancellation,
                    )
                    .await
                }
            },
        )
        .await
    }
}

impl rig::tool::Tool for AwaitQuestionTool {
    const NAME: &'static str = "await_question";
    type Error = ToolExecutionError;
    type Args = AwaitQuestionArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        "Wait for a previously yielded ask_question result. Poll with yieldTimeMs until answered, timed out, or still pending."
            .to_string()
    }

    fn parameters(&self) -> serde_json::Value {
        await_question_parameters()
    }

    async fn call(
        &self,
        _context: &mut rig::tool::ToolContext,
        args: Self::Args,
    ) -> Result<Self::Output, Self::Error> {
        if args.question_id.trim().is_empty() {
            return Err(tool_failure("questionId cannot be empty"));
        }
        let payload = serde_json::to_value(&args).map_err(|e| tool_error(e.into()))?;
        execute_tool_job(
            &self.0.runtime,
            &self.0.run_id,
            &self.0.claim_id,
            Self::NAME,
            &self.0.tool_call_tracker,
            payload,
            |cancellation| {
                let runtime = self.0.runtime.clone();
                let run_id = self.0.run_id.clone();
                let question_id = args.question_id.clone();
                async move {
                    let snapshot = fetch_question_snapshot(&runtime, &run_id, &question_id).await?;
                    let Some(snapshot) = snapshot else {
                        return Err(tool_failure(format!("Unknown questionId '{question_id}'")));
                    };
                    // Avoid racing the yield deadline against a slow first subscription
                    // update when the question is already terminal.
                    if snapshot.status != "pending" {
                        return question_result_from_snapshot(&snapshot);
                    }
                    observe_question(
                        &runtime,
                        &run_id,
                        &snapshot.question_id,
                        &snapshot.question,
                        &snapshot.options,
                        args.yield_time_ms,
                        cancellation,
                    )
                    .await
                }
            },
        )
        .await
    }
}

#[derive(Clone, Debug)]
pub(super) struct PreparedAskQuestion {
    pub(super) question: String,
    pub(super) options: Vec<AskQuestionOption>,
}

pub(super) fn prepare_ask_question(
    args: &AskQuestionArgs,
) -> Result<PreparedAskQuestion, ToolExecutionError> {
    let question = args.question.trim();
    if question.is_empty() {
        return Err(tool_failure("Question cannot be empty."));
    }
    if question.chars().count() > MAX_QUESTION_CHARS {
        return Err(tool_failure(format!(
            "Question cannot exceed {MAX_QUESTION_CHARS} characters."
        )));
    }
    if args.options.len() < MIN_AGENT_OPTIONS || args.options.len() > MAX_AGENT_OPTIONS {
        return Err(tool_failure(format!(
            "Provide between {MIN_AGENT_OPTIONS} and {MAX_AGENT_OPTIONS} options (the agent-decide option is added automatically)."
        )));
    }

    let mut seen = HashSet::new();
    let mut options = Vec::with_capacity(args.options.len());
    for option in &args.options {
        let id = option.id.trim();
        let label = option.label.trim();
        if id.is_empty() {
            return Err(tool_failure("Option id cannot be empty."));
        }
        if label.is_empty() {
            return Err(tool_failure("Option label cannot be empty."));
        }
        if id.chars().count() > MAX_OPTION_ID_CHARS {
            return Err(tool_failure(format!(
                "Option id cannot exceed {MAX_OPTION_ID_CHARS} characters."
            )));
        }
        if label.chars().count() > MAX_OPTION_LABEL_CHARS {
            return Err(tool_failure(format!(
                "Option label cannot exceed {MAX_OPTION_LABEL_CHARS} characters."
            )));
        }
        if id == AGENT_DECIDE_OPTION_ID {
            return Err(tool_failure(format!(
                "Option id '{AGENT_DECIDE_OPTION_ID}' is reserved."
            )));
        }
        if !seen.insert(id.to_string()) {
            return Err(tool_failure(format!("Duplicate option id '{id}'.")));
        }
        options.push(AskQuestionOption {
            id: id.to_string(),
            label: label.to_string(),
        });
    }

    Ok(PreparedAskQuestion {
        question: question.to_string(),
        options,
    })
}

async fn create_agent_question(
    runtime: &RuntimeClient,
    run_id: &str,
    claim_id: &str,
    question: &str,
    options: &[AskQuestionOption],
    timeout_ms: u64,
) -> Result<CreateQuestionResponse, ToolExecutionError> {
    let mut args = BTreeMap::new();
    args.insert("runId".to_string(), run_id.to_string().into());
    args.insert("claimId".to_string(), claim_id.to_string().into());
    args.insert("question".to_string(), question.to_string().into());
    args.insert(
        "options".to_string(),
        Value::try_from(serde_json::to_value(options).map_err(|e| tool_error(e.into()))?)
            .map_err(tool_error)?,
    );
    args.insert("timeoutMs".to_string(), Value::Float64(timeout_ms as f64));
    runtime
        .mutation_json("agentQuestions:create", args)
        .await
        .map_err(tool_error)
}

async fn fetch_question_snapshot(
    runtime: &RuntimeClient,
    run_id: &str,
    question_id: &str,
) -> Result<Option<QuestionSnapshot>, ToolExecutionError> {
    let mut args = BTreeMap::new();
    args.insert("runId".to_string(), run_id.to_string().into());
    args.insert("questionId".to_string(), question_id.to_string().into());
    runtime
        .query_json(GET_QUESTION_FUNCTION, args)
        .await
        .map_err(tool_error)
}

fn pending_question_result(
    question_id: &str,
    question: &str,
    options: &[AskQuestionOption],
) -> serde_json::Value {
    json!({
        "questionId": question_id,
        "question": question,
        "options": options,
        "pending": true,
        "timedOut": false,
    })
}

fn question_result_from_snapshot(
    snapshot: &QuestionSnapshot,
) -> Result<serde_json::Value, ToolExecutionError> {
    match snapshot.status.as_str() {
        "pending" => Ok(pending_question_result(
            &snapshot.question_id,
            &snapshot.question,
            &snapshot.options,
        )),
        "answered" => Ok(json!({
            "questionId": snapshot.question_id,
            "question": snapshot.question,
            "options": snapshot.options,
            "pending": false,
            "timedOut": false,
            "answer": snapshot.answer,
        })),
        "timedOut" => Ok(json!({
            "questionId": snapshot.question_id,
            "question": snapshot.question,
            "options": snapshot.options,
            "pending": false,
            "timedOut": true,
        })),
        "cancelled" => Err(cancelled_error()),
        other => Err(tool_failure(format!(
            "Unexpected question status '{other}'"
        ))),
    }
}

async fn observe_question(
    runtime: &RuntimeClient,
    run_id: &str,
    question_id: &str,
    question: &str,
    options: &[AskQuestionOption],
    yield_time_ms: u64,
    cancellation: WorkspaceCancellation,
) -> Result<serde_json::Value, ToolExecutionError> {
    let mut args = BTreeMap::new();
    args.insert("runId".to_string(), run_id.to_string().into());
    args.insert("questionId".to_string(), question_id.to_string().into());
    let mut updates = runtime
        .subscribe(GET_QUESTION_FUNCTION, args)
        .await
        .map_err(tool_error)?;

    let deadline = if yield_time_ms == 0 {
        None
    } else {
        Some(Instant::now() + Duration::from_millis(yield_time_ms))
    };

    loop {
        if cancellation.is_cancelled() {
            return Err(cancelled_error());
        }

        let update = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(cancelled_error()),
            // Prefer subscription updates over the yield deadline so an answer/timeout
            // that arrives in the same tick is not reported as still pending.
            update = updates.next() => update,
            _ = async {
                if let Some(deadline) = deadline {
                    sleep(deadline.saturating_duration_since(Instant::now())).await;
                } else {
                    std::future::pending::<()>().await;
                }
            }, if deadline.is_some() => {
                // Last-chance read: an answer may have landed without the
                // subscription delivering before the yield deadline.
                if let Some(snapshot) =
                    fetch_question_snapshot(runtime, run_id, question_id).await?
                {
                    if snapshot.status != "pending" {
                        return question_result_from_snapshot(&snapshot);
                    }
                }
                return Ok(pending_question_result(question_id, question, options));
            },
        };

        let Some(update) = update else {
            return Err(tool_failure("question subscription closed"));
        };
        let snapshot: Option<QuestionSnapshot> =
            RuntimeClient::decode_subscription_update(update, GET_QUESTION_FUNCTION)
                .map_err(tool_error)?;
        let Some(snapshot) = snapshot else {
            return Err(tool_failure(format!("Unknown questionId '{question_id}'")));
        };
        if snapshot.status != "pending" {
            return question_result_from_snapshot(&snapshot);
        }
        if yield_time_ms == 0 {
            return Ok(pending_question_result(question_id, question, options));
        }
    }
}
