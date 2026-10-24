use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use convex::Value;
use hmac::{Hmac, KeyInit, Mac};
use rig::tool::ToolExecutionError;
use schemars::JsonSchema;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sprocket_workspace::{WorkspaceCancellation, async_tools::ZeroPollCooldown};
use tokio::sync::Mutex;
use tokio::time::{Instant, sleep, timeout};

use super::async_tools::{YieldMode, default_yield_ms, is_default_yield_ms, yield_time_schema};
use super::context::{AgentToolContext, cancelled_error, tool_error, tool_failure};
use super::job::execute_tool_job_with_id;
use crate::catalog::ProviderCatalog;
use crate::convex::MutationFailure;
use crate::subagents::{
    CreateSubagentRunResponse, ResolvedSubagentSettings, SharedSubagentLauncher,
    SubagentControlResponse, SubagentLaunchRequest, SubagentListPage, SubagentMonitorInfo,
    SubagentSettingsOverrides, SubagentThreadSnapshot, resolve_settings_for_target,
    resolve_subagent_settings,
};
use crate::submission::{SUBMISSION_ATTEMPT_TIMEOUT, submission_is_waiting, wait_until_ready};
use crate::types::CompletionProvider;

const CREATE_OR_SEND: &str = "subagents:createOrSend";
const RECOVER_SUBMISSION: &str = "subagents:recoverSubmission";
const SNAPSHOT: &str = "subagents:snapshot";
const MONITOR_INFO: &str = "subagents:threadMonitorInfo";
const TRANSCRIPT_PARTS_PAGE: &str = "subagents:transcriptPartsPage";
const CONTROL: &str = "subagents:control";
const LIST_CHILDREN: &str = "subagents:listChildren";

const SUBAGENT_LIST_PAGE_SIZE: u32 = 32;
const WAIT_POLL_INTERVAL: Duration = Duration::from_millis(500);
const CONTROL_MAX_ATTEMPTS: usize = 3;
const CONTROL_INITIAL_RETRY_DELAY: Duration = Duration::from_millis(250);

#[derive(Clone)]
pub(crate) struct SpawnSubagentTool {
    pub(super) context: AgentToolContext,
}

#[derive(Clone)]
pub(crate) struct ControlSubagentTool {
    pub(super) context: AgentToolContext,
}

#[derive(Clone)]
pub(crate) struct PollSubagentTool {
    pub(super) context: AgentToolContext,
}

#[derive(Clone)]
pub(crate) struct ListSubagentsTool {
    pub(super) context: AgentToolContext,
}

#[derive(Clone)]
pub(crate) struct ListSubagentModelsTool(pub(super) AgentToolContext);

#[derive(Clone, Default)]
pub(super) struct SubagentPolls {
    threads: Arc<Mutex<HashMap<String, Arc<Mutex<ZeroPollCooldown>>>>>,
}

impl SubagentPolls {
    async fn observe_pending<F, Fut, R, Read>(
        &self,
        thread_id: &str,
        fetch: F,
        read: R,
    ) -> Result<serde_json::Value, ToolExecutionError>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<SubagentMonitorInfo, ToolExecutionError>>,
        R: FnOnce(SubagentMonitorInfo) -> Read,
        Read: Future<Output = Result<serde_json::Value, ToolExecutionError>>,
    {
        let poll = self
            .threads
            .lock()
            .await
            .entry(thread_id.to_string())
            .or_default()
            .clone();
        let mut cooldown = poll.lock().await;
        let info = fetch().await?;
        let active = info.active;
        if active {
            cooldown
                .check()
                .map_err(|error| tool_failure(error.message("Subagent is still active.")))?;
        }
        let result = read(info).await?;
        if active {
            cooldown.record_success();
        }
        Ok(result)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct SpawnSubagentArgs {
    pub(crate) prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) reasoning: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) fast: Option<bool>,
    /// Maximum time to wait for completion before returning the tool call.
    #[serde(
        rename = "yieldTimeMs",
        default = "default_yield_ms",
        skip_serializing_if = "is_default_yield_ms"
    )]
    #[schemars(default = "default_yield_ms")]
    pub(crate) yield_time_ms: u64,
    /// Maximum execution runtime. Without a limit, the subagent runs until it completes or is stopped.
    #[serde(rename = "timeoutMs", default, skip_serializing_if = "Option::is_none")]
    pub(crate) timeout_ms: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct PollSubagentArgs {
    /// Descendant thread to observe.
    #[serde(rename = "threadId")]
    pub(crate) thread_id: String,
    /// Opaque cursor from a previous poll response. Omit to start at the
    /// beginning. Reads are non-destructive.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) cursor: Option<String>,
    /// Maximum time to wait for completion before returning the tool call. Zero returns an immediate status/output snapshot.
    #[serde(
        rename = "yieldTimeMs",
        default = "default_yield_ms",
        skip_serializing_if = "is_default_yield_ms"
    )]
    #[schemars(default = "default_yield_ms")]
    pub(crate) yield_time_ms: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SubagentControlAction {
    Send,
    Stop,
    AnswerQuestion,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct ControlSubagentArgs {
    /// Descendant thread to control.
    #[serde(rename = "threadId")]
    pub(crate) thread_id: String,
    pub(crate) action: SubagentControlAction,
    /// Follow-up prompt for send. Stop the current run or wait for it to finish before sending.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) reasoning: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) fast: Option<bool>,
    /// Maximum execution runtime for send. Without a limit, the subagent runs until it completes or is stopped.
    #[serde(rename = "timeoutMs", default, skip_serializing_if = "Option::is_none")]
    pub(crate) timeout_ms: Option<u64>,
    #[serde(
        rename = "questionId",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) question_id: Option<String>,
    #[serde(rename = "optionId", default, skip_serializing_if = "Option::is_none")]
    pub(crate) option_id: Option<String>,
    /// Free-text answer or annotation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) text: Option<String>,
    /// Maximum time to wait for completion before returning the tool call.
    #[serde(
        rename = "yieldTimeMs",
        default = "default_yield_ms",
        skip_serializing_if = "is_default_yield_ms"
    )]
    #[schemars(default = "default_yield_ms")]
    pub(crate) yield_time_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
