use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

use crate::paths::home_dir;
use crate::project_root::find_project_root;

const MAX_INSTRUCTION_BYTES: usize = 32 * 1024;

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum WorkspaceInstructionSource {
    User,
    Workspace,
}

#[derive(Debug, Clone)]
pub struct WorkspaceInstruction {
    pub path: String,
    pub directory: String,
    pub contents: String,
    pub truncated: bool,
    pub source: WorkspaceInstructionSource,
}

pub fn load_workspace_instructions(cwd: &Path) -> Result<Vec<WorkspaceInstruction>> {
    load_workspace_instructions_from(cwd, home_dir().as_deref())
}

fn load_workspace_instructions_from(
    cwd: &Path,
    user_home: Option<&Path>,
) -> Result<Vec<WorkspaceInstruction>> {
    let canonical_cwd = cwd
        .canonicalize()
        .with_context(|| format!("failed to resolve {}", cwd.display()))?;
    let project_root = find_project_root(&canonical_cwd);
    let search_dirs = directories_from_root(&project_root, &canonical_cwd);
    let mut instructions = Vec::new();

    if let Some(user_home) = user_home {
        let user_agents_path = user_home.join(".agents/AGENTS.md");
        let mut remaining_user_bytes = MAX_INSTRUCTION_BYTES;
        load_instruction(
            &user_agents_path,
            user_agents_path.parent().unwrap_or(user_home),
            WorkspaceInstructionSource::User,
            &mut remaining_user_bytes,
            &mut instructions,
        )?;
    }

    let mut remaining_workspace_bytes = MAX_INSTRUCTION_BYTES;
    for directory in search_dirs {
        if remaining_workspace_bytes == 0 {
            break;
        }

        load_instruction(
            &directory.join("AGENTS.md"),
            &directory,
            WorkspaceInstructionSource::Workspace,
            &mut remaining_workspace_bytes,
            &mut instructions,
        )?;
    }

    Ok(instructions)
}

fn load_instruction(
    path: &Path,
    directory: &Path,
    source: WorkspaceInstructionSource,
    remaining_bytes: &mut usize,
    instructions: &mut Vec<WorkspaceInstruction>,
) -> Result<()> {
    if *remaining_bytes == 0 || !path.is_file() {
        return Ok(());
    }

    let mut data =
        std::fs::read(path).with_context(|| format!("failed to read {}", path.display()))?;
    let mut truncated = false;
    if data.len() > *remaining_bytes {
        data.truncate(*remaining_bytes);
        truncated = true;
    }

    let contents = String::from_utf8_lossy(&data).to_string();
    if contents.trim().is_empty() {
        return Ok(());
    }

    *remaining_bytes = remaining_bytes.saturating_sub(data.len());
    instructions.push(WorkspaceInstruction {
        path: path.to_string_lossy().to_string(),
        directory: directory.to_string_lossy().to_string(),
        contents,
        truncated,
        source,
    });
    Ok(())
}

