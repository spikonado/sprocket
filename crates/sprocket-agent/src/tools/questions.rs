use std::collections::{BTreeMap, HashMap, HashSet};
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use convex::Value;
use futures::{Stream, StreamExt};
use rig::tool::ToolExecutionError;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sprocket_workspace::async_tools::ZeroPollCooldown;
use tokio::sync::Mutex;
use tokio::time::{Instant, sleep_until};

use super::async_tools::{YieldMode, default_yield_ms, is_default_yield_ms, yield_time_schema};
use super::context::{AgentToolContext, cancelled_error, cancelled_read, tool_error, tool_failure};
use super::job::{execute_serialized_tool_job, execute_tool_job_with_id};
use crate::convex::RuntimeClient;

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
pub(crate) struct PollQuestionTool(pub(super) AgentToolContext);

fn ask_question_parameters(max_yield_ms: u64) -> serde_json::Value {
    with_question_waits(json!(schemars::schema_for!(AskQuestionArgs)), max_yield_ms)
}

pub(super) fn with_question_waits(
    mut schema: serde_json::Value,
    max_yield_ms: u64,
) -> serde_json::Value {
    schema["properties"]["yieldTimeMs"] = yield_time_schema(
        YieldMode::Action,
        max_yield_ms,
        "Maximum time to wait for completion before returning the tool call.",
    );
    schema["properties"]["timeoutMs"] = json!({
        "type": ["integer", "null"],
        "minimum": 0,
        "description": "Close the question unanswered after this long."
    });
    schema
}

fn poll_question_parameters(max_yield_ms: u64) -> serde_json::Value {
    let mut schema = json!(schemars::schema_for!(PollQuestionArgs));
    schema["properties"]["yieldTimeMs"] = yield_time_schema(
        YieldMode::Poll,
        max_yield_ms,
        "Maximum time to wait for an answer before returning the tool call. Zero returns an immediate status/answer snapshot.",
    );
    schema
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct AskQuestionOption {
    #[schemars(length(min = 1, max = 20))]
    pub(crate) id: String,
    #[schemars(length(min = 1, max = 200))]
    pub(crate) label: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct AskQuestionArgs {
    #[schemars(length(min = 1, max = 2000))]
    pub(crate) question: String,
    /// Answer options. A "Let me (the agent) decide" option is added automatically.
    #[schemars(length(min = 1, max = 4))]
    pub(crate) options: Vec<AskQuestionOption>,
    #[serde(
        rename = "yieldTimeMs",
        default = "default_yield_ms",
        skip_serializing_if = "is_default_yield_ms"
    )]
    #[schemars(default = "default_yield_ms")]
    pub(crate) yield_time_ms: u64,
    #[serde(rename = "timeoutMs", default, skip_serializing_if = "Option::is_none")]
    pub(crate) timeout_ms: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct PollQuestionArgs {
    /// From ask_question.
    #[serde(rename = "questionId")]
    #[schemars(length(min = 1))]
    pub(crate) question_id: String,
    #[serde(
        rename = "yieldTimeMs",
        default = "default_yield_ms",
        skip_serializing_if = "is_default_yield_ms"
    )]
    #[schemars(default = "default_yield_ms")]
    pub(crate) yield_time_ms: u64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct QuestionAnswer {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) option_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) text: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct QuestionSnapshot {
    pub(super) question_id: String,
    pub(super) status: String,
    pub(super) answer: Option<QuestionAnswer>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateQuestionResponse {
    question_id: String,
}

#[derive(Clone, Default)]
pub(super) struct QuestionPolls {
    questions: Arc<Mutex<HashMap<String, Arc<Mutex<ZeroPollCooldown>>>>>,
}

impl QuestionPolls {
    async fn observe_pending<F, Fut>(
        &self,
        question_id: &str,
        fetch: F,
    ) -> Result<serde_json::Value, ToolExecutionError>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<QuestionSnapshot, ToolExecutionError>>,
    {
        let poll = self
            .questions
            .lock()
            .await
            .entry(question_id.to_string())
            .or_default()
            .clone();
        let mut cooldown = poll.lock().await;
        let snapshot = fetch().await?;
        cooldown
            .observe(
                snapshot.status == "pending",
                |error| tool_failure(error.message("Question is still awaiting an answer.")),
                async { question_result_from_snapshot(&snapshot) },
            )
            .await
    }
}

impl rig::tool::Tool for AskQuestionTool {
    const NAME: &'static str = "ask_question";
    type Error = ToolExecutionError;
    type Args = AskQuestionArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        "Ask the user a question. If you end your turn first, the answer starts a new turn."
            .to_string()
    }

    fn parameters(&self) -> serde_json::Value {
        ask_question_parameters(self.0.max_yield_ms)
    }

    async fn call(
        &self,
        _context: &mut rig::tool::ToolContext,
        args: Self::Args,
    ) -> Result<Self::Output, Self::Error> {
        let question = prepare_ask_question(&args)?;
        let yield_time_ms = YieldMode::Action.normalize(args.yield_time_ms, self.0.max_yield_ms);
        let payload = serde_json::to_value(&args).map_err(|e| tool_error(e.into()))?;
        execute_tool_job_with_id(&self.0, Self::NAME, payload, |cancellation, job_id| {
            let context = self.0.clone();
            async move {
                cancelled_read(
                    &cancellation,
                    ask_and_observe(&context, &job_id, &question, yield_time_ms),
                )
                .await
            }
        })
        .await
    }
}