pub(crate) struct ListSubagentsArgs {
    /// Parent whose immediate children are listed. Defaults to this thread;
    /// any descendant of this thread is allowed.
    #[serde(
        rename = "parentThreadId",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) parent_thread_id: Option<String>,
    /// Pagination cursor from a previous listing's nextCursor.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
pub(crate) struct ListSubagentModelsArgs {}

fn spawn_subagent_parameters(max_yield_ms: u64) -> serde_json::Value {
    let mut schema = json!(schemars::schema_for!(SpawnSubagentArgs));
    schema["properties"]["yieldTimeMs"] = yield_time_schema(
        YieldMode::Action,
        max_yield_ms,
        "Maximum time to wait for completion before returning the tool call.",
    );
    schema
}

fn poll_subagent_parameters(max_yield_ms: u64) -> serde_json::Value {
    let mut schema = json!(schemars::schema_for!(PollSubagentArgs));
    schema["properties"]["yieldTimeMs"] = yield_time_schema(
        YieldMode::Poll,
        max_yield_ms,
        "Maximum time to wait for completion before returning the tool call. Zero returns an immediate status/output snapshot.",
    );
    schema
}

fn control_subagent_parameters(max_yield_ms: u64) -> serde_json::Value {
    let mut schema = json!(schemars::schema_for!(ControlSubagentArgs));
    schema["properties"]["action"] = json!({
        "type": "string",
        "enum": ["send", "stop", "answer_question"]
    });
    if let Some(definitions) = schema["$defs"].as_object_mut() {
        definitions.remove("SubagentControlAction");
    }
    schema["properties"]["yieldTimeMs"] = yield_time_schema(
        YieldMode::Action,
        max_yield_ms,
        "Maximum time to wait for completion before returning the tool call.",
    );
    schema["anyOf"] = json!([
        {
            "properties": {
                "action": { "type": "string", "enum": ["send"] },
                "prompt": { "type": "string", "minLength": 1 }
            },
            "required": ["prompt"],
            "not": { "anyOf": [
                { "required": ["questionId"] },
                { "required": ["optionId"] },
                { "required": ["text"] }
            ] }
        },
        {
            "properties": { "action": { "type": "string", "enum": ["stop"] } },
            "not": { "anyOf": [
                { "required": ["questionId"] },
                { "required": ["optionId"] },
                { "required": ["text"] },
                { "required": ["prompt"] },
                { "required": ["model"] },
                { "required": ["reasoning"] },
                { "required": ["fast"] },
                { "required": ["timeoutMs"] }
            ] }
        },
        {
            "properties": {
                "action": { "type": "string", "enum": ["answer_question"] },
                "questionId": { "type": "string", "minLength": 1 }
            },
            "required": ["questionId"],
            "not": { "anyOf": [
                { "required": ["prompt"] },
                { "required": ["model"] },
                { "required": ["reasoning"] },
                { "required": ["fast"] },
                { "required": ["timeoutMs"] }
            ] },
            "anyOf": [
                { "properties": { "optionId": { "type": "string", "minLength": 1 } }, "required": ["optionId"] },
                { "properties": { "text": { "type": "string", "minLength": 1 } }, "required": ["text"] }
            ]
        }
    ]);
    schema
}

fn prepare_subagent_prompt(prompt: &str) -> Result<&str, ToolExecutionError> {
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err(tool_failure(
            "prompt is required when creating or prompting a subagent",
        ));
    }
    Ok(prompt)
}

