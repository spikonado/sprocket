use std::sync::{Arc, Mutex};

use futures::future::BoxFuture;
use rig::tool::{Tool, ToolExecutionError};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::async_tools::{YieldMode, default_yield_ms, is_default_yield_ms};
use super::context::{AgentToolContext, cancelled_read, tool_error, tool_failure};
use super::job::{execute_serialized_tool_job, execute_tool_job_with_id};
use super::questions::{
    MAX_QUESTION_CHARS, NewQuestion, QuestionSnapshot, ask_and_observe, ask_and_settle,
    with_question_waits,
};
use crate::secret_redaction::redact_secrets;
use crate::services::{
    Descriptions, ElicitationForm, ElicitationOutcome, Elicitor, JsonObject, McpTransport,
    SearchResults, ServiceHub, ServiceTool, SharedServiceHub, ToolPolicy,
};

const DEFAULT_SEARCH_LIMIT: usize = 10;
const MAX_SEARCH_LIMIT: usize = 25;
const MAX_DESCRIBE_PATHS: usize = 20;
const MAX_APPROVAL_ARGUMENTS_CHARS: usize = 4000;

#[derive(Clone)]
pub(crate) struct ServiceSearchTool(pub(super) AgentToolContext);

#[derive(Clone)]
pub(crate) struct ServiceDescribeTool(pub(super) AgentToolContext);

#[derive(Clone)]
pub(crate) struct ServiceCallTool(pub(super) AgentToolContext);

