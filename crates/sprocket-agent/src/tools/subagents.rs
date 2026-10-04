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
use sprocket_workspace::{
    WorkspaceCancellation,
    async_tools::{YieldMode, ZeroPollCooldown},
};
use tokio::sync::Mutex;
use tokio::time::{Instant, sleep, timeout};

use super::async_tools::{default_yield_ms, is_default_yield_ms, yield_time_schema};
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
use crate::transcript::monitor::{MONITOR_PAGE_CHAR_LIMIT, MonitorPage};
use crate::types::CompletionProvider;

const CREATE_OR_SEND: &str = "subagents:createOrSend";
const RECOVER_SUBMISSION: &str = "subagents:recoverSubmission";
const SNAPSHOT: &str = "subagents:snapshot";
const MONITOR_INFO: &str = "subagents:threadMonitorInfo";
const TRANSCRIPT_PARTS: &str = "subagents:transcriptParts";
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
    /// Omit to create a new subagent; include to send a follow-up.
    #[serde(rename = "threadId", default, skip_serializing_if = "Option::is_none")]
    pub(crate) thread_id: Option<String>,
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

fn spawn_subagent_parameters() -> serde_json::Value {
    let mut schema = json!(schemars::schema_for!(SpawnSubagentArgs));
    schema["properties"]["yieldTimeMs"] = yield_time_schema(
        YieldMode::Action,
        "Maximum time to wait for completion before returning the tool call.",
    );
    schema
}

fn poll_subagent_parameters() -> serde_json::Value {
    let mut schema = json!(schemars::schema_for!(PollSubagentArgs));
    schema["properties"]["yieldTimeMs"] = yield_time_schema(
        YieldMode::Poll,
        "Maximum time to wait for completion before returning the tool call. Zero returns an immediate status/output snapshot.",
    );
    schema
}

fn control_subagent_parameters() -> serde_json::Value {
    let mut schema = json!(schemars::schema_for!(ControlSubagentArgs));
    schema["properties"]["action"] = json!({
        "type": "string",
        "enum": ["stop", "answer_question"]
    });
    if let Some(definitions) = schema["$defs"].as_object_mut() {
        definitions.remove("SubagentControlAction");
    }
    schema["properties"]["yieldTimeMs"] = yield_time_schema(
        YieldMode::Action,
        "Maximum time to wait for completion before returning the tool call.",
    );
    schema["anyOf"] = json!([
        {
            "properties": { "action": { "type": "string", "enum": ["stop"] } },
            "not": { "anyOf": [
                { "required": ["questionId"] },
                { "required": ["optionId"] },
                { "required": ["text"] }
            ] }
        },
        {
            "properties": {
                "action": { "type": "string", "enum": ["answer_question"] },
                "questionId": { "type": "string", "minLength": 1 }
            },
            "required": ["questionId"],
            "anyOf": [
                { "properties": { "optionId": { "type": "string", "minLength": 1 } }, "required": ["optionId"] },
                { "properties": { "text": { "type": "string", "minLength": 1 } }, "required": ["text"] }
            ]
        }
    ]);
    schema
}

