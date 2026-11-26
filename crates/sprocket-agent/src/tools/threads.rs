use convex::Value;
use rig::tool::ToolExecutionError;
use schemars::JsonSchema;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sprocket_transcript::TranscriptStore;
use sprocket_workspace::WorkspaceCancellation;

use super::context::{AgentToolContext, cancelled_read, tool_error, tool_failure};
use super::job::execute_tool_job_with_id;

const LIST_FOR_RUN: &str = "threads:listForRun";

#[derive(Clone)]
pub(crate) struct ListThreadsTool {
    pub(super) context: AgentToolContext,
    pub(super) repository_key: String,
}

#[derive(Clone)]
pub(crate) struct DownloadThreadsTool {
    pub(super) context: AgentToolContext,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct ListThreadsArgs {
    /// Search threads.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    query: Option<String>,
    /// Scope to the direct children of this thread.
    #[serde(
        rename = "parentThreadId",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    parent_thread_id: Option<String>,
    #[serde(
        rename = "repositoryKeys",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "Option<serde_json::Value>")]
    repository_keys: Option<RepositoryKeys>,
    /// Include settled threads.
    #[serde(
        rename = "includeSettled",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    include_settled: Option<bool>,
    /// nextCursor from a previous call.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(untagged)]
enum RepositoryKeys {
    All(AllRepositories),
    Keys(Vec<String>),
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum AllRepositories {
    All,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct DownloadThreadsArgs {
    #[serde(rename = "threadIds")]
    #[schemars(length(min = 1))]
    thread_ids: Vec<String>,
    /// Also download every subagent thread under them.
    #[serde(
        rename = "includeDescendants",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    include_descendants: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadPage {
    threads: Vec<ListedThread>,
    next_cursor: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListedThread {
    thread_id: String,
}

fn list_threads_parameters(repository_key: &str) -> serde_json::Value {
    let mut schema = json!(schemars::schema_for!(ListThreadsArgs));
    schema["properties"]["repositoryKeys"] = json!({
        "description": "Projects to list from.",
        "oneOf": [
            { "type": "array", "items": { "type": "string" }, "minItems": 1 },
            { "const": "all" }
        ],
        "default": [repository_key],
    });
    schema["properties"]["includeSettled"]["default"] = json!(false);
    schema
}

impl rig::tool::Tool for ListThreadsTool {
    const NAME: &'static str = "list_threads";
    type Error = ToolExecutionError;
    type Args = ListThreadsArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        "List/search threads.".to_string()
    }

    fn parameters(&self) -> serde_json::Value {
        list_threads_parameters(&self.repository_key)
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
            |cancellation, _job_id| async move {
                cancelled_read(
                    &cancellation,
                    query_threads::<serde_json::Value>(&self.context, &args),
                )
                .await
            },
        )
        .await
    }
}

impl rig::tool::Tool for DownloadThreadsTool {
    const NAME: &'static str = "download_threads";
    type Error = ToolExecutionError;
    type Args = DownloadThreadsArgs;
    type Output = serde_json::Value;

    fn description(&self) -> String {
        "Download threads' complete transcript.".to_string()
    }

    fn parameters(&self) -> serde_json::Value {
        let mut schema = json!(schemars::schema_for!(DownloadThreadsArgs));
        schema["properties"]["includeDescendants"]["default"] = json!(true);
        schema
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
            |cancellation, _job_id| async move {
                download_threads(
                    &self.context,
                    args.thread_ids,
                    args.include_descendants.unwrap_or(true),
                    &cancellation,
                )
                .await?;
                Ok(json!({}))
            },
        )
        .await
    }
}

async fn query_threads<T: DeserializeOwned>(
    context: &AgentToolContext,
    args: &ListThreadsArgs,
) -> Result<T, ToolExecutionError> {
    let fields = serde_json::to_value(args).map_err(|e| tool_error(e.into()))?;
    let Value::Object(mut fields) = Value::try_from(fields).map_err(tool_error)? else {
        return Err(tool_failure("thread listing arguments must be an object"));
    };
    fields.insert("runId".to_string(), context.run_id.clone().into());
    context
        .runtime
        .query_json(LIST_FOR_RUN, fields)
        .await
        .map_err(tool_error)
}

async fn download_threads(
    context: &AgentToolContext,
    thread_ids: Vec<String>,
    include_descendants: bool,
    cancellation: &WorkspaceCancellation,
) -> Result<(), ToolExecutionError> {
    let store = context
        .transcript_store
        .as_deref()
        .ok_or_else(|| tool_failure("transcript store is unavailable"))?;
    let mut pending = thread_ids;
    while let Some(thread_id) = pending.pop() {
        cancelled_read(cancellation, download_thread(context, store, &thread_id)).await?;
        if include_descendants {
            pending
                .extend(cancelled_read(cancellation, child_thread_ids(context, &thread_id)).await?);
        }
    }
    Ok(())
}

async fn download_thread(
    context: &AgentToolContext,
    store: &TranscriptStore,
    thread_id: &str,
) -> Result<(), ToolExecutionError> {
    let runtime = &context.runtime;
    let run_id = &context.run_id;
    let total_parts = runtime
        .transcript_state_for_run(run_id, thread_id)
        .await
        .and_then(|state| state.to_state(thread_id))
        .map_err(tool_error)?
        .remote_total_parts;
    store
        .ensure_parts(&context.user_id, thread_id, 0, total_parts, |start, end| {
            runtime.transcript_parts_page_for_run(run_id, thread_id, start, end)
        })
        .await
        .map_err(tool_error)
}

async fn child_thread_ids(
    context: &AgentToolContext,
    parent_thread_id: &str,
) -> Result<Vec<String>, ToolExecutionError> {
    let mut children = Vec::new();
    let mut cursor = None;
    loop {
        let page: ThreadPage = query_threads(
            context,
            &ListThreadsArgs {
                parent_thread_id: Some(parent_thread_id.to_string()),
                cursor,
                ..ListThreadsArgs::default()
            },
        )
        .await?;
        children.extend(page.threads.into_iter().map(|thread| thread.thread_id));
        cursor = page.next_cursor;
        if cursor.is_none() {
            return Ok(children);
        }
    }
}