fn validate_control(args: &ControlSubagentArgs) -> Result<(), ToolExecutionError> {
    if args.thread_id.trim().is_empty() {
        return Err(tool_failure("threadId cannot be empty"));
    }
    if !matches!(args.action, SubagentControlAction::Send)
        && (args.prompt.is_some()
            || args.model.is_some()
            || args.reasoning.is_some()
            || args.fast.is_some()
            || args.timeout_ms.is_some())
    {
        return Err(tool_failure(
            "prompt, model, reasoning, fast, and timeoutMs require send",
        ));
    }
    if !matches!(args.action, SubagentControlAction::AnswerQuestion)
        && (args.question_id.is_some() || args.option_id.is_some() || args.text.is_some())
    {
        return Err(tool_failure(
            "questionId, optionId, and text require answer_question",
        ));
    }
    match args.action {
        SubagentControlAction::Send => {
            prepare_subagent_prompt(args.prompt.as_deref().unwrap_or_default())?;
        }
        SubagentControlAction::Stop => {}
        SubagentControlAction::AnswerQuestion => {
            if args
                .question_id
                .as_deref()
                .unwrap_or_default()
                .trim()
                .is_empty()
            {
                return Err(tool_failure("questionId is required for answer_question"));
            }
            if args
                .option_id
                .as_deref()
                .unwrap_or_default()
                .trim()
                .is_empty()
                && args.text.as_deref().unwrap_or_default().trim().is_empty()
            {
                return Err(tool_failure(
                    "answer_question requires an optionId or a text answer",
                ));
            }
        }
    }
    Ok(())
}

impl rig::tool::Tool for SpawnSubagentTool {
    const NAME: &'static str = "spawn_subagent";
    type Error = ToolExecutionError;
    type Args = SpawnSubagentArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        "Create a new subagent. Use control_subagent to send a follow-up to an existing subagent."
            .to_string()
    }

    fn parameters(&self) -> serde_json::Value {
        spawn_subagent_parameters(self.context.max_yield_ms)
    }

    async fn call(
        &self,
        _context: &mut rig::tool::ToolContext,
        mut args: Self::Args,
    ) -> Result<Self::Output, Self::Error> {
        let payload = serde_json::to_value(&args).map_err(|e| tool_error(e.into()))?;
        args.prompt = prepare_subagent_prompt(&args.prompt)?.to_string();
        execute_tool_job_with_id(
            &self.context,
            Self::NAME,
            payload,
            |cancellation, job_id| run_subagent(&self.context, args, None, job_id, cancellation),
        )
        .await
    }
}

fn child_credentials(context: &AgentToolContext, job_id: &str) -> (String, String) {
    (
        format!("subagent:{}:{job_id}", context.run_id),
        derive_child_execution_secret(context.runtime.execution_secret(), job_id),
    )
}

