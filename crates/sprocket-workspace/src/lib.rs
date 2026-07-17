mod agents;
mod apply_patch_format;
mod browse;
mod patch;
mod paths;
#[cfg(test)]
mod test_support;
mod text;
mod tools;
mod workspace;

pub use agents::{WorkspaceInstruction, load_workspace_instructions};
pub use browse::{
    FilesystemBrowseEntry, FilesystemBrowseResult, browse_filesystem,
    resolve_or_create_workspace_root,
};
pub use patch::{ApplyPatchOutput, PatchChangeOutput, PatchOperation, apply_workspace_patch};
pub use tools::{
    CommandExecOutput, CommandSessionManager, WorkspaceCancellation, WorkspaceOperationCancelled,
    default_command_shell,
};
pub use workspace::resolve_workspace_root;
