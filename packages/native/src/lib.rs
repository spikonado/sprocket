#![deny(clippy::all)]

use napi::Error;
use napi_derive::napi;
use sprocket_agent::{RunAgentRequest as AgentRunAgentRequest, run_agent};
use sprocket_workspace::{
    WorkspaceEntry as CoreWorkspaceEntry, WorkspaceOverview as CoreWorkspaceOverview,
    build_workspace_overview, resolve_workspace_root,
};

#[napi(object)]
pub struct WorkspaceEntry {
    pub name: String,
    pub kind: String,
}

#[napi(object)]
pub struct WorkspaceOverview {
    pub root_path: String,
    pub name: String,
    pub git_branch: Option<String>,
    pub git_dirty: bool,
}

#[napi(object)]
pub struct RunAgentRequest {
    pub deployment_url: String,
    pub auth_token: Option<String>,
    pub guest_id: Option<String>,
    pub thread_id: String,
    pub prompt: String,
    pub selected_model: String,
    pub reasoning_effort: String,
    pub workspace_path: String,
}

#[napi(js_name = "getWorkspaceOverview")]
pub fn get_workspace_overview(workspace_root: String) -> napi::Result<WorkspaceOverview> {
    let workspace_root = resolve_workspace_root(&workspace_root).map_err(map_error)?;
    build_workspace_overview(&workspace_root)
        .map(Into::into)
        .map_err(map_error)
}

#[napi(js_name = "runAgent")]
pub async fn run_agent_binding(input: RunAgentRequest) -> napi::Result<()> {
    run_agent(AgentRunAgentRequest {
        deployment_url: input.deployment_url,
        auth_token: input.auth_token,
        guest_id: input.guest_id,
        thread_id: input.thread_id,
        prompt: input.prompt,
        selected_model: input.selected_model,
        reasoning_effort: input.reasoning_effort,
        workspace_path: input.workspace_path,
    })
    .await
    .map_err(map_error)
}

impl From<CoreWorkspaceEntry> for WorkspaceEntry {
    fn from(value: CoreWorkspaceEntry) -> Self {
        Self {
            name: value.name,
            kind: value.kind,
        }
    }
}

impl From<CoreWorkspaceOverview> for WorkspaceOverview {
    fn from(value: CoreWorkspaceOverview) -> Self {
        Self {
            root_path: value.root_path,
            name: value.name,
            git_branch: value.git_branch,
            git_dirty: value.git_dirty,
        }
    }
}

fn map_error(error: anyhow::Error) -> Error {
    Error::from_reason(error.to_string())
}