fn derive_child_execution_secret(caller_execution_secret: &str, job_id: &str) -> String {
    let mut mac = Hmac::<sha2::Sha256>::new_from_slice(caller_execution_secret.as_bytes())
        .expect("HMAC accepts any key length");
    mac.update(b"sprocket-subagent-secret-v1");
    mac.update(&(job_id.len() as u64).to_le_bytes());
    mac.update(job_id.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

async fn submit_or_recover<T>(
    submit: impl Future<Output = Result<T, MutationFailure>>,
    recover: impl Future<Output = anyhow::Result<Option<T>>>,
) -> anyhow::Result<T> {
    let error = match timeout(SUBMISSION_ATTEMPT_TIMEOUT, submit).await {
        Ok(Ok(created)) => return Ok(created),
        Ok(Err(MutationFailure::Functional(error))) => return Err(error),
        Ok(Err(MutationFailure::Transport(error))) => error,
        Err(_) => anyhow::anyhow!("timed out submitting subagent run"),
    };
    recover
        .await
        .map_err(|recovery_error| {
            recovery_error.context(format!(
                "failed to reconcile subagent submission after {error:#}"
            ))
        })?
        .ok_or(error)
}

async fn submit_child(
    context: &AgentToolContext,
    mut fields: BTreeMap<String, Value>,
    thread_id: Option<&str>,
    cancellation: &WorkspaceCancellation,
    submission_id: &str,
    child_execution_secret: &str,
) -> Result<CreateSubagentRunResponse, ToolExecutionError> {
    fields.extend(submission_fields(submission_id, child_execution_secret));
    fields.insert("deferPrompt".to_string(), Value::Boolean(true));
    loop {
        let result = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(cancelled_error()),
            result = submit_or_recover(
                context
                    .runtime
                    .mutation_checked(CREATE_OR_SEND, subagent_args(context, fields.clone())),
                recover_submission(context, submission_id, child_execution_secret),
            ) => result,
        };
        match result {
            Ok(created) => return Ok(created),
            Err(error) => {
                let Some(thread_id) = thread_id.filter(|_| submission_is_waiting(&error)) else {
                    return Err(tool_error(error));
                };
                wait_until_ready(cancellation, || async {
                    context
                        .runtime
                        .mutation_json(
                            "subagents:prepareSubmission",
                            thread_args(context, thread_id),
                        )
                        .await
                })
                .await
                .map_err(tool_error)?;
            }
        }
    }
}

async fn run_subagent(
    context: &AgentToolContext,
    args: SpawnSubagentArgs,
    thread_id: Option<String>,
    job_id: String,
    cancellation: WorkspaceCancellation,
) -> Result<serde_json::Value, ToolExecutionError> {
    let launcher = require_launcher(context)?;
    let (submission_id, child_execution_secret) = child_credentials(context, &job_id);
    let recovered = cancelled_read(&cancellation, async {
        recover_submission(context, &submission_id, &child_execution_secret)
            .await
            .map_err(tool_error)
    })
    .await?;
    let created = if let Some(created) = recovered {
        created
    } else {
        let overrides = SubagentSettingsOverrides {
            model: args.model,
            reasoning: args.reasoning,
            fast: args.fast,
        };
        let (resolved, completion_provider) = cancelled_read(&cancellation, async {
            resolve_child_settings(context, thread_id.as_deref(), &overrides).await
        })
        .await?;

        let mut fields = BTreeMap::new();
        if let Some(thread_id) = &thread_id {
            fields.insert("threadId".to_string(), thread_id.clone().into());
        }
        fields.insert("prompt".to_string(), args.prompt.into());
        fields.insert("model".to_string(), resolved.model.clone().into());
        fields.insert("reasoning".to_string(), resolved.reasoning.clone().into());
        fields.insert("fast".to_string(), resolved.fast.into());
        fields.insert(
            "completionProvider".to_string(),
            completion_provider.as_str().into(),
        );
        if let Some(timeout_ms) = args.timeout_ms {
            fields.insert("timeoutMs".to_string(), Value::Float64(timeout_ms as f64));
        }
        submit_child(
            context,
            fields,
            thread_id.as_deref(),
            &cancellation,
            &submission_id,
            &child_execution_secret,
        )
        .await?
    };

    if created.status == "queued" {
        launch_queued_child(
            launcher,
            context,
            &created,
            &submission_id,
            &child_execution_secret,
        )
        .await?;
    }

    let mut result = action_settlement_result(
        context,
        &created.thread_id,
        YieldMode::Action.normalize(args.yield_time_ms, context.max_yield_ms),
        &cancellation,
    )
    .await?;
    result["threadId"] = json!(created.thread_id);
    result["settings"] =
        serde_json::to_value(&created.settings).map_err(|e| tool_error(e.into()))?;
    Ok(result)
}

async fn launch_queued_child(
    launcher: &SharedSubagentLauncher,
    context: &AgentToolContext,
    created: &CreateSubagentRunResponse,
    submission_id: &str,
    child_execution_secret: &str,
) -> Result<(), ToolExecutionError> {
    let launched = launcher
        .launch(SubagentLaunchRequest {
            user_id: context.user_id.clone(),
            thread_id: created.thread_id.clone(),
            submission_id: submission_id.to_string(),
            execution_secret: child_execution_secret.to_string(),
            workspace_path: context.workspace_root.to_string_lossy().into_owned(),
            selected_model: created.settings.model.clone(),
            completion_provider: created.settings.completion_provider,
            reasoning_effort: created.settings.reasoning.clone(),
            fast_mode: created.settings.fast,
            continuation_of_run_id: created.continuation_of_run_id.clone(),
        })
        .await;
    if let Err(error) = launched {
        let message = format!("Failed to launch subagent: {error:#}");
        context
            .runtime
            .with_execution_secret(child_execution_secret.to_string())
            .finalize_queued_run(&created.run_id, &message, "failed", Some(&message))
            .await
            .map_err(tool_error)?;
        return Err(tool_error(error));
    }
    Ok(())
}

impl rig::tool::Tool for PollSubagentTool {
    const NAME: &'static str = "poll_subagent";
    type Error = ToolExecutionError;
    type Args = PollSubagentArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        String::new()
    }

    fn parameters(&self) -> serde_json::Value {
        poll_subagent_parameters(self.context.max_yield_ms)
    }

    async fn call(
        &self,
        _context: &mut rig::tool::ToolContext,
        args: Self::Args,
    ) -> Result<Self::Output, Self::Error> {
        if args.thread_id.trim().is_empty() {
            return Err(tool_failure("threadId cannot be empty"));
        }
        let payload = serde_json::to_value(&args).map_err(|e| tool_error(e.into()))?;
        execute_tool_job_with_id(
            &self.context,
            Self::NAME,
            payload,
            |cancellation, _job_id| {
                let tool = self.clone();
                async move { tool.run(args, cancellation).await }
            },
        )
        .await
    }
}

impl PollSubagentTool {
    async fn run(
        &self,
        args: PollSubagentArgs,
        cancellation: WorkspaceCancellation,
    ) -> Result<serde_json::Value, ToolExecutionError> {
        let yield_time_ms =
            YieldMode::Poll.normalize(args.yield_time_ms, self.context.max_yield_ms);
        cancelled_read(&cancellation, async {
            if yield_time_ms == 0 {
                return self
                    .context
                    .subagent_polls
                    .observe_pending(
                        &args.thread_id,
                        || fetch_monitor_info(&self.context, &args.thread_id),
                        |info| {
                            read_transcript_snapshot(&self.context, info, args.cursor.as_deref())
                        },
                    )
                    .await;
            }
            let info =
                wait_for_settlement(&self.context, &args.thread_id, yield_time_ms, &cancellation)
                    .await?;
            read_transcript_snapshot(&self.context, info, args.cursor.as_deref()).await
        })
        .await
    }
}

