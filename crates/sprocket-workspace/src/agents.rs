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
mod tests;
