use rig::tool::{ToolExecutionError, ToolOutput};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::context::{AgentToolContext, tool_error, tool_failure};
use super::job::execute_tool_job_with_id;
use super::web::web_request_args;

#[derive(Clone)]
pub(crate) struct DeveloperSearchTool(pub(super) AgentToolContext);

#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DeveloperSearchType {
    Doc,
    Issue,
    PullRequest,
    Readme,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct DeveloperSearchArgs {
    /// What to search for.
    pub(crate) query: String,
    /// Result kinds to search. Defaults to all of them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) types: Option<Vec<DeveloperSearchType>>,
    /// GitHub repositories as `owner/name`, at most 20. Only filters the `issue`, `pull_request`, and `readme` types.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) repos: Option<Vec<String>>,
}

impl rig::tool::Tool for DeveloperSearchTool {
    const NAME: &'static str = "developer_search";
    type Error = ToolExecutionError;
    type Args = DeveloperSearchArgs;
    type Output = ToolOutput;

    fn description(&self) -> String {
        "Search developer documentation and GitHub issues, pull requests, and READMEs. Returns ranked pages with passages and their URLs. Prefer it over `web_search` for questions about libraries, APIs, SDKs, and bugs in open-source projects."
            .to_string()
    }

    fn parameters(&self) -> serde_json::Value {
        json!(schemars::schema_for!(DeveloperSearchArgs))
    }

    async fn call(
        &self,
        _context: &mut rig::tool::ToolContext,
        args: Self::Args,
    ) -> Result<Self::Output, Self::Error> {
        if args.query.trim().is_empty() {
            return Err(tool_failure("Search query cannot be empty."));
        }
        let payload = serde_json::to_value(&args).map_err(|e| tool_error(e.into()))?;
        let mut results_file = None;
        let saved_file = &mut results_file;
        let result = execute_tool_job_with_id(
            &self.0,
            Self::NAME,
            payload,
            |cancellation, job_id| async move {
                let result = super::web_request::run(
                    &self.0.runtime,
                    cancellation.clone(),
                    web_request_args(&self.0, &job_id),
                    Self::NAME,
                )
                .await?;
                super::scrape_files::localize_json(
                    result,
                    "sprocket-developer-search-",
                    &cancellation,
                    saved_file,
                )
                .await
                .map_err(tool_error)
            },
        )
        .await?;
        if let Some(file) = results_file.as_mut() {
            file.disable_cleanup(true);
        }
        Ok(ToolOutput::json(result))
    }
}