impl rig::tool::Tool for ControlSubagentTool {
    const NAME: &'static str = "control_subagent";
    type Error = ToolExecutionError;
    type Args = ControlSubagentArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        "Send a follow-up, stop a subagent and its entire descendant tree, or answer a question on an existing subagent. Stop the current run or wait for it to finish before sending another message."
            .to_string()
    }

    fn parameters(&self) -> serde_json::Value {
        control_subagent_parameters(self.context.max_yield_ms)
    }

    async fn call(
        &self,
        _context: &mut rig::tool::ToolContext,
        args: Self::Args,
    ) -> Result<Self::Output, Self::Error> {
        validate_control(&args)?;
        let payload = serde_json::to_value(&args).map_err(|e| tool_error(e.into()))?;
        execute_tool_job_with_id(
            &self.context,
            Self::NAME,
            payload,
            |cancellation, job_id| self.control(args, job_id, cancellation),
        )
        .await
    }
}

impl ControlSubagentTool {
    async fn control(
        &self,
        args: ControlSubagentArgs,
        job_id: String,
        cancellation: WorkspaceCancellation,
    ) -> Result<serde_json::Value, ToolExecutionError> {
        if matches!(args.action, SubagentControlAction::Send) {
            return run_subagent(
                &self.context,
                SpawnSubagentArgs {
                    prompt: prepare_subagent_prompt(args.prompt.as_deref().unwrap_or_default())?
                        .to_string(),
                    model: args.model,
                    reasoning: args.reasoning,
                    fast: args.fast,
                    yield_time_ms: args.yield_time_ms,
                    timeout_ms: args.timeout_ms,
                },
                Some(args.thread_id),
                job_id,
                cancellation,
            )
            .await;
        }
        let mut fields = BTreeMap::from([
            ("threadId".to_string(), args.thread_id.clone().into()),
            (
                "action".to_string(),
                match args.action {
                    SubagentControlAction::Stop => "stop",
                    SubagentControlAction::AnswerQuestion => "answer_question",
                    SubagentControlAction::Send => unreachable!(),
                }
                .into(),
            ),
            ("toolJobId".to_string(), job_id.clone().into()),
        ]);
        if let Some(question_id) = &args.question_id {
            fields.insert("questionId".to_string(), question_id.clone().into());
        }
        if let Some(option_id) = &args.option_id {
            fields.insert("optionId".to_string(), option_id.clone().into());
        }
        if let Some(text) = &args.text {
            fields.insert("text".to_string(), text.clone().into());
        }
        let response = match args.action {
            SubagentControlAction::Send => unreachable!(),
            SubagentControlAction::AnswerQuestion => {
                control_mutation_with_retry(&args.thread_id, &cancellation, || {
                    self.context
                        .runtime
                        .mutation_checked(CONTROL, subagent_args(&self.context, fields.clone()))
                })
                .await?
            }
            // Retrying Stop could stop replacement work rather than the original run.
            SubagentControlAction::Stop => {
                cancelled_read(&cancellation, async {
                    timeout(
                        SUBMISSION_ATTEMPT_TIMEOUT,
                        self.context
                            .runtime
                            .mutation_json(CONTROL, subagent_args(&self.context, fields)),
                    )
                    .await
                    .map_err(|_| tool_failure("timed out stopping subagent"))?
                    .map_err(tool_error)
                })
                .await?
            }
        };

        if matches!(args.action, SubagentControlAction::AnswerQuestion) {
            let (submission_id, child_execution_secret) = child_credentials(&self.context, &job_id);
            let recovered = cancelled_read(&cancellation, async {
                recover_submission(&self.context, &submission_id, &child_execution_secret)
                    .await
                    .map_err(tool_error)
            })
            .await?;
            let queued = match (recovered, response.continuation) {
                (Some(recovered), _) => Some(recovered),
                (None, Some(continuation)) => {
                    require_launcher(&self.context)?;
                    let (settings, completion_provider) = cancelled_read(&cancellation, async {
                        resolve_child_settings(
                            &self.context,
                            Some(&args.thread_id),
                            &SubagentSettingsOverrides::default(),
                        )
                        .await
                    })
                    .await?;
                    let mut fields = BTreeMap::from([
                        ("threadId".to_string(), args.thread_id.clone().into()),
                        ("prompt".to_string(), continuation.prompt.clone().into()),
                        ("model".to_string(), settings.model.into()),
                        ("reasoning".to_string(), settings.reasoning.into()),
                        ("fast".to_string(), settings.fast.into()),
                        (
                            "completionProvider".to_string(),
                            completion_provider.as_str().into(),
                        ),
                        (
                            "continuationOfRunId".to_string(),
                            continuation.run_id.into(),
                        ),
                    ]);
                    if let Some(question_id) = &args.question_id {
                        fields.insert(
                            "continuationQuestionId".to_string(),
                            question_id.clone().into(),
                        );
                    }
                    let queued = submit_child(
                        &self.context,
                        fields,
                        Some(&args.thread_id),
                        &cancellation,
                        &submission_id,
                        &child_execution_secret,
                    )
                    .await?;
                    Some(queued)
                }
                _ => None,
            };
            if let Some(queued) = queued.filter(|queued| queued.status == "queued") {
                launch_queued_child(
                    require_launcher(&self.context)?,
                    &self.context,
                    &queued,
                    &submission_id,
                    &child_execution_secret,
                )
                .await?;
            }
        }

        let yield_time_ms =
            YieldMode::Action.normalize(args.yield_time_ms, self.context.max_yield_ms);
        let mut result = if matches!(args.action, SubagentControlAction::Stop) {
            let info = if let Some(run_id) = response.stopped_run_id.as_deref() {
                wait_for_stopped_run_using(&cancellation, || {
                    self.context.runtime.mutation_json(
                        MONITOR_INFO,
                        subagent_args(
                            &self.context,
                            BTreeMap::from([
                                ("threadId".to_string(), args.thread_id.clone().into()),
                                ("targetRunId".to_string(), run_id.to_string().into()),
                            ]),
                        ),
                    )
                })
                .await?
            } else {
                cancelled_read(
                    &cancellation,
                    fetch_monitor_info(&self.context, &args.thread_id),
                )
                .await?
            };
            subagent_action_result(info, yield_time_ms, &cancellation, |info| {
                read_transcript_snapshot(&self.context, info, None)
            })
            .await?
        } else {
            action_settlement_result(&self.context, &args.thread_id, yield_time_ms, &cancellation)
                .await?
        };
        if let Some(answer) = response.answer {
            result["answer"] = serde_json::to_value(answer).map_err(|e| tool_error(e.into()))?;
        }
        if response.already_answered {
            result["alreadyAnswered"] = json!(true);
        }
        Ok(result)
    }
}