impl rig::tool::Tool for PollQuestionTool {
    const NAME: &'static str = "poll_question";
    type Error = ToolExecutionError;
    type Args = PollQuestionArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        "Read the current result of a question.".to_string()
    }

    fn parameters(&self) -> serde_json::Value {
        poll_question_parameters(self.0.max_yield_ms)
    }

    async fn call(
        &self,
        _context: &mut rig::tool::ToolContext,
        args: Self::Args,
    ) -> Result<Self::Output, Self::Error> {
        if args.question_id.trim().is_empty() {
            return Err(tool_failure("questionId cannot be empty"));
        }
        let yield_time_ms = YieldMode::Poll.normalize(args.yield_time_ms, self.0.max_yield_ms);
        execute_serialized_tool_job(&self.0, Self::NAME, &args, |cancellation| {
            let runtime = self.0.runtime.clone();
            let run_id = self.0.run_id.clone();
            let question_id = args.question_id.clone();
            async move {
                tokio::select! {
                    biased;
                    _ = cancellation.cancelled() => Err(cancelled_error()),
                    result = async {
                        if yield_time_ms == 0 {
                            return self.0.question_polls.observe_pending(&question_id, || {
                                fetch_question_snapshot(&runtime, &run_id, &question_id)
                            }).await;
                        }
                        let snapshot = fetch_question_snapshot(&runtime, &run_id, &question_id).await?;
                        observe_question(
                            &runtime, &run_id, &snapshot,
                            yield_time_ms,
                        ).await
                    } => result,
                }
            }
        })
        .await
    }
}

#[derive(Clone, Debug)]
pub(super) struct NewQuestion {
    pub(super) question: String,
    pub(super) options: Vec<AskQuestionOption>,
    pub(super) timeout_ms: Option<u64>,
    pub(super) detail: Option<serde_json::Value>,
}

pub(super) fn prepare_ask_question(
    args: &AskQuestionArgs,
) -> Result<NewQuestion, ToolExecutionError> {
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

    Ok(NewQuestion {
        question: question.to_string(),
        options,
        timeout_ms: args.timeout_ms,
        detail: None,
    })
}

/// Creates the question and waits up to `yield_time_ms` for an answer, returning `ask_question`'s result.
pub(super) async fn ask_and_observe(
    context: &AgentToolContext,
    job_id: &str,
    question: &NewQuestion,
    yield_time_ms: u64,
) -> Result<serde_json::Value, ToolExecutionError> {
    let snapshot = create_agent_question(context, job_id, question).await?;
    let result =
        observe_question(&context.runtime, &context.run_id, &snapshot, yield_time_ms).await?;
    Ok(question_creation_result(
        result,
        &snapshot.question_id,
        yield_time_ms,
    ))
}

/// Creates the question and waits until it leaves `pending`.
pub(super) async fn ask_and_settle(
    context: &AgentToolContext,
    job_id: &str,
    question: &NewQuestion,
) -> Result<QuestionSnapshot, ToolExecutionError> {
    let snapshot = create_agent_question(context, job_id, question).await?;
    settle_question(&context.runtime, &context.run_id, &snapshot, None).await
}

async fn create_agent_question(
    context: &AgentToolContext,
    job_id: &str,
    question: &NewQuestion,
) -> Result<QuestionSnapshot, ToolExecutionError> {
    let mut args = BTreeMap::new();
    args.insert("runId".to_string(), context.run_id.clone().into());
    args.insert("claimId".to_string(), context.claim_id.clone().into());
    args.insert("jobId".to_string(), job_id.to_string().into());
    args.insert("question".to_string(), question.question.clone().into());
    args.insert(
        "options".to_string(),
        Value::try_from(serde_json::to_value(&question.options).map_err(|e| tool_error(e.into()))?)
            .map_err(tool_error)?,
    );
    if let Some(timeout_ms) = question.timeout_ms {
        args.insert("timeoutMs".to_string(), Value::Float64(timeout_ms as f64));
    }
    if let Some(detail) = &question.detail {
        args.insert(
            "detail".to_string(),
            Value::try_from(detail.clone()).map_err(tool_error)?,
        );
    }
    let created: CreateQuestionResponse = context
        .runtime
        .mutation_json("agentQuestions:createWithOptionalExpiry", args)
        .await
        .map_err(tool_error)?;
    fetch_question_snapshot(&context.runtime, &context.run_id, &created.question_id).await
}