fn directories_from_root(root: &Path, cwd: &Path) -> Vec<PathBuf> {
    let mut directories = Vec::new();
    let mut cursor = cwd.to_path_buf();

    loop {
        directories.push(cursor.clone());
        if cursor == root {
            break;
        }

        let Some(parent) = cursor.parent() else {
            break;
        };
        cursor = parent.to_path_buf();
    }

    directories.reverse();
    directories
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::{WorkspaceInstructionSource, load_workspace_instructions_from};

    fn temp_path(prefix: &str) -> std::path::PathBuf {
        crate::test_support::temp_workspace_labeled(prefix)
    }

    #[test]
    fn loads_instructions_from_project_root_to_cwd() {
        let root = temp_path("sprocket-instructions");
        let nested = root.join("packages/app");
        fs::create_dir_all(&nested).expect("nested dir should be created");
        gix::init(&root).expect("git repository should be created");
        fs::write(root.join("AGENTS.md"), "root instructions").expect("root instructions");
        fs::write(nested.join("AGENTS.md"), "nested instructions").expect("nested instructions");

        let instructions =
            load_workspace_instructions_from(&nested, None).expect("instructions should load");

        assert_eq!(instructions.len(), 2);
        assert_eq!(instructions[0].contents, "root instructions");
        assert_eq!(instructions[1].contents, "nested instructions");

        fs::remove_dir_all(root).expect("temp workspace should be removed");
    }

    #[test]
    fn loads_user_instructions_before_workspace_instructions() {
        let root = temp_path("sprocket-user-instructions");
        let user_home = temp_path("sprocket-user-home");
        fs::create_dir_all(user_home.join(".agents")).expect("user agents dir");
        gix::init(&root).expect("git repository should be created");
        fs::write(user_home.join(".agents/AGENTS.md"), "user instructions")
            .expect("user instructions");
        fs::write(root.join("AGENTS.md"), "workspace instructions")
            .expect("workspace instructions");

        let instructions = load_workspace_instructions_from(&root, Some(&user_home))
            .expect("instructions should load");

        assert_eq!(instructions.len(), 2);
        assert_eq!(instructions[0].source, WorkspaceInstructionSource::User);
        assert_eq!(instructions[0].contents, "user instructions");
        assert_eq!(
            instructions[1].source,
            WorkspaceInstructionSource::Workspace
        );
        assert_eq!(instructions[1].contents, "workspace instructions");

        fs::remove_dir_all(root).expect("temp workspace should be removed");
        fs::remove_dir_all(user_home).expect("temp user home should be removed");
    }

    #[test]
    fn user_instructions_do_not_consume_workspace_instruction_budget() {
        let root = temp_path("sprocket-user-instruction-budget");
        let user_home = temp_path("sprocket-user-budget-home");
        fs::create_dir_all(user_home.join(".agents")).expect("user agents dir");
        gix::init(&root).expect("git repository should be created");
        fs::write(
            user_home.join(".agents/AGENTS.md"),
            "u".repeat(super::MAX_INSTRUCTION_BYTES),
        )
        .expect("user instructions");
        fs::write(root.join("AGENTS.md"), "workspace instructions")
            .expect("workspace instructions");

        let instructions = load_workspace_instructions_from(&root, Some(&user_home))
            .expect("instructions should load");

        assert_eq!(instructions.len(), 2);
        assert_eq!(instructions[0].source, WorkspaceInstructionSource::User);
        assert_eq!(
            instructions[1].source,
            WorkspaceInstructionSource::Workspace
        );
        assert_eq!(instructions[1].contents, "workspace instructions");

        fs::remove_dir_all(root).expect("temp workspace should be removed");
        fs::remove_dir_all(user_home).expect("temp user home should be removed");
    }

    #[test]
    fn ignores_agents_override_files() {
        let root = temp_path("sprocket-instructions-override");
        fs::create_dir_all(&root).expect("root dir should be created");
        gix::init(&root).expect("git repository should be created");
        fs::write(root.join("AGENTS.md"), "workspace instructions")
            .expect("workspace instructions");
        fs::write(root.join("AGENTS.override.md"), "override").expect("override file");

        let instructions =
            load_workspace_instructions_from(&root, None).expect("instructions should load");

        assert_eq!(instructions.len(), 1);
        assert_eq!(instructions[0].contents, "workspace instructions");

        fs::remove_dir_all(root).expect("temp workspace should be removed");
    }

    #[test]
    fn only_reads_cwd_when_no_project_root_marker_exists() {
        let root = temp_path("sprocket-instructions-no-marker");
        let nested = root.join("packages/app");
        fs::create_dir_all(&nested).expect("nested dir should be created");
        fs::write(root.join("AGENTS.md"), "root instructions").expect("root instructions");
        fs::write(nested.join("AGENTS.md"), "nested instructions").expect("nested instructions");

        let instructions =
            load_workspace_instructions_from(&nested, None).expect("instructions should load");

        assert_eq!(instructions.len(), 1);
        assert_eq!(instructions[0].contents, "nested instructions");

        fs::remove_dir_all(root).expect("temp workspace should be removed");
    }
}