#[derive(Clone)]
pub(crate) struct RequestConnectorTool(pub(super) AgentToolContext);

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct ServiceSearchArgs {
    pub(crate) query: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1, max = 25))]
    pub(crate) limit: Option<u32>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct ServiceDescribeArgs {
    /// Tool paths from service_search, as `<connectorId>/<toolName>`.
    #[schemars(length(min = 1, max = 20))]
    pub(crate) paths: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct ServiceCallArgs {
    pub(crate) path: String,
    /// Matches the tool's input schema from service_describe.
    #[serde(default)]
    pub(crate) arguments: JsonObject,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(tag = "type", rename_all = "lowercase")]
pub(crate) enum CustomConnector {
    Stdio {
        name: String,
        command: String,
        #[serde(default)]
        args: Vec<String>,
        /// Names of the environment variables the user must fill in.
        #[serde(default)]
        env: Vec<String>,
    },
    Http {
        name: String,
        url: String,
        /// Names of the HTTP headers the user must fill in.
        #[serde(default)]
        headers: Vec<String>,
    },
}

impl CustomConnector {
    fn split(&self) -> (&str, McpTransport) {
        match self {
            Self::Stdio {
                name,
                command,
                args,
                env,
            } => (
                name,
                McpTransport::Stdio {
                    command: command.clone(),
                    args: args.clone(),
                    env: env.clone(),
                },
            ),
            Self::Http { name, url, headers } => (
                name,
                McpTransport::Http {
                    url: url.clone(),
                    headers: headers.clone(),
                },
            ),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct RequestConnectorArgs {
    /// A connector ID, such as one service_search reports as not connected.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) connector: Option<String>,
    /// An MCP server to add instead of a known connector.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) custom: Option<CustomConnector>,
    /// Why the task needs it, shown to the user.
    #[schemars(length(min = 1, max = 2000))]
    pub(crate) reason: String,
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

fn service_hub(context: &AgentToolContext) -> Result<SharedServiceHub, ToolExecutionError> {
    context
        .service_hub
        .clone()
        .ok_or_else(|| tool_failure("Connectors aren't available in this run."))
}

// Convex rejects object keys that start with `$` or `_`, such as `$schema` and `_meta`, so jobs
// store MCP arguments, schemas and content as JSON strings.
pub(super) fn encode_stored_payload(kind: &str, payload: &mut Value) {
    if kind == ServiceCallTool::NAME {
        stringify_field(payload, "arguments");
    }
}

pub(super) fn encode_stored_result(kind: &str, result: &mut Value) {
    match kind {
        ServiceDescribeTool::NAME => {
            if let Some(tools) = result.get_mut("tools").and_then(Value::as_array_mut) {
                for tool in tools {
                    stringify_field(tool, "inputSchema");
                    stringify_field(tool, "outputSchema");
                }
            }
        }
        ServiceCallTool::NAME => {
            stringify_field(result, "content");
            stringify_field(result, "structuredContent");
        }
        _ => {}
    }
}

fn stringify_field(object: &mut Value, key: &str) {
    if let Some(value) = object.get_mut(key) {
        *value = Value::String(value.to_string());
    }
}

impl rig::tool::Tool for ServiceSearchTool {
    const NAME: &'static str = "service_search";
    type Error = ToolExecutionError;
    type Args = ServiceSearchArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        "Search the tools of the user's connected services by keywords. Also lists matching services that aren't connected yet, which request_connector can set up."
            .to_string()
    }

    fn parameters(&self) -> serde_json::Value {
        json!(schemars::schema_for!(ServiceSearchArgs))
    }

    async fn call(
        &self,
        _context: &mut rig::tool::ToolContext,
        args: Self::Args,
    ) -> Result<Self::Output, Self::Error> {
        let hub = service_hub(&self.0)?;
        let query = args.query.trim().to_string();
        if query.is_empty() {
            return Err(tool_failure("query cannot be empty"));
        }
        let limit = args.limit.map_or(DEFAULT_SEARCH_LIMIT, |limit| {
            (limit as usize).clamp(1, MAX_SEARCH_LIMIT)
        });
        execute_serialized_tool_job(&self.0, Self::NAME, &args, |cancellation| async move {
            cancelled_read(&cancellation, async {
                Ok::<SearchResults, _>(hub.search(&query, limit).await)
            })
            .await
        })
        .await
    }
}

impl rig::tool::Tool for ServiceDescribeTool {
    const NAME: &'static str = "service_describe";
    type Error = ToolExecutionError;
    type Args = ServiceDescribeArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        "Read the input schemas of service tools before calling them.".to_string()
    }

    fn parameters(&self) -> serde_json::Value {
        json!(schemars::schema_for!(ServiceDescribeArgs))
    }

    async fn call(
        &self,
        _context: &mut rig::tool::ToolContext,
        args: Self::Args,
    ) -> Result<Self::Output, Self::Error> {
        let hub = service_hub(&self.0)?;
        if args.paths.is_empty() || args.paths.len() > MAX_DESCRIBE_PATHS {
            return Err(tool_failure(format!(
                "Provide between 1 and {MAX_DESCRIBE_PATHS} paths."
            )));
        }
        let paths = args.paths.clone();
        execute_serialized_tool_job(&self.0, Self::NAME, &args, |cancellation| async move {
            cancelled_read(&cancellation, async {
                Ok::<Descriptions, _>(hub.describe(&paths).await)
            })
            .await
        })
        .await
    }
}

impl rig::tool::Tool for ServiceCallTool {
    const NAME: &'static str = "service_call";
    type Error = ToolExecutionError;
    type Args = ServiceCallArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        "Call a service tool by path. Some tools wait for the user's approval.".to_string()
    }

    fn parameters(&self) -> serde_json::Value {
        json!(schemars::schema_for!(ServiceCallArgs))
    }

    async fn call(
        &self,
        _context: &mut rig::tool::ToolContext,
        args: Self::Args,
    ) -> Result<Self::Output, Self::Error> {
        let hub = service_hub(&self.0)?;
        let payload = serde_json::to_value(&args).map_err(|e| tool_error(e.into()))?;
        execute_tool_job_with_id(&self.0, Self::NAME, payload, |cancellation, job_id| {
            let context = self.0.clone();
            async move {
                cancelled_read(&cancellation, call_service(context, hub, job_id, args)).await
            }
        })
        .await
    }
}

async fn call_service(
    mut context: AgentToolContext,
    hub: SharedServiceHub,
    job_id: String,
    args: ServiceCallArgs,
) -> Result<Value, ToolExecutionError> {
    let tool = hub.tool(&args.path).await.map_err(tool_error)?;
    match tool.policy {
        ToolPolicy::Enabled => {}
        ToolPolicy::Disabled => {
            return Err(tool_failure(format!(
                "{} is turned off in Settings > Connectors.",
                args.path
            )));
        }
        ToolPolicy::Ask if !context.can_ask_user => {
            return Err(tool_failure(format!(
                "{} needs the user's approval, which this run can't ask for. The user can allow it in Settings > Connectors.",
                args.path
            )));
        }
        ToolPolicy::Ask => match ask_approval(&context, &job_id, &tool, &args.arguments).await? {
            Approval::Once => {}
            Approval::Always => {
                hub.save_policy(&args.path, ToolPolicy::Enabled)
                    .await
                    .map_err(tool_error)?;
            }
            Approval::Denied { text } => {
                return Err(tool_failure(match text {
                    Some(text) => format!("The user denied this call and said: {text}"),
                    None => "The user denied this call.".to_string(),
                }));
            }
        },
    }
    context.service_hub = None;
    let elicitor = Arc::new(QuestionElicitor {
        context,
        job_id,
        connector: tool.connector,
        replies: Mutex::default(),
    });
    let mut result = hub
        .call(&args.path, args.arguments, elicitor.clone())
        .await
        .map_err(tool_error)?;
    let replies = std::mem::take(&mut *elicitor.replies.lock().unwrap_or_else(|e| e.into_inner()));
    if let Some(content) = result.get_mut("content").and_then(Value::as_array_mut) {
        content.extend(replies.into_iter().map(|reply| {
            json!({
                "type": "text",
                "text": format!("The user wrote in response to a form from this tool: {reply}"),
            })
        }));
    }
    Ok(result)
}

#[derive(Debug, PartialEq)]
enum Approval {
    Once,
    Always,
    Denied { text: Option<String> },
}

async fn ask_approval(
    context: &AgentToolContext,
    job_id: &str,
    tool: &ServiceTool,
    arguments: &JsonObject,
) -> Result<Approval, ToolExecutionError> {
    let arguments = redact_secrets(&Value::Object(arguments.clone()).to_string());
    let detail = json!({
        "type": "approval",
        "connector": tool.connector,
        "tool": tool.tool,
        "arguments": truncate_chars(&arguments, MAX_APPROVAL_ARGUMENTS_CHARS),
    });
    let question = format!("Allow {} to run {}?", tool.connector, tool.tool);
    let question = blocking_question(&question, detail);
    let snapshot = ask_and_settle(context, job_id, &question).await?;
    approval_from_snapshot(&snapshot)
}

fn approval_from_snapshot(snapshot: &QuestionSnapshot) -> Result<Approval, ToolExecutionError> {
    match snapshot.status.as_str() {
        "answered" => {
            let answer = snapshot.answer.clone().unwrap_or_default();
            Ok(match answer.option_id.as_deref() {
                Some("allow") => Approval::Once,
                Some("always") => Approval::Always,
                _ => Approval::Denied {
                    text: answer.text.filter(|text| !text.trim().is_empty()),
                },
            })
        }
        "skipped" | "timedOut" => Ok(Approval::Denied { text: None }),
        "cancelled" => Err(tool_failure(
            "The approval was cancelled before it was answered.",
        )),
        other => Err(tool_failure(format!(
            "Unexpected question status '{other}'"
        ))),
    }
}

/// Convex gives questions with a `detail` that kind's fixed options.
fn blocking_question(question: &str, detail: Value) -> NewQuestion {
    NewQuestion {
        question: truncate_chars(question, MAX_QUESTION_CHARS),
        options: Vec::new(),
        timeout_ms: None,
        detail: Some(detail),
    }
}

struct QuestionElicitor {
    context: AgentToolContext,
    job_id: String,
    connector: String,
    /// Free text the user sent instead of filling in a form.
    replies: Mutex<Vec<String>>,
}

impl Elicitor for QuestionElicitor {
    fn elicit(&self, form: ElicitationForm) -> BoxFuture<'_, ElicitationOutcome> {
        Box::pin(async move {
            if !self.context.can_ask_user {
                return ElicitationOutcome::Decline;
            }
            let question = if form.message.trim().is_empty() {
                format!("{} needs more information.", self.connector)
            } else {
                form.message
            };
            let detail = json!({
                "type": "form",
                "connector": self.connector,
                "fields": form.fields,
            });
            let question = blocking_question(&question, detail);
            match ask_and_settle(&self.context, &self.job_id, &question).await {
                Ok(snapshot) => {
                    let (outcome, reply) = elicitation_from_snapshot(&snapshot);
                    if let Some(reply) = reply {
                        self.replies
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .push(reply);
                    }
                    outcome
                }
                Err(error) => {
                    tracing::warn!("failed to ask for {}'s form: {error}", self.connector);
                    ElicitationOutcome::Cancel
                }
            }
        })
    }
}

fn elicitation_from_snapshot(snapshot: &QuestionSnapshot) -> (ElicitationOutcome, Option<String>) {
    match snapshot.status.as_str() {
        "answered" => {
            let answer = snapshot.answer.clone().unwrap_or_default();
            let text = answer.text.filter(|text| !text.trim().is_empty());
            match answer.values {
                Some(values) => (ElicitationOutcome::Accept(values), text),
                None => (ElicitationOutcome::Decline, text),
            }
        }
        "skipped" => (ElicitationOutcome::Decline, None),
        _ => (ElicitationOutcome::Cancel, None),
    }
}

impl rig::tool::Tool for RequestConnectorTool {
    const NAME: &'static str = "request_connector";
    type Error = ToolExecutionError;
    type Args = RequestConnectorArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        "Ask the user to connect a service. Pass either a connector ID or a custom MCP server. Poll the result with poll_question; `connected` means its tools are now in service_search."
            .to_string()
    }

    fn parameters(&self) -> serde_json::Value {
        with_question_waits(
            json!(schemars::schema_for!(RequestConnectorArgs)),
            self.0.max_yield_ms,
        )
    }

    async fn call(
        &self,
        _context: &mut rig::tool::ToolContext,
        args: Self::Args,
    ) -> Result<Self::Output, Self::Error> {
        let hub = service_hub(&self.0)?;
        let question = prepare_connector_request(&args, hub.as_ref())?;
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

fn prepare_connector_request(
    args: &RequestConnectorArgs,
    hub: &dyn ServiceHub,
) -> Result<NewQuestion, ToolExecutionError> {
    let reason = args.reason.trim();
    if reason.is_empty() {
        return Err(tool_failure("reason cannot be empty"));
    }
    if reason.chars().count() > MAX_QUESTION_CHARS {
        return Err(tool_failure(format!(
            "reason cannot exceed {MAX_QUESTION_CHARS} characters."
        )));
    }
    let (name, connector) = match (&args.connector, &args.custom) {
        (Some(id), None) => {
            let name = hub.connector_name(id.trim()).ok_or_else(|| {
                tool_failure(format!(
                    "Unknown connector '{id}'. Use an ID from service_search, or describe a custom MCP server."
                ))
            })?;
            (name, json!({ "type": "known", "id": id.trim() }))
        }
        (None, Some(custom)) => {
            let (name, transport) = custom.split();
            let name = name.trim();
            if name.is_empty() {
                return Err(tool_failure("name cannot be empty"));
            }
            transport
                .validate()
                .map_err(|error| tool_failure(error.to_string()))?;
            (
                name.to_string(),
                serde_json::to_value(custom).map_err(|e| tool_error(e.into()))?,
            )
        }
        _ => {
            return Err(tool_failure(
                "Pass exactly one of `connector` and `custom`.",
            ));
        }
    };
    Ok(NewQuestion {
        question: format!("Connect {name}?"),
        options: Vec::new(),
        timeout_ms: args.timeout_ms,
        detail: Some(json!({ "type": "connector", "reason": reason, "connector": connector })),
    })
}

fn truncate_chars(text: &str, max_chars: usize) -> String {
    match text.char_indices().nth(max_chars) {
        Some((end, _)) => text[..end].to_string(),
        None => text.to_string(),
    }
}

#[cfg(test)]
mod tests;
