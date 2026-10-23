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
use sprocket_workspace::async_tools::{YieldMode, ZeroPollCooldown};
use tokio::sync::Mutex;
use tokio::time::{Instant, sleep_until};

use super::async_tools::{default_yield_ms, is_default_yield_ms, yield_time_schema};
use super::context::{AgentToolContext, cancelled_error, tool_error, tool_failure};
use super::job::execute_serialized_tool_job;
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

fn ask_question_parameters() -> serde_json::Value {
    let mut schema = json!(schemars::schema_for!(AskQuestionArgs));
    schema["properties"]["yieldTimeMs"] = yield_time_schema(
        YieldMode::Action,
        "Maximum time to wait for completion before returning the tool call.",
    );
    schema["properties"]["timeoutMs"] = json!({
        "type": ["integer", "null"],
        "minimum": 0,
        "description": "Maximum question lifetime. Without a limit, the question stays open until it is answered or cancelled."
    });
    schema
}

fn poll_question_parameters() -> serde_json::Value {
    let mut schema = json!(schemars::schema_for!(PollQuestionArgs));
    schema["properties"]["yieldTimeMs"] = yield_time_schema(
        YieldMode::Poll,
        "Maximum time to wait for an answer before returning the tool call. Zero returns an immediate status/answer snapshot.",
    );
    schema
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct AskQuestionOption {
    /// Stable option identifier returned with the user's answer.
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
    /// Maximum time to wait for an answer before returning, in milliseconds. Use 0 to return immediately.
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
    /// Question identifier returned by ask_question.
    #[serde(rename = "questionId")]
    #[schemars(length(min = 1))]
    pub(crate) question_id: String,
    /// Maximum time to wait for an answer or expiry before returning, in milliseconds. Use 0 for an immediate snapshot.
    #[serde(
        rename = "yieldTimeMs",
        default = "default_yield_ms",
        skip_serializing_if = "is_default_yield_ms"
    )]
    #[schemars(default = "default_yield_ms")]
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
    status: String,
    answer: Option<QuestionAnswer>,
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
        if snapshot.status != "pending" {
            return question_result_from_snapshot(&snapshot);
        }
        cooldown.check().map_err(|error| {
            tool_failure(error.message("Question is still awaiting an answer."))
        })?;
        let result = question_result_from_snapshot(&snapshot)?;
        cooldown.record_success();
        Ok(result)
    }
}

impl rig::tool::Tool for AskQuestionTool {
    const NAME: &'static str = "ask_question";
    type Error = ToolExecutionError;
    type Args = AskQuestionArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        "Ask the user a question.".to_string()
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
        let yield_time_ms = YieldMode::Action.normalize(args.yield_time_ms);
        execute_serialized_tool_job(&self.0, Self::NAME, &args, |cancellation| {
            let runtime = self.0.runtime.clone();
            let run_id = self.0.run_id.clone();
            let claim_id = self.0.claim_id.clone();
            async move {
                tokio::select! {
                    biased;
                    _ = cancellation.cancelled() => Err(cancelled_error()),
                    result = async {
                        let created = create_agent_question(
                            &runtime, &run_id, &claim_id, &prepared.question,
                            &prepared.options, args.timeout_ms,
                        ).await?;
                        let snapshot = fetch_question_snapshot(&runtime, &run_id, &created.question_id).await?;
                        let result = observe_question(&runtime, &run_id, &snapshot, yield_time_ms).await?;
                        Ok(question_creation_result(result, &created.question_id, yield_time_ms))
                    } => result,
                }
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
        poll_question_parameters()
    }

    async fn call(
        &self,
        _context: &mut rig::tool::ToolContext,
        args: Self::Args,
    ) -> Result<Self::Output, Self::Error> {
        if args.question_id.trim().is_empty() {
            return Err(tool_failure("questionId cannot be empty"));
        }
        let yield_time_ms = YieldMode::Poll.normalize(args.yield_time_ms);
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
    timeout_ms: Option<u64>,
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
    if let Some(timeout_ms) = timeout_ms {
        args.insert("timeoutMs".to_string(), Value::Float64(timeout_ms as f64));
    }
    runtime
        .mutation_json("agentQuestions:createWithOptionalExpiry", args)
        .await
        .map_err(tool_error)
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
    let mut result = json!({
        "pending": snapshot.status == "pending",
        "timedOut": snapshot.status == "timedOut",
    });
    match snapshot.status.as_str() {
        "pending" | "timedOut" => Ok(result),
        "answered" => {
            result["answer"] = json!(snapshot.answer);
            Ok(result)
        }
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
    deadline: Instant,
    fetch: F,
) -> Result<serde_json::Value, ToolExecutionError>
where
    S: Stream<Item = Result<Option<QuestionSnapshot>, ToolExecutionError>> + Unpin,
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<QuestionSnapshot, ToolExecutionError>>,
{
    loop {
        if Instant::now() >= deadline {
            return question_result_from_snapshot(&fetch().await?);
        }
        let update = tokio::select! {
            biased;
            update = updates.next() => update,
            _ = sleep_until(deadline) => {
                return question_result_from_snapshot(&fetch().await?);
            },
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
            return question_result_from_snapshot(&snapshot);
        }
    }
}

#[cfg(test)]
mod tests;
