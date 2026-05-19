#![deny(clippy::all)]

use napi::Error;
use napi_derive::napi;
use sprocket_core::{
    FileEditOutput as CoreFileEditOutput, FileReadOutput as CoreFileReadOutput,
    FileWriteOutput as CoreFileWriteOutput, WorkspaceEntry as CoreWorkspaceEntry,
    WorkspaceInstruction as CoreWorkspaceInstruction, WorkspaceOverview as CoreWorkspaceOverview,
    build_workspace_overview, create_workspace_file, load_workspace_instructions,
    read_workspace_file, replace_workspace_file, resolve_workspace_root,
};
use sprocket_rig::{RunAgentRequest as RigRunAgentRequest, run_agent};

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
    pub file_count: u32,
    pub directory_count: u32,
    pub top_level_entries: Vec<WorkspaceEntry>,
    pub recent_files: Vec<String>,
}

#[napi(object)]
pub struct WorkspaceInstruction {
    pub path: String,
    pub directory: String,
    pub contents: String,
    pub truncated: bool,
}

#[napi(object)]
pub struct FileReadInput {
    pub workspace_root: String,
    pub path: String,
    pub start_line: Option<u32>,
    pub max_lines: Option<u32>,
}

#[napi(object)]
pub struct FileReadOutput {
    pub path: String,
    pub exists: bool,
    pub start_line: u32,
    pub end_line: u32,
    pub total_lines: u32,
    pub truncated: bool,
    pub contents: String,
    pub error: Option<String>,
}

#[napi(object)]
pub struct CreateFileInput {
    pub workspace_root: String,
    pub path: String,
    pub content: String,
}

#[napi(object)]
pub struct FileWriteOutput {
    pub path: String,
    pub bytes_written: u32,
}

#[napi(object)]
pub struct ReplaceInFileInput {
    pub workspace_root: String,
    pub path: String,
    pub old_text: String,
    pub new_text: String,
    pub replace_all: Option<bool>,
}

#[napi(object)]
pub struct FileEditOutput {
    pub path: String,
    pub replacements: u32,
    pub bytes_written: u32,
}

#[napi(object)]
pub struct RunAgentRequest {
    pub deployment_url: String,
    pub auth_token: Option<String>,
    pub guest_id: Option<String>,
    pub run_id: String,
    pub workspace_path: String,
}

#[napi(js_name = "getWorkspaceOverview")]
pub fn get_workspace_overview(workspace_root: String) -> napi::Result<WorkspaceOverview> {
    let workspace_root = resolve_workspace_root(&workspace_root).map_err(map_error)?;
    build_workspace_overview(&workspace_root)
        .map(Into::into)
        .map_err(map_error)
}

#[napi(js_name = "getWorkspaceInstructions")]
pub fn get_workspace_instructions(
    workspace_root: String,
) -> napi::Result<Vec<WorkspaceInstruction>> {
    let workspace_root = resolve_workspace_root(&workspace_root).map_err(map_error)?;
    load_workspace_instructions(&workspace_root)
        .map(|instructions| instructions.into_iter().map(Into::into).collect())
        .map_err(map_error)
}

#[napi(js_name = "readFile")]
pub async fn read_file(input: FileReadInput) -> napi::Result<FileReadOutput> {
    let workspace_root = resolve_workspace_root(&input.workspace_root).map_err(map_error)?;
    read_workspace_file(
        workspace_root,
        &input.path,
        input.start_line.map(|value| value as usize),
        input.max_lines.map(|value| value as usize),
    )
    .await
    .map(Into::into)
    .map_err(map_error)
}

#[napi(js_name = "createFile")]
pub async fn create_file(input: CreateFileInput) -> napi::Result<FileWriteOutput> {
    let workspace_root = resolve_workspace_root(&input.workspace_root).map_err(map_error)?;
    create_workspace_file(workspace_root, &input.path, &input.content)
        .await
        .map(Into::into)
        .map_err(map_error)
}

#[napi(js_name = "replaceInFile")]
pub async fn replace_in_file(input: ReplaceInFileInput) -> napi::Result<FileEditOutput> {
    let workspace_root = resolve_workspace_root(&input.workspace_root).map_err(map_error)?;
    replace_workspace_file(
        workspace_root,
        &input.path,
        &input.old_text,
        &input.new_text,
        input.replace_all.unwrap_or(false),
    )
    .await
    .map(Into::into)
    .map_err(map_error)
}

#[napi(js_name = "runAgent")]
pub async fn run_agent_binding(input: RunAgentRequest) -> napi::Result<()> {
    run_agent(RigRunAgentRequest {
        deployment_url: input.deployment_url,
        auth_token: input.auth_token,
        guest_id: input.guest_id,
        run_id: input.run_id,
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

impl From<CoreWorkspaceInstruction> for WorkspaceInstruction {
    fn from(value: CoreWorkspaceInstruction) -> Self {
        Self {
            path: value.path,
            directory: value.directory,
            contents: value.contents,
            truncated: value.truncated,
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
            file_count: value.file_count.try_into().unwrap_or(u32::MAX),
            directory_count: value.directory_count.try_into().unwrap_or(u32::MAX),
            top_level_entries: value
                .top_level_entries
                .into_iter()
                .map(Into::into)
                .collect(),
            recent_files: value.recent_files,
        }
    }
}

impl From<CoreFileReadOutput> for FileReadOutput {
    fn from(value: CoreFileReadOutput) -> Self {
        Self {
            path: value.path,
            exists: value.exists,
            start_line: value.start_line.try_into().unwrap_or(u32::MAX),
            end_line: value.end_line.try_into().unwrap_or(u32::MAX),
            total_lines: value.total_lines.try_into().unwrap_or(u32::MAX),
            truncated: value.truncated,
            contents: value.contents,
            error: value.error,
        }
    }
}

impl From<CoreFileWriteOutput> for FileWriteOutput {
    fn from(value: CoreFileWriteOutput) -> Self {
        Self {
            path: value.path,
            bytes_written: value.bytes_written.try_into().unwrap_or(u32::MAX),
        }
    }
}

impl From<CoreFileEditOutput> for FileEditOutput {
    fn from(value: CoreFileEditOutput) -> Self {
        Self {
            path: value.path,
            replacements: value.replacements.try_into().unwrap_or(u32::MAX),
            bytes_written: value.bytes_written.try_into().unwrap_or(u32::MAX),
        }
    }
}

fn map_error(error: anyhow::Error) -> Error {
    Error::from_reason(error.to_string())
}
