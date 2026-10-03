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
use tokio::sync::Mutex;
use tokio::time::{Instant, sleep_until};

use super::context::{AgentToolContext, cancelled_error, tool_error, tool_failure};
use super::job::execute_tool_job;
use crate::convex::RuntimeClient;

pub(super) const DEFAULT_ASK_QUESTION_YIELD_MS: u64 = 30_000;
pub(super) const DEFAULT_AWAIT_QUESTION_YIELD_MS: u64 = 30_000;
const MAX_QUESTION_YIELD_MS: u64 = 270_000;
const QUESTION_POLL_COOLDOWN: Duration = Duration::from_secs(30);
const QUESTION_POLL_COOLDOWN_ERROR: &str =
    "Please wait at least 30s between `await_question` calls with `yieldTimeMs` set to `0`.";
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

fn default_await_question_yield_ms() -> u64 {
    DEFAULT_AWAIT_QUESTION_YIELD_MS
}

fn is_default_ask_question_yield_ms(yield_time_ms: &u64) -> bool {
    *yield_time_ms == DEFAULT_ASK_QUESTION_YIELD_MS
}

fn is_default_await_question_yield_ms(yield_time_ms: &u64) -> bool {
    *yield_time_ms == DEFAULT_AWAIT_QUESTION_YIELD_MS
}

fn normalize_ask_yield_ms(yield_time_ms: u64) -> u64 {
    yield_time_ms.min(MAX_QUESTION_YIELD_MS)
}

fn normalize_await_yield_ms(yield_time_ms: u64) -> u64 {
    if yield_time_ms == 0 {
        0
    } else {
        yield_time_ms.clamp(DEFAULT_AWAIT_QUESTION_YIELD_MS, MAX_QUESTION_YIELD_MS)
    }
}

fn ask_question_parameters() -> serde_json::Value {
    let mut schema = json!(schemars::schema_for!(AskQuestionArgs));
    schema["properties"]["yieldTimeMs"] = json!({
        "type": "integer",
        "default": DEFAULT_ASK_QUESTION_YIELD_MS,
        "minimum": 0,
        "maximum": MAX_QUESTION_YIELD_MS,
        "description": "Maximum time to wait for completion before returning the tool call."
    });
    schema["properties"]["timeoutMs"] = json!({
        "type": ["integer", "null"],
        "minimum": 0,
        "description": "Maximum question lifetime. Without a limit, the question stays open until it is answered or cancelled."
    });
    schema
}

fn await_question_parameters() -> serde_json::Value {
    let mut schema = json!(schemars::schema_for!(AwaitQuestionArgs));
    schema["properties"]["yieldTimeMs"] = json!({
        "type": "integer",
        "default": DEFAULT_AWAIT_QUESTION_YIELD_MS,
        "anyOf": [
            { "type": "integer", "enum": [0] },
            { "type": "integer", "minimum": DEFAULT_AWAIT_QUESTION_YIELD_MS, "maximum": MAX_QUESTION_YIELD_MS }
        ],
        "description": "Maximum time to wait for an answer before returning the tool call. Zero returns an immediate question/status snapshot."
    });
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
        default = "default_ask_question_yield_ms",
        skip_serializing_if = "is_default_ask_question_yield_ms"
    )]
    #[schemars(default = "default_ask_question_yield_ms")]
    pub(crate) yield_time_ms: u64,
    #[serde(rename = "timeoutMs", default, skip_serializing_if = "Option::is_none")]
    pub(crate) timeout_ms: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct AwaitQuestionArgs {
    /// Question identifier returned by ask_question.
    #[serde(rename = "questionId")]
    #[schemars(length(min = 1))]
    pub(crate) question_id: String,
    /// Maximum time to wait for an answer or expiry before returning, in milliseconds. Use 0 for an immediate snapshot.
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
}

#[derive(Clone, Default)]
pub(super) struct QuestionPolls {
    questions: Arc<Mutex<HashMap<String, Arc<Mutex<Option<Instant>>>>>>,
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
        let mut last_poll = poll.lock().await;
        let snapshot = fetch().await?;
        if snapshot.status != "pending" {
            return question_result_from_snapshot(&snapshot);
        }
        let now = Instant::now();
        if last_poll.is_some_and(|last| now.duration_since(last) < QUESTION_POLL_COOLDOWN) {
            return Err(tool_failure(QUESTION_POLL_COOLDOWN_ERROR));
        }
        let result = question_result_from_snapshot(&snapshot)?;
        *last_poll = Some(now);
        Ok(result)
    }
}

