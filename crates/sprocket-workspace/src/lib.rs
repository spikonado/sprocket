mod agents;
mod apply_patch_format;
mod artifacts;
mod browse;
mod builtin_skills;
mod commands;
mod git_repository;
mod patch;
mod paths;
mod project_root;
mod skill_name;
mod skills;
#[cfg(test)]
mod test_support;
mod text;
mod unified_diff;
mod workspace;

pub const SPROCKET_VERSION: &str = match option_env!("SPROCKET_VERSION") {
    Some(version) => version,
    None => env!("CARGO_PKG_VERSION"),
};

pub use agents::{WorkspaceInstruction, WorkspaceInstructionSource, load_workspace_instructions};
pub use artifacts::{ArtifactContentType, ArtifactFile, MAX_ARTIFACT_BYTES, read_artifact_file};
pub use browse::{
    FilesystemBrowseEntry, FilesystemBrowseResult, browse_filesystem,
    resolve_or_create_workspace_root,
};
pub use builtin_skills::BUILTIN_SKILLS;
pub use commands::{
    CommandExecOutput, CommandSessionManager, WorkspaceCancellation, WorkspaceOperationCancelled,
    default_command_shell,
};
pub use git_repository::{GitRepositoryIdentity, resolve_git_repository_identity};
pub use patch::{ApplyPatchOutput, PatchChangeOutput, PatchOperation, apply_workspace_patch};
pub use paths::home_dir;
pub use skills::{
    SkillSource, WorkspaceSkill, WorkspaceSkills, default_user_skills_dirs, load_workspace_skills,
    read_skill_content,
};
pub use workspace::resolve_workspace_root;