fn prepare_subagent(args: &SpawnSubagentArgs) -> Result<String, ToolExecutionError> {
    if args
        .thread_id
        .as_ref()
        .is_some_and(|id| id.trim().is_empty())
    {
        return Err(tool_failure("threadId cannot be empty"));
    }
    let prompt = args.prompt.trim().to_string();
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
    match args.action {
        SubagentControlAction::Stop => {
            if args.question_id.is_some() || args.option_id.is_some() || args.text.is_some() {
                return Err(tool_failure(
                    "questionId, optionId, and text require answer_question",
                ));
            }
        }
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
        String::new()
    }

    fn parameters(&self) -> serde_json::Value {
        spawn_subagent_parameters()
    }

    async fn call(
        &self,
        _context: &mut rig::tool::ToolContext,
        args: Self::Args,
    ) -> Result<Self::Output, Self::Error> {
        let payload = serde_json::to_value(&args).map_err(|e| tool_error(e.into()))?;
        let prompt = prepare_subagent(&args)?;
        execute_tool_job_with_id(
            &self.context,
            Self::NAME,
            payload,
            |cancellation, job_id| {
                let tool = self.clone();
                async move { tool.run(args, prompt, job_id, cancellation).await }
            },
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
    loop {
        let result = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(cancelled_error()),
            result = submit_or_recover(
                context
                    .runtime
                    .mutation_checked(CREATE_OR_SEND, subagent_args(context, fields.clone())),
                async {
                    Ok(recover_submission(context, submission_id, child_execution_secret)
                        .await?
                        .map(|recovered| recovered.run))
                },
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

impl SpawnSubagentTool {
    async fn run(
        &self,
        args: SpawnSubagentArgs,
        prompt: String,
        job_id: String,
        cancellation: WorkspaceCancellation,
    ) -> Result<serde_json::Value, ToolExecutionError> {
        let launcher = require_launcher(&self.context)?;
        let (submission_id, child_execution_secret) = child_credentials(&self.context, &job_id);
        let recovered = cancelled_read(&cancellation, async {
            recover_submission(&self.context, &submission_id, &child_execution_secret)
                .await
                .map_err(tool_error)
        })
        .await?;
        let (created, prompt) = if let Some(recovered) = recovered {
            (recovered.run, recovered.prompt)
        } else {
            let overrides = SubagentSettingsOverrides {
                model: args.model.clone(),
                reasoning: args.reasoning.clone(),
                fast: args.fast,
            };
            let resolved = cancelled_read(&cancellation, async {
                resolve_child_settings(&self.context, args.thread_id.as_deref(), &overrides).await
            })
            .await?;

            let mut fields = BTreeMap::new();
            if let Some(thread_id) = &args.thread_id {
                fields.insert("threadId".to_string(), thread_id.clone().into());
            }
            fields.insert("prompt".to_string(), prompt.clone().into());
            fields.insert("model".to_string(), resolved.model.clone().into());
            fields.insert("reasoning".to_string(), resolved.reasoning.clone().into());
            fields.insert("fast".to_string(), resolved.fast.into());
            if let Some(timeout_ms) = args.timeout_ms {
                fields.insert("timeoutMs".to_string(), Value::Float64(timeout_ms as f64));
            }
            let created = submit_child(
                &self.context,
                fields,
                args.thread_id.as_deref(),
                &cancellation,
                &submission_id,
                &child_execution_secret,
            )
            .await?;
            (created, prompt)
        };

        if created.status == "queued" {
            launch_queued_child(
                launcher,
                &self.context,
                &created,
                &submission_id,
                &child_execution_secret,
                &prompt,
            )
            .await?;
        }

        let mut result = action_settlement_result(
            &self.context,
            &created.thread_id,
            YieldMode::Action.normalize(args.yield_time_ms),
            &cancellation,
        )
        .await?;
        result["threadId"] = json!(created.thread_id);
        result["settings"] =
            serde_json::to_value(&created.settings).map_err(|e| tool_error(e.into()))?;
        Ok(result)
    }
}

async fn launch_queued_child(
    launcher: &SharedSubagentLauncher,
    context: &AgentToolContext,
    created: &CreateSubagentRunResponse,
    submission_id: &str,
    child_execution_secret: &str,
    // start_agent_run reconciles this submission against the recorded prompt.
    committed_prompt: &str,
) -> Result<(), ToolExecutionError> {
    let launched = launcher
        .launch(SubagentLaunchRequest {
            user_id: context.user_id.clone(),
            thread_id: created.thread_id.clone(),
            submission_id: submission_id.to_string(),
            execution_secret: child_execution_secret.to_string(),
            prompt: committed_prompt.to_string(),
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
        poll_subagent_parameters()
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
        let yield_time_ms = YieldMode::Poll.normalize(args.yield_time_ms);
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
        String::new()
    }

    fn parameters(&self) -> serde_json::Value {
        control_subagent_parameters()
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
            |cancellation, job_id| {
                let tool = self.clone();
                async move { tool.control(args, job_id, cancellation).await }
            },
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
        let mut fields = BTreeMap::from([
            ("threadId".to_string(), args.thread_id.clone().into()),
            (
                "action".to_string(),
                match args.action {
                    SubagentControlAction::Stop => "stop",
                    SubagentControlAction::AnswerQuestion => "answer_question",
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
            SubagentControlAction::AnswerQuestion => {
                control_mutation_with_retry(&args.thread_id, &cancellation, || {
                    self.context
                        .runtime
                        .mutation_checked(CONTROL, subagent_args(&self.context, fields.clone()))
                })
                .await?
            }
            // Retrying Stop could cancel replacement work rather than the original run.
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
                (Some(recovered), _) => Some((recovered.run, recovered.prompt)),
                (None, Some(continuation)) => {
                    require_launcher(&self.context)?;
                    let settings = cancelled_read(&cancellation, async {
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
                    Some((queued, continuation.prompt))
                }
                _ => None,
            };
            if let Some((queued, prompt)) = queued.filter(|(queued, _)| queued.status == "queued") {
                launch_queued_child(
                    require_launcher(&self.context)?,
                    &self.context,
                    &queued,
                    &submission_id,
                    &child_execution_secret,
                    &prompt,
                )
                .await?;
            }
        }

        let yield_time_ms = YieldMode::Action.normalize(args.yield_time_ms);
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
                        fetch_model_catalog(&context, caller_provider(&context).await?).await?;
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
    provider: CompletionProvider,
) -> Result<ProviderCatalog, ToolExecutionError> {
    crate::catalog::catalog_for_provider(&context.gateway_url, provider)
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

async fn caller_provider(
    context: &AgentToolContext,
) -> Result<CompletionProvider, ToolExecutionError> {
    let run_context: crate::types::RunContextResponse = context
        .runtime
        .run_context(&context.run_id)
        .await
        .map_err(tool_error)?;
    Ok(run_context.run.completion_provider)
}

async fn resolve_child_settings(
    context: &AgentToolContext,
    thread_id: Option<&str>,
    overrides: &SubagentSettingsOverrides,
) -> Result<ResolvedSubagentSettings, ToolExecutionError> {
    match thread_id {
        Some(thread_id) => {
            let existing: SubagentThreadSnapshot =
                fetch_thread(context, SNAPSHOT, thread_id).await?;
            let saved = existing.settings;
            let catalog = fetch_model_catalog(context, saved.completion_provider).await?;
            resolve_settings_for_target(&catalog, &saved, overrides)
        }
        None => {
            let catalog = fetch_model_catalog(context, caller_provider(context).await?).await?;
            resolve_subagent_settings(&catalog, overrides)
        }
    }
    .map_err(|error| tool_failure(format!("{error:#}")))
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

#[derive(Deserialize)]
struct RecoveredSubmission {
    #[serde(flatten)]
    run: CreateSubagentRunResponse,
    prompt: String,
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
) -> anyhow::Result<Option<RecoveredSubmission>> {
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
        .clone()
        .ok_or_else(|| tool_failure("transcript store is unavailable"))?;

    sync_monitor_transcript(context, &info, &store).await?;
    let page = crate::transcript::monitor::read_monitor_page(
        &store,
        &info.user_id,
        &info.thread_id,
        cursor,
        MONITOR_PAGE_CHAR_LIMIT,
    )
    .await
    .map_err(tool_error)?;

    Ok(subagent_snapshot(&info, page))
}

fn subagent_snapshot(info: &SubagentMonitorInfo, page: MonitorPage) -> serde_json::Value {
    let mut result = subagent_metadata(info);
    result["entries"] = json!(page.entries);
    result["nextCursor"] = json!(page.next_cursor);
    result["hasMore"] = json!(page.has_more);
    result
}

async fn sync_monitor_transcript(
    context: &AgentToolContext,
    info: &SubagentMonitorInfo,
    store: &crate::TranscriptStore,
) -> Result<(), ToolExecutionError> {
    crate::transcript::apply_remote_state(
        store,
        &info.user_id,
        &info.thread_id,
        &info.transcript,
        false,
    )
    .await
    .map_err(tool_error)?;
    crate::transcript::fetch_missing_parts(
        store,
        &info.user_id,
        &info.thread_id,
        0,
        info.transcript.total_parts,
        |numbers| {
            let context = context.clone();
            let thread_id = info.thread_id.clone();
            async move {
                let mut fields = thread_args(&context, &thread_id);
                fields.insert(
                    "numbers".to_string(),
                    Value::Array(
                        numbers
                            .iter()
                            .map(|number| Value::Float64(*number as f64))
                            .collect(),
                    ),
                );
                let value: serde_json::Value = context
                    .runtime
                    .mutation_json(TRANSCRIPT_PARTS, fields)
                    .await?;
                crate::transcript::parse_remote_parts(value)
            }
        },
    )
    .await
    .map_err(tool_error)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transcript::RemoteTranscriptState;

    #[test]
    fn prompts_create_or_target_a_child_without_an_action() {
        for thread_id in [None, Some("child-thread")] {
            let mut payload = json!({"prompt": "  implement the task  ", "yieldTimeMs": 0});
            if let Some(thread_id) = thread_id {
                payload["threadId"] = json!(thread_id);
            }
            let args: SpawnSubagentArgs = serde_json::from_value(payload).unwrap();
            let prompt = prepare_subagent(&args).unwrap();
            assert_eq!(args.thread_id.as_deref(), thread_id);
            assert_eq!(prompt, "implement the task");
            assert_eq!(args.yield_time_ms, 0);
        }
    }

    #[test]
    fn promptless_followups_require_an_explicit_task() {
        for payload in [
            json!({}),
            json!({"threadId": "child-thread"}),
            json!({"threadId": "child-thread", "prompt": "  "}),
        ] {
            let result = serde_json::from_value::<SpawnSubagentArgs>(payload)
                .map_err(|error| tool_failure(error.to_string()))
                .and_then(|args| prepare_subagent(&args));
            assert!(result.unwrap_err().to_string().contains("prompt"));
        }
    }

    #[test]
    fn control_fields_and_execution_options_are_action_specific() {
        for payload in [
            json!({"action": "stop"}),
            json!({"action": "stop", "threadId": " "}),
            json!({"action": "stop", "threadId": "child", "prompt": "task"}),
            json!({"action": "stop", "threadId": "child", "timeoutMs": 10}),
            json!({"action": "stop", "threadId": "child", "questionId": "question"}),
            json!({"action": "answer_question", "threadId": "child", "text": "answer"}),
            json!({"action": "answer_question", "threadId": "child", "questionId": "q"}),
            json!({"action": "answer_question", "threadId": "child", "questionId": "q", "text": "answer", "fast": false}),
        ] {
            let result = serde_json::from_value::<ControlSubagentArgs>(payload.clone())
                .map_err(|error| tool_failure(error.to_string()))
                .and_then(|args| validate_control(&args));
            assert!(result.is_err(), "{payload}");
        }
    }

    fn monitor_info(active: bool) -> SubagentMonitorInfo {
        SubagentMonitorInfo {
            thread_id: "child".to_string(),
            user_id: "user".to_string(),
            status: if active { "running" } else { "completed" }.to_string(),
            last_error: None,
            active,
            pending_questions: Vec::new(),
            transcript: RemoteTranscriptState {
                thread_id: "child".to_string(),
                total_parts: 0,
                history_from_number: 0,
                context_summary: None,
            },
        }
    }

    #[tokio::test]
    async fn immediate_actions_return_lifecycle_without_reading_transcripts() {
        let result = subagent_action_result(
            monitor_info(true),
            0,
            &WorkspaceCancellation::new(),
            |_| async { panic!("immediate actions do not read transcripts") },
        )
        .await
        .unwrap();
        assert_eq!(
            result,
            json!({"status": "running", "lastError": null, "pendingQuestions": []})
        );
    }

    #[test]
    fn transcript_snapshot_projects_only_public_fields() {
        let mut info = monitor_info(false);
        info.pending_questions
            .push(crate::subagents::SubagentQuestion {
                question_id: "question".to_string(),
                question: "Continue?".to_string(),
                options: Vec::new(),
            });
        let result = subagent_snapshot(
            &info,
            MonitorPage {
                entries: Vec::new(),
                next_cursor: "next".to_string(),
                has_more: true,
            },
        );
        assert_eq!(
            result,
            json!({
                "status": "completed", "lastError": null,
                "pendingQuestions": [{"questionId": "question", "question": "Continue?", "options": []}],
                "entries": [], "nextCursor": "next", "hasMore": true
            })
        );
    }

    #[tokio::test(start_paused = true)]
    async fn stop_waits_for_the_target_run_to_finish_even_with_pending_questions() {
        let started = Instant::now();
        let mut reads = 0;
        let info = wait_for_stopped_run_using(&WorkspaceCancellation::new(), || {
            reads += 1;
            let mut info = monitor_info(true);
            info.pending_questions
                .push(crate::subagents::SubagentQuestion {
                    question_id: "question".to_string(),
                    question: "Continue?".to_string(),
                    options: Vec::new(),
                });
            if reads == 3 {
                info.status = "cancelled".to_string();
            }
            async move { Ok(info) }
        })
        .await
        .unwrap();
        assert_eq!(reads, 3);
        assert_eq!(started.elapsed(), WAIT_POLL_INTERVAL * 2);
        assert_eq!(
            subagent_metadata(&info),
            json!({
                "status": "cancelled", "lastError": null,
                "pendingQuestions": [{"questionId": "question", "question": "Continue?", "options": []}]
            })
        );
    }

    #[tokio::test]
    async fn cancellation_aborts_a_stalled_stop_observation() {
        let cancellation = WorkspaceCancellation::new();
        let cancel = cancellation.clone();
        let error = wait_for_stopped_run_using(&cancellation, || {
            cancel.cancel();
            std::future::pending::<anyhow::Result<SubagentMonitorInfo>>()
        })
        .await
        .unwrap_err();
        assert_eq!(error.kind(), rig::tool::ToolErrorKind::Cancelled);
    }

    #[tokio::test(start_paused = true)]
    async fn settlement_waits_until_completion_and_returns_the_last_snapshot() {
        let started = Instant::now();
        let mut reads = 0;
        let info = wait_for_settlement_using(10_000, &WorkspaceCancellation::new(), || {
            reads += 1;
            let mut info = monitor_info(reads < 3);
            info.last_error = Some(format!("snapshot-{reads}"));
            async move { Ok(info) }
        })
        .await
        .unwrap();
        assert_eq!(started.elapsed(), WAIT_POLL_INTERVAL * 2);
        assert_eq!(reads, 3);
        assert_eq!(info.status, "completed");
        assert_eq!(info.last_error.as_deref(), Some("snapshot-3"));
    }

    #[tokio::test(start_paused = true)]
    async fn settlement_returns_a_pending_question_without_waiting_for_completion() {
        let started = Instant::now();
        let mut reads = 0;
        let info = wait_for_settlement_using(10_000, &WorkspaceCancellation::new(), || {
            reads += 1;
            let mut info = monitor_info(true);
            if reads == 2 {
                info.pending_questions
                    .push(crate::subagents::SubagentQuestion {
                        question_id: "question".to_string(),
                        question: "Which direction?".to_string(),
                        options: Vec::new(),
                    });
            }
            async move { Ok(info) }
        })
        .await
        .unwrap();
        assert_eq!(started.elapsed(), WAIT_POLL_INTERVAL);
        assert!(info.active);
        assert_eq!(info.pending_questions[0].question_id, "question");
    }

    #[tokio::test]
    async fn cancellation_aborts_a_stalled_post_launch_observation() {
        let cancellation = WorkspaceCancellation::new();
        let cancel = cancellation.clone();
        let result = wait_for_settlement_using(10_000, &cancellation, || {
            let cancel = cancel.clone();
            async move {
                cancel.cancel();
                std::future::pending::<Result<SubagentMonitorInfo, ToolExecutionError>>().await
            }
        })
        .await
        .unwrap_err();
        assert_eq!(result.kind(), rig::tool::ToolErrorKind::Cancelled);
    }

    #[tokio::test]
    async fn cancellation_aborts_a_stalled_transcript_read() {
        let cancellation = WorkspaceCancellation::new();
        let cancel = cancellation.clone();
        let result =
            subagent_action_result(monitor_info(false), 10_000, &cancellation, |_| async {
                cancel.cancel();
                std::future::pending::<Result<serde_json::Value, ToolExecutionError>>().await
            })
            .await
            .unwrap_err();
        assert_eq!(result.kind(), rig::tool::ToolErrorKind::Cancelled);
    }

    #[tokio::test(start_paused = true)]
    async fn immediate_polls_share_a_thread_cooldown_and_terminal_reads_stay_available() {
        let polls = SubagentPolls::default();
        let observe = |info: SubagentMonitorInfo| async move { Ok(json!({"status": info.status})) };
        polls
            .observe_pending("child", || async { Ok(monitor_info(true)) }, observe)
            .await
            .unwrap();
        let error = polls
            .clone()
            .observe_pending(
                "child",
                || async { Ok(monitor_info(true)) },
                |_| async { panic!("cooldown must be checked before reading output") },
            )
            .await
            .unwrap_err();
        assert!(error.to_string().contains("Check again after"));
        let completed = polls
            .observe_pending("child", || async { Ok(monitor_info(false)) }, observe)
            .await
            .unwrap();
        assert_eq!(completed["status"], "completed");
        polls
            .observe_pending(
                "another-child",
                || async { Ok(monitor_info(true)) },
                observe,
            )
            .await
            .unwrap();
        tokio::time::advance(Duration::from_secs(10)).await;
        polls
            .observe_pending("child", || async { Ok(monitor_info(true)) }, observe)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn unsuccessful_output_reads_leave_immediate_poll_available() {
        let polls = SubagentPolls::default();
        polls
            .observe_pending(
                "child",
                || async { Ok(monitor_info(true)) },
                |_| async { Err(tool_failure("transcript unavailable")) },
            )
            .await
            .unwrap_err();
        let result = polls
            .observe_pending(
                "child",
                || async { Ok(monitor_info(true)) },
                |_| async { Ok(json!({"entries": ["output"]})) },
            )
            .await
            .unwrap();
        assert_eq!(result["entries"], json!(["output"]));
    }

    #[tokio::test(start_paused = true)]
    async fn timed_out_creation_recovers_the_committed_child() {
        let committed = std::cell::Cell::new(None);
        let child = submit_or_recover(
            async {
                committed.set(Some(("child-thread", "child-run")));
                std::future::pending::<Result<(&str, &str), MutationFailure>>().await
            },
            async { Ok(committed.get()) },
        )
        .await
        .unwrap();
        assert_eq!(child, ("child-thread", "child-run"));
    }

    #[tokio::test]
    async fn lost_creation_response_recovers_the_committed_child() {
        let committed = std::cell::Cell::new(None);
        let child = submit_or_recover(
            async {
                committed.set(Some("child-run"));
                Err(MutationFailure::Transport(anyhow::anyhow!(
                    "connection closed after commit"
                )))
            },
            async { Ok(committed.get()) },
        )
        .await
        .unwrap();
        assert_eq!(child, "child-run");
    }

    #[tokio::test]
    async fn uncommitted_creation_preserves_the_transport_failure() {
        let error = submit_or_recover::<()>(
            async {
                Err(MutationFailure::Transport(anyhow::anyhow!(
                    "connection closed"
                )))
            },
            async { Ok(None) },
        )
        .await
        .unwrap_err();
        assert_eq!(error.to_string(), "connection closed");
    }

    #[tokio::test]
    async fn functional_creation_errors_do_not_issue_a_recovery_lookup() {
        let error = submit_or_recover::<()>(
            async {
                Err(MutationFailure::Functional(anyhow::anyhow!(
                    "SPROCKET_SUBMISSION_WAITING"
                )))
            },
            async { panic!("a rejected creation needs no reconciliation") },
        )
        .await
        .unwrap_err();
        assert!(submission_is_waiting(&error));
    }

    #[tokio::test]
    async fn successful_creation_does_not_issue_a_recovery_lookup() {
        let child = submit_or_recover(async { Ok("child-run") }, async {
            panic!("successful creation needs no reconciliation")
        })
        .await
        .unwrap();
        assert_eq!(child, "child-run");
    }

    #[test]
    fn child_secret_is_keyed_stable_and_never_the_caller_secret() {
        let caller_secret = uuid::Uuid::new_v4().to_string();
        let other_secret = uuid::Uuid::new_v4().to_string();
        let secret_a = derive_child_execution_secret(&caller_secret, "job-1");
        let secret_b = derive_child_execution_secret(&caller_secret, "job-1");
        let secret_c = derive_child_execution_secret(&caller_secret, "job-2");
        assert_eq!(secret_a, secret_b);
        assert_ne!(secret_a, secret_c);
        assert_ne!(secret_a, caller_secret);
        assert_eq!(secret_a.len(), 64);
        assert_ne!(
            secret_a,
            derive_child_execution_secret(&other_secret, "job-1")
        );
    }

    #[test]
    fn control_accepts_an_option_with_annotation_and_a_free_text_answer() {
        for answer in [
            json!({"optionId": "a", "text": "with this detail"}),
            json!({"text": "my answer"}),
        ] {
            let mut payload = serde_json::json!({
                "threadId": "jd7child",
                "action": "answer_question",
                "questionId": "jd7q"
            });
            payload
                .as_object_mut()
                .unwrap()
                .extend(answer.as_object().unwrap().clone());
            let control: ControlSubagentArgs =
                serde_json::from_value(payload).expect("control args");
            validate_control(&control).unwrap();
            assert!(matches!(
                control.action,
                SubagentControlAction::AnswerQuestion
            ));
            assert_eq!(control.question_id.as_deref(), Some("jd7q"));
        }
    }

    #[tokio::test(start_paused = true)]
    async fn control_retries_a_lost_response_and_returns_the_committed_answer() {
        let mut attempts = 0;
        let response = control_mutation_with_retry("child", &WorkspaceCancellation::new(), || {
            attempts += 1;
            let attempt = attempts;
            async move {
                if attempt == 1 {
                    Err(MutationFailure::Transport(anyhow::anyhow!("response lost")))
                } else {
                    Ok(SubagentControlResponse {
                        stopped_run_id: None,
                        answer: Some(crate::subagents::SubagentCommittedAnswer {
                            option_id: Some("east".to_string()),
                            option_label: Some("East".to_string()),
                            text: None,
                        }),
                        already_answered: true,
                        continuation: None,
                    })
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(attempts, 2);
        assert_eq!(response.answer.unwrap().option_id.as_deref(), Some("east"));
    }

    #[tokio::test(start_paused = true)]
    async fn control_returns_function_errors_without_retrying() {
        let mut attempts = 0;
        let error = control_mutation_with_retry("child", &WorkspaceCancellation::new(), || {
            attempts += 1;
            async {
                Err(MutationFailure::Functional(anyhow::anyhow!(
                    "question unavailable"
                )))
            }
        })
        .await
        .unwrap_err();
        assert_eq!(attempts, 1);
        assert!(error.to_string().contains("question unavailable"));
    }

    #[tokio::test(start_paused = true)]
    async fn control_stalled_calls_finish_after_bounded_retries() {
        let mut attempts = 0;
        let error = control_mutation_with_retry("child", &WorkspaceCancellation::new(), || {
            attempts += 1;
            std::future::pending::<Result<SubagentControlResponse, MutationFailure>>()
        })
        .await
        .unwrap_err();
        assert_eq!(attempts, 3);
        assert!(error.to_string().contains("timed out calling"));
    }

    #[tokio::test]
    async fn control_cancellation_drops_a_pending_call() {
        let cancellation = WorkspaceCancellation::new();
        let pending_cancellation = cancellation.clone();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let mut started_tx = Some(started_tx);
        let task = tokio::spawn(async move {
            control_mutation_with_retry("child", &pending_cancellation, || {
                if let Some(tx) = started_tx.take() {
                    let _ = tx.send(());
                }
                std::future::pending::<Result<SubagentControlResponse, MutationFailure>>()
            })
            .await
        });
        started_rx.await.unwrap();
        cancellation.cancel();
        assert!(
            task.await
                .unwrap()
                .unwrap_err()
                .to_string()
                .contains("cancelled")
        );
    }
}