async fn control_mutation_with_retry<F, Fut>(
    thread_id: &str,
    cancellation: &WorkspaceCancellation,
    mut call: F,
) -> Result<SubagentControlResponse, ToolExecutionError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<SubagentControlResponse, MutationFailure>>,
{
    let mut retry_delay = CONTROL_INITIAL_RETRY_DELAY;
    let mut attempt = 0;
    loop {
        attempt += 1;
        let result = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(cancelled_error()),
            result = timeout(SUBMISSION_ATTEMPT_TIMEOUT, call()) => result,
        };
        let failure = match result {
            Ok(Ok(response)) => return Ok(response),
            Ok(Err(MutationFailure::Functional(error))) => return Err(tool_error(error)),
            Ok(Err(MutationFailure::Transport(error))) => error,
            Err(_) => anyhow::anyhow!("timed out calling {CONTROL}"),
        };
        if attempt == CONTROL_MAX_ATTEMPTS {
            return Err(tool_error(failure));
        }
        eprintln!(
            "sprocket-agent: {CONTROL} transport attempt {attempt} for thread {thread_id} \
             failed; retrying: {failure:#}"
        );
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(cancelled_error()),
            _ = sleep(retry_delay) => {}
        }
        retry_delay = retry_delay.saturating_mul(2);
    }
}

impl rig::tool::Tool for ListSubagentsTool {
    const NAME: &'static str = "list_subagents";
    type Error = ToolExecutionError;
    type Args = ListSubagentsArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        String::new()
    }

    fn parameters(&self) -> serde_json::Value {
        json!(schemars::schema_for!(ListSubagentsArgs))
    }

    async fn call(
        &self,
        _context: &mut rig::tool::ToolContext,
        args: Self::Args,
    ) -> Result<Self::Output, Self::Error> {
        let payload = serde_json::to_value(&args).map_err(|e| tool_error(e.into()))?;
        execute_tool_job_with_id(
            &self.context,
            Self::NAME,
            payload,
            |cancellation, _job_id| {
                let context = self.context.clone();
                async move {
                    cancelled_read(&cancellation, async {
                        let mut fields = BTreeMap::new();
                        if let Some(parent_thread_id) = &args.parent_thread_id {
                            fields.insert(
                                "parentThreadId".to_string(),
                                parent_thread_id.clone().into(),
                            );
                        }
                        fields.insert(
                            "paginationOpts".to_string(),
                            Value::try_from(json!({
                                "numItems": SUBAGENT_LIST_PAGE_SIZE,
                                "cursor": args.cursor,
                            }))
                            .map_err(tool_error)?,
                        );
                        let page: SubagentListPage = context
                            .runtime
                            .mutation_json(LIST_CHILDREN, subagent_args(&context, fields))
                            .await
                            .map_err(tool_error)?;
                        Ok(list_page_response(&page))
                    })
                    .await
                }
            },
        )
        .await
    }
}