impl rig::tool::Tool for AskQuestionTool {
    const NAME: &'static str = "ask_question";
    type Error = ToolExecutionError;
    type Args = AskQuestionArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        "Ask the user a multiple-choice question above the composer. With yieldTimeMs set to 0, create the question and return question/status metadata without an answer. Nonzero waits for an answer, expiry, or the wait budget, then returns the result including any answer. The question stays open unless timeoutMs sets a lifetime limit or the agent run is cancelled.".to_string()
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
        execute_tool_job(&self.0, Self::NAME, payload, |cancellation| {
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
                        if normalize_ask_yield_ms(args.yield_time_ms) == 0 {
                            return question_metadata_from_snapshot(&snapshot);
                        }
                        if snapshot.status != "pending" {
                            return question_result_from_snapshot(&snapshot);
                        }
                        observe_question(
                            &runtime, &run_id, &snapshot,
                            normalize_ask_yield_ms(args.yield_time_ms),
                        ).await
                    } => result,
                }
            }
        })
        .await
    }
}

impl rig::tool::Tool for AwaitQuestionTool {
    const NAME: &'static str = "await_question";
    type Error = ToolExecutionError;
    type Args = AwaitQuestionArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        "Read the current result of a question created by ask_question. Answered or expired questions return immediately. For pending questions, zero returns a snapshot subject to a per-question 30-second cooldown; nonzero waits for an answer or expiry, up to the wait budget."
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
        execute_tool_job(&self.0, Self::NAME, payload, |cancellation| {
            let runtime = self.0.runtime.clone();
            let run_id = self.0.run_id.clone();
            let question_id = args.question_id.clone();
            async move {
                tokio::select! {
                    biased;
                    _ = cancellation.cancelled() => Err(cancelled_error()),
                    result = async {
                        let snapshot = fetch_question_snapshot(&runtime, &run_id, &question_id).await?;
                        if snapshot.status != "pending" {
                            return question_result_from_snapshot(&snapshot);
                        }
                        if normalize_await_yield_ms(args.yield_time_ms) == 0 {
                            return self.0.question_polls.observe_pending(&question_id, || {
                                fetch_question_snapshot(&runtime, &run_id, &question_id)
                            }).await;
                        }
                        observe_question(
                            &runtime, &run_id, &snapshot,
                            normalize_await_yield_ms(args.yield_time_ms),
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

fn question_metadata_from_snapshot(
    snapshot: &QuestionSnapshot,
) -> Result<serde_json::Value, ToolExecutionError> {
    let mut result = question_result_from_snapshot(snapshot)?;
    result.as_object_mut().unwrap().remove("answer");
    Ok(result)
}

fn question_result_from_snapshot(
    snapshot: &QuestionSnapshot,
) -> Result<serde_json::Value, ToolExecutionError> {
    let mut result = json!({
        "questionId": snapshot.question_id,
        "question": snapshot.question,
        "options": snapshot.options,
        "pending": snapshot.status == "pending",
        "timedOut": snapshot.status == "timedOut",
    });
    match snapshot.status.as_str() {
        "pending" | "timedOut" => Ok(result),
        "answered" => {
            result["answer"] = json!(snapshot.answer);
            Ok(result)
        }
        "cancelled" => Err(cancelled_error()),
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
    let deadline = Instant::now() + Duration::from_millis(yield_time_ms);
    let mut args = BTreeMap::new();
    args.insert("runId".to_string(), run_id.to_string().into());
    args.insert(
        "questionId".to_string(),
        snapshot.question_id.clone().into(),
    );
    let mut updates = runtime
        .subscribe(GET_QUESTION_FUNCTION, args)
        .await
        .map_err(tool_error)?;

    let decoded = updates.by_ref().map(|update| {
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
mod tests {
    use super::*;

    #[test]
    fn ask_yield_normalization_preserves_zero_and_caps_oversized_values() {
        assert_eq!(normalize_ask_yield_ms(0), 0);
        assert_eq!(
            normalize_ask_yield_ms(DEFAULT_ASK_QUESTION_YIELD_MS),
            30_000
        );
        assert_eq!(normalize_ask_yield_ms(1), 1);
        assert_eq!(normalize_ask_yield_ms(MAX_QUESTION_YIELD_MS), 270_000);
        assert_eq!(normalize_ask_yield_ms(1_800_000), 270_000);
        assert_eq!(normalize_ask_yield_ms(u64::MAX), 270_000);
    }

    #[test]
    fn await_yield_normalization_preserves_zero_and_clamps_oversized_values() {
        assert_eq!(normalize_await_yield_ms(0), 0);
        assert_eq!(normalize_await_yield_ms(1), 30_000);
        assert_eq!(
            normalize_await_yield_ms(DEFAULT_AWAIT_QUESTION_YIELD_MS),
            30_000
        );
        assert_eq!(normalize_await_yield_ms(MAX_QUESTION_YIELD_MS), 270_000);
        assert_eq!(normalize_await_yield_ms(1_800_000), 270_000);
        assert_eq!(normalize_await_yield_ms(u64::MAX), 270_000);
    }

    fn snapshot(question_id: &str, status: &str) -> QuestionSnapshot {
        QuestionSnapshot {
            question_id: question_id.to_string(),
            question: "Which configuration?".to_string(),
            options: vec![AskQuestionOption {
                id: "safe".to_string(),
                label: "Use the safe default".to_string(),
            }],
            status: status.to_string(),
            answer: (status == "answered").then(|| QuestionAnswer {
                option_id: Some("safe".to_string()),
                option_label: Some("Use the safe default".to_string()),
                text: None,
            }),
        }
    }

    #[test]
    fn question_parameters_expose_optional_expiry_and_bounded_waits() {
        let ask = ask_question_parameters();
        assert_eq!(ask["required"], json!(["question", "options"]));
        assert_eq!(ask["additionalProperties"], false);
        assert!(ask["properties"]["question"].get("description").is_none());
        assert_eq!(ask["properties"]["options"]["minItems"], 1);
        assert_eq!(ask["properties"]["options"]["maxItems"], 4);
        assert_eq!(
            ask["properties"]["options"]["description"],
            "Answer options. A \"Let me (the agent) decide\" option is added automatically."
        );
        let option = &ask["$defs"]["AskQuestionOption"];
        assert_eq!(option["additionalProperties"], false);
        assert!(option["properties"]["label"].get("description").is_none());
        assert_eq!(option["properties"]["id"]["maxLength"], 20);
        let yield_ms = &ask["properties"]["yieldTimeMs"];
        assert_eq!(yield_ms["default"], 30_000);
        assert_eq!(yield_ms["minimum"], 0);
        assert_eq!(yield_ms["maximum"], 270_000);
        let timeout = &ask["properties"]["timeoutMs"];
        assert_eq!(timeout["type"], json!(["integer", "null"]));
        assert_eq!(timeout["minimum"], 0);
        assert!(timeout.get("default").is_none());
        assert!(timeout.get("maximum").is_none());
        let await_schema = await_question_parameters();
        assert_eq!(await_schema["required"], json!(["questionId"]));
        assert_eq!(await_schema["properties"]["yieldTimeMs"]["default"], 30_000);
        assert_eq!(
            await_schema["properties"]["yieldTimeMs"]["anyOf"],
            json!([
                { "type": "integer", "enum": [0] },
                { "type": "integer", "minimum": 30_000, "maximum": 270_000 }
            ])
        );
    }

    #[test]
    fn ask_args_accept_absent_null_and_historical_numeric_timeouts() {
        for timeout in [
            None,
            Some(json!(null)),
            Some(json!(0)),
            Some(json!(1_800_000)),
        ] {
            let mut payload = json!({
                "question": "Which configuration?",
                "options": [{ "id": "safe", "label": "Use the safe default" }],
            });
            if let Some(timeout) = timeout {
                payload["timeoutMs"] = timeout;
            }
            let args: AskQuestionArgs = serde_json::from_value(payload.clone()).unwrap();
            assert_eq!(args.yield_time_ms, 30_000);
            assert_eq!(args.timeout_ms, payload["timeoutMs"].as_u64());
        }
    }

    #[test]
    fn zero_ask_preserves_terminal_metadata_and_durable_answer() {
        let answered = snapshot("q1", "answered");
        let metadata = question_metadata_from_snapshot(&answered).unwrap();
        assert_eq!(metadata["questionId"], "q1");
        assert_eq!(metadata["pending"], false);
        assert_eq!(metadata["timedOut"], false);
        assert!(metadata.get("answer").is_none());
        for _ in 0..2 {
            let result = question_result_from_snapshot(&answered).unwrap();
            assert_eq!(result["answer"]["optionId"], "safe");
        }
        let expired = question_metadata_from_snapshot(&snapshot("q2", "timedOut")).unwrap();
        assert_eq!(expired["questionId"], "q2");
        assert_eq!(expired["timedOut"], true);
    }

    #[tokio::test(start_paused = true)]
    async fn pending_zero_polls_are_atomic_per_question_and_rejections_do_not_reset_them() {
        let polls = QuestionPolls::default();
        let concurrent_polls = polls.clone();
        let fetch = || async { Ok(snapshot("q1", "pending")) };
        let (first, second) = tokio::join!(
            polls.observe_pending("q1", fetch),
            concurrent_polls.observe_pending("q1", fetch),
        );
        assert!(first.is_ok());
        assert_eq!(
            second.unwrap_err().to_string(),
            QUESTION_POLL_COOLDOWN_ERROR
        );
        assert!(
            polls
                .observe_pending("q2", || async { Ok(snapshot("q2", "pending")) })
                .await
                .is_ok()
        );
        tokio::time::advance(Duration::from_secs(29)).await;
        assert_eq!(
            polls
                .observe_pending("q1", fetch)
                .await
                .unwrap_err()
                .to_string(),
            QUESTION_POLL_COOLDOWN_ERROR
        );
        tokio::time::advance(Duration::from_secs(1)).await;
        assert!(polls.observe_pending("q1", fetch).await.is_ok());
    }

    #[tokio::test(start_paused = true)]
    async fn terminal_and_failed_reads_do_not_change_pending_poll_timestamp() {
        let polls = QuestionPolls::default();
        polls
            .observe_pending("q1", || async { Ok(snapshot("q1", "pending")) })
            .await
            .unwrap();
        tokio::time::advance(Duration::from_secs(29)).await;
        for status in ["answered", "timedOut"] {
            for _ in 0..2 {
                let result = polls
                    .observe_pending("q1", || async { Ok(snapshot("q1", status)) })
                    .await
                    .unwrap();
                assert_eq!(result["pending"], false);
            }
        }
        assert!(
            polls
                .observe_pending("q1", || async { Err(tool_failure("query failed")) })
                .await
                .is_err()
        );
        tokio::time::advance(Duration::from_secs(1)).await;
        assert!(
            polls
                .observe_pending("q1", || async { Ok(snapshot("q1", "pending")) })
                .await
                .is_ok()
        );
    }

    #[tokio::test(start_paused = true)]
    async fn contending_zero_poll_rechecks_terminal_state() {
        let polls = QuestionPolls::default();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let first_polls = polls.clone();
        let first = tokio::spawn(async move {
            first_polls
                .observe_pending("q1", || async {
                    started_tx.send(()).unwrap();
                    release_rx.await.unwrap();
                    Ok(snapshot("q1", "pending"))
                })
                .await
        });
        started_rx.await.unwrap();
        let second = tokio::spawn(async move {
            polls
                .observe_pending("q1", || async { Ok(snapshot("q1", "answered")) })
                .await
        });
        tokio::task::yield_now().await;
        release_tx.send(()).unwrap();
        first.await.unwrap().unwrap();
        let result = second.await.unwrap().unwrap();
        assert_eq!(result["answer"]["optionId"], "safe");
    }

    #[tokio::test(start_paused = true)]
    async fn pending_updates_keep_waiting_until_answer() {
        let initial = snapshot("q1", "pending");
        let (tx, mut rx) = futures::channel::mpsc::unbounded();
        let wait = wait_for_question_updates(
            &mut rx,
            &initial,
            Instant::now() + Duration::from_secs(30),
            || async {
                panic!("answer should end wait before deadline");
            },
        );
        tokio::pin!(wait);
        tx.unbounded_send(Ok(Some(initial.clone()))).unwrap();
        tokio::select! {
            result = &mut wait => panic!("pending update ended wait: {result:?}"),
            _ = tokio::task::yield_now() => {}
        }
        tokio::time::advance(Duration::from_secs(2)).await;
        tx.unbounded_send(Ok(Some(snapshot("q1", "answered"))))
            .unwrap();
        assert_eq!(wait.await.unwrap()["answer"]["optionId"], "safe");
    }

    #[tokio::test(start_paused = true)]
    async fn wait_deadline_performs_an_authoritative_read() {
        let initial = snapshot("q1", "pending");
        for status in ["pending", "answered", "timedOut"] {
            let mut updates = futures::stream::pending();
            let result = wait_for_question_updates(
                &mut updates,
                &initial,
                Instant::now() + Duration::from_millis(5),
                || async { Ok(snapshot("q1", status)) },
            )
            .await
            .unwrap();
            assert_eq!(result["pending"], status == "pending");
            assert_eq!(result["timedOut"], status == "timedOut");
        }
    }
}