async fn fetch_question_snapshot(
    runtime: &RuntimeClient,
    run_id: &str,
    question_id: &str,
) -> Result<QuestionSnapshot, ToolExecutionError> {
    let mut args = BTreeMap::new();
    args.insert("runId".to_string(), run_id.to_string().into());
    args.insert("questionId".to_string(), question_id.to_string().into());
    let snapshot: Option<QuestionSnapshot> = runtime
        .query_json(GET_QUESTION_FUNCTION, args)
        .await
        .map_err(tool_error)?;
    snapshot.ok_or_else(|| tool_failure(format!("Unknown questionId '{question_id}'")))
}

fn question_creation_result(
    mut result: serde_json::Value,
    question_id: &str,
    yield_time_ms: u64,
) -> serde_json::Value {
    if yield_time_ms == 0 {
        result.as_object_mut().unwrap().remove("answer");
    }
    result["questionId"] = json!(question_id);
    result
}

fn question_result_from_snapshot(
    snapshot: &QuestionSnapshot,
) -> Result<serde_json::Value, ToolExecutionError> {
    match snapshot.status.as_str() {
        status @ ("pending" | "timedOut" | "skipped") => Ok(json!({ "status": status })),
        "answered" => Ok(json!({ "status": "answered", "answer": snapshot.answer })),
        "cancelled" => Err(tool_failure(
            "Question was cancelled before it was answered.",
        )),
        other => Err(tool_failure(format!(
            "Unexpected question status '{other}'"
        ))),
    }
}

async fn observe_question(
    runtime: &RuntimeClient,
    run_id: &str,
    snapshot: &QuestionSnapshot,
    yield_time_ms: u64,
) -> Result<serde_json::Value, ToolExecutionError> {
    if yield_time_ms == 0 || snapshot.status != "pending" {
        return question_result_from_snapshot(snapshot);
    }
    let deadline = Instant::now() + Duration::from_millis(yield_time_ms);
    question_result_from_snapshot(
        &settle_question(runtime, run_id, snapshot, Some(deadline)).await?,
    )
}

/// Waits until the question leaves `pending`, or for the deadline's authoritative read.
async fn settle_question(
    runtime: &RuntimeClient,
    run_id: &str,
    snapshot: &QuestionSnapshot,
    deadline: Option<Instant>,
) -> Result<QuestionSnapshot, ToolExecutionError> {
    if snapshot.status != "pending" {
        return Ok(snapshot.clone());
    }
    let mut args = BTreeMap::new();
    args.insert("runId".to_string(), run_id.to_string().into());
    args.insert(
        "questionId".to_string(),
        snapshot.question_id.clone().into(),
    );
    let updates = runtime
        .subscribe(GET_QUESTION_FUNCTION, args)
        .await
        .map_err(tool_error)?;

    let decoded = updates.map(|update| {
        RuntimeClient::decode_subscription_update::<Option<QuestionSnapshot>>(
            update,
            GET_QUESTION_FUNCTION,
        )
        .map_err(tool_error)
    });
    tokio::pin!(decoded);
    wait_for_question_updates(&mut decoded, snapshot, deadline, || {
        fetch_question_snapshot(runtime, run_id, &snapshot.question_id)
    })
    .await
}

async fn wait_for_question_updates<S, F, Fut>(
    updates: &mut S,
    initial: &QuestionSnapshot,
    deadline: Option<Instant>,
    fetch: F,
) -> Result<QuestionSnapshot, ToolExecutionError>
where
    S: Stream<Item = Result<Option<QuestionSnapshot>, ToolExecutionError>> + Unpin,
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<QuestionSnapshot, ToolExecutionError>>,
{
    let deadline_reached = async {
        match deadline {
            Some(deadline) => sleep_until(deadline).await,
            None => std::future::pending().await,
        }
    };
    tokio::pin!(deadline_reached);
    loop {
        if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
            return fetch().await;
        }
        let update = tokio::select! {
            biased;
            update = updates.next() => update,
            _ = &mut deadline_reached => return fetch().await,
        };

        let Some(update) = update else {
            return Err(tool_failure("question subscription closed"));
        };
        let Some(snapshot) = update? else {
            return Err(tool_failure(format!(
                "Unknown questionId '{}'",
                initial.question_id
            )));
        };
        if snapshot.status != "pending" {
            return Ok(snapshot);
        }
    }
}

#[cfg(test)]
mod tests;