impl rig::tool::Tool for ListSubagentModelsTool {
    const NAME: &'static str = "list_subagent_models";
    type Error = ToolExecutionError;
    type Args = ListSubagentModelsArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        String::new()
    }

    fn parameters(&self) -> serde_json::Value {
        json!(schemars::schema_for!(ListSubagentModelsArgs))
    }

    async fn call(
        &self,
        _context: &mut rig::tool::ToolContext,
        _args: Self::Args,
    ) -> Result<Self::Output, Self::Error> {
        execute_tool_job_with_id(&self.0, Self::NAME, json!({}), |cancellation, _job_id| {
            let context = self.0.clone();
            async move {
                cancelled_read(&cancellation, async {
                    let catalog =
                        fetch_model_catalog(&context, &child_providers(&context).await?).await?;
                    serde_json::to_value(catalog).map_err(|e| tool_error(e.into()))
                })
                .await
            }
        })
        .await
    }
}

/// Provider identity never comes from a tool argument.
async fn fetch_model_catalog(
    context: &AgentToolContext,
    providers: &[CompletionProvider],
) -> Result<ProviderCatalog, ToolExecutionError> {
    crate::catalog::catalog_for_providers(&context.gateway_url, providers)
        .await
        .map_err(tool_error)
}

fn require_launcher(
    context: &AgentToolContext,
) -> Result<&SharedSubagentLauncher, ToolExecutionError> {
    context
        .subagent_launcher
        .as_ref()
        .ok_or_else(|| tool_failure("subagent execution is unavailable in this environment"))
}

/// The providers a child may use, in the user's order.
async fn child_providers(
    context: &AgentToolContext,
) -> Result<Vec<CompletionProvider>, ToolExecutionError> {
    let run_context: crate::types::RunContextResponse = context
        .runtime
        .run_context(&context.run_id)
        .await
        .map_err(tool_error)?;
    let preferences = run_context.provider_preferences;
    Ok(if preferences.restrict_subagents_to_provider {
        vec![run_context.run.completion_provider]
    } else {
        preferences.enabled_providers
    })
}

/// The child's settings and the first of `child_providers` that serves its model.
async fn resolve_child_settings(
    context: &AgentToolContext,
    thread_id: Option<&str>,
    overrides: &SubagentSettingsOverrides,
) -> Result<(ResolvedSubagentSettings, CompletionProvider), ToolExecutionError> {
    let providers = child_providers(context).await?;
    let catalog = fetch_model_catalog(context, &providers).await?;
    let resolved = match thread_id {
        Some(thread_id) => {
            let existing: SubagentThreadSnapshot =
                fetch_thread(context, SNAPSHOT, thread_id).await?;
            resolve_settings_for_target(&catalog, &existing.settings, overrides)
        }
        None => resolve_subagent_settings(&catalog, overrides),
    }
    .map_err(|error| tool_failure(format!("{error:#}")))?;
    let vendor = catalog
        .models
        .iter()
        .find(|model| model.id == resolved.model)
        .map(|model| model.vendor.as_str())
        .unwrap_or_default();
    let provider = providers
        .into_iter()
        .find(|provider| provider.serves_vendor(vendor))
        .ok_or_else(|| tool_failure(format!("no enabled provider serves {}", resolved.model)))?;
    Ok((resolved, provider))
}

fn subagent_args(
    context: &AgentToolContext,
    mut fields: BTreeMap<String, Value>,
) -> BTreeMap<String, Value> {
    fields.insert("runId".to_string(), context.run_id.clone().into());
    fields.insert("claimId".to_string(), context.claim_id.clone().into());
    fields
}

fn thread_args(context: &AgentToolContext, thread_id: &str) -> BTreeMap<String, Value> {
    subagent_args(
        context,
        BTreeMap::from([("threadId".to_string(), thread_id.to_string().into())]),
    )
}

async fn fetch_thread<T: DeserializeOwned>(
    context: &AgentToolContext,
    function: &str,
    thread_id: &str,
) -> Result<T, ToolExecutionError> {
    context
        .runtime
        .mutation_json(function, thread_args(context, thread_id))
        .await
        .map_err(tool_error)
}

fn submission_fields(submission_id: &str, child_execution_secret: &str) -> BTreeMap<String, Value> {
    BTreeMap::from([
        ("submissionId".to_string(), submission_id.to_string().into()),
        (
            "childExecutionSecret".to_string(),
            child_execution_secret.to_string().into(),
        ),
    ])
}

async fn recover_submission(
    context: &AgentToolContext,
    submission_id: &str,
    child_execution_secret: &str,
) -> anyhow::Result<Option<CreateSubagentRunResponse>> {
    timeout(
        SUBMISSION_ATTEMPT_TIMEOUT,
        context.runtime.mutation_json(
            RECOVER_SUBMISSION,
            subagent_args(
                context,
                submission_fields(submission_id, child_execution_secret),
            ),
        ),
    )
    .await
    .map_err(|_| anyhow::anyhow!("timed out recovering subagent submission"))?
}

fn list_page_response(page: &SubagentListPage) -> serde_json::Value {
    json!({
        "children": page.page,
        "nextCursor": if page.is_done { serde_json::Value::Null } else {
            serde_json::Value::String(page.continue_cursor.clone())
        },
        "hasMore": !page.is_done,
    })
}

async fn fetch_monitor_info(
    context: &AgentToolContext,
    thread_id: &str,
) -> Result<SubagentMonitorInfo, ToolExecutionError> {
    fetch_thread(context, MONITOR_INFO, thread_id).await
}

async fn wait_for_settlement(
    context: &AgentToolContext,
    thread_id: &str,
    yield_time_ms: u64,
    cancellation: &WorkspaceCancellation,
) -> Result<SubagentMonitorInfo, ToolExecutionError> {
    wait_for_settlement_using(yield_time_ms, cancellation, || {
        fetch_monitor_info(context, thread_id)
    })
    .await
}

async fn cancelled_read<T>(
    cancellation: &WorkspaceCancellation,
    read: impl Future<Output = Result<T, ToolExecutionError>>,
) -> Result<T, ToolExecutionError> {
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err(cancelled_error()),
        result = read => result,
    }
}

async fn wait_for_settlement_using<F, Fut>(
    yield_time_ms: u64,
    cancellation: &WorkspaceCancellation,
    mut fetch: F,
) -> Result<SubagentMonitorInfo, ToolExecutionError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<SubagentMonitorInfo, ToolExecutionError>>,
{
    let deadline = Instant::now() + Duration::from_millis(yield_time_ms);
    loop {
        let info = cancelled_read(cancellation, fetch()).await?;
        if !info.active || !info.pending_questions.is_empty() {
            return Ok(info);
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Ok(info);
        }
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(cancelled_error()),
            _ = sleep(remaining.min(WAIT_POLL_INTERVAL)) => {}
        }
    }
}

async fn wait_for_stopped_run_using<F, Fut>(
    cancellation: &WorkspaceCancellation,
    mut fetch: F,
) -> Result<SubagentMonitorInfo, ToolExecutionError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = anyhow::Result<SubagentMonitorInfo>>,
{
    loop {
        let info =
            cancelled_read(cancellation, async { fetch().await.map_err(tool_error) }).await?;
        if matches!(info.status.as_str(), "completed" | "failed" | "cancelled") {
            return Ok(info);
        }
        cancelled_read(cancellation, async {
            sleep(WAIT_POLL_INTERVAL).await;
            Ok(())
        })
        .await?;
    }
}

fn subagent_metadata(info: &SubagentMonitorInfo) -> serde_json::Value {
    json!({
        "status": info.status,
        "lastError": info.last_error,
        "pendingQuestions": info.pending_questions,
    })
}

async fn subagent_action_result<F, Fut>(
    info: SubagentMonitorInfo,
    yield_time_ms: u64,
    cancellation: &WorkspaceCancellation,
    read: F,
) -> Result<serde_json::Value, ToolExecutionError>
where
    F: FnOnce(SubagentMonitorInfo) -> Fut,
    Fut: Future<Output = Result<serde_json::Value, ToolExecutionError>>,
{
    if yield_time_ms == 0 {
        return Ok(subagent_metadata(&info));
    }
    cancelled_read(cancellation, read(info)).await
}

async fn action_settlement_result(
    context: &AgentToolContext,
    thread_id: &str,
    yield_time_ms: u64,
    cancellation: &WorkspaceCancellation,
) -> Result<serde_json::Value, ToolExecutionError> {
    let info = wait_for_settlement(context, thread_id, yield_time_ms, cancellation).await?;
    subagent_action_result(info, yield_time_ms, cancellation, |info| {
        read_transcript_snapshot(context, info, None)
    })
    .await
}

async fn read_transcript_snapshot(
    context: &AgentToolContext,
    info: SubagentMonitorInfo,
    cursor: Option<&str>,
) -> Result<serde_json::Value, ToolExecutionError> {
    let store = context
        .transcript_store
        .as_ref()
        .ok_or_else(|| tool_failure("transcript store is unavailable"))?;

    let transcript = &info.transcript;
    let user_id = &context.user_id;
    let thread_id = &transcript.thread_id;
    sprocket_transcript::apply_remote_state(store, user_id, thread_id, transcript, false)
        .await
        .map_err(tool_error)?;
    let page = sprocket_transcript::monitor::download_monitor_page(
        store,
        user_id,
        thread_id,
        cursor,
        transcript.total_parts,
        |start, end, order| async move {
            let mut fields = thread_args(context, thread_id);
            fields.insert("start".into(), Value::Float64(f64::from(start)));
            fields.insert("end".into(), Value::Float64(f64::from(end)));
            fields.insert(
                "order".into(),
                Value::try_from(serde_json::to_value(order)?)?,
            );
            let value: serde_json::Value = context
                .runtime
                .mutation_json(TRANSCRIPT_PARTS_PAGE, fields)
                .await?;
            sprocket_transcript::parse_remote_page(value, thread_id)
        },
    )
    .await
    .map_err(tool_error)?;

    let mut result = subagent_metadata(&info);
    result["entries"] = json!(page.entries);
    result["nextCursor"] = json!(page.next_cursor);
    result["hasMore"] = json!(page.has_more);
    Ok(result)
}

#[cfg(test)]
mod tests;
